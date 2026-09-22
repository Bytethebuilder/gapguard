// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {MarketClock} from "./MarketClock.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @title GapguardHook — market-hours-aware fees for tokenized equities
/// @notice A tokenized stock trades 24/7 onchain, but the issuer can only mint and redeem — and the
///         real price can only be discovered — while the underlying exchange is open. Outside those
///         hours a pool has no anchor: LPs carry the full overnight/weekend gap, and one-way flow can
///         push the wrapper far from its last real close with nothing to pull it back.
///
///         Gapguard prices that, entirely through the LP fee:
///         - Market open: `baseFee`, and a time-weighted "last close" anchor follows prices that
///           actually hold during market hours.
///         - Market closed: `baseFee + closedSurcharge`, plus — for a swap moving price away from the
///           anchor — `min(|tick − anchor| × driftCoefficient, maxDriftSurcharge)`. Flow toward the
///           anchor pays no drift surcharge.
///         - Market closed: one swap may move the price at most `maxClosedMoveTicks`. Repricing
///           further takes several swaps. Drift is priced at the midpoint of the largest allowed step
///           (`|drift| + maxClosedMoveTicks / 2`), so splitting a move into smaller swaps never makes
///           it cheaper.
///
///         Because everything is an LP fee, it accrues along the swap's path to the liquidity that
///         actually filled it — there is no lump-sum payout for just-in-time liquidity to capture.
///         The hook's revenue is `skimBips` of the surcharges, taken out of them (the LP fee is reduced
///         by the same amount), never on top and never from `baseFee`.
///
/// @dev Deliberate, permanent constraints — no owner, no admin, no pause, no proxy:
///        - every parameter, the unscheduled-closure list and the fee recipients are immutable
///        - NYSE holidays and early closes are computed by rule (MarketClock), so they never expire
///        - base + closed + drift surcharge is hard-capped at `MAX_TOTAL_FEE` (10%)
///        - the hook's share is hard-capped at `MAX_SKIM_BIPS` (20%) of the surcharges
///        - every callback is `onlyPoolManager` (see BaseHook); the pool must be dynamic-fee
///      The hook's share is charged on the swap's unspecified amount through the afterSwap delta and
///      booked as ERC-6909 claims on the PoolManager — no tokens move mid-swap, so a pool whose
///      input token the PoolManager doesn't hold yet can't revert. `collect` turns claims into tokens.
contract GapguardHook is BaseHook, IUnlockCallback {
    using LPFeeLibrary for uint24;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;
    using CurrencyLibrary for Currency;

    error NotDynamicFeePool();
    error FeeCapExceeded();
    error SkimCapExceeded();
    error InvalidShare();
    error InvalidSession();
    error ZeroRecipient();
    error NothingToDistribute();
    error NothingOwed();
    error ClosedMarketMoveTooLarge(int24 moved, uint24 limit);

    event AnchorUpdated(PoolId indexed poolId, int24 anchorTick);
    event ClosedMarketFee(PoolId indexed poolId, int24 drift, uint24 surcharge, uint256 toHook);
    event Distributed(Currency indexed currency, uint256 toProtocol, uint256 toOperator);
    event Withdrawn(Currency indexed currency, address indexed recipient, uint256 amount);
    event Collected(Currency indexed currency, uint256 amount);

    /// @notice Fees are in pips. 1_000_000 pips = 100%.
    uint24 public constant PIPS = 1_000_000;
    /// @notice Ceiling on base + closed + drift surcharge. 100_000 pips = 10%.
    uint24 public constant MAX_TOTAL_FEE = 100_000;
    uint16 public constant MAX_SKIM_BIPS = 2_000;
    uint16 public constant BIPS = 10_000;
    /// @notice Market-hours time a price must hold to fully become the anchor.
    uint256 public constant ANCHOR_WINDOW = 30 minutes;
    /// @dev Anchor fixed-point scale, so small time-weighted steps are never rounded away.
    int256 internal constant Q = 1 << 16;

    /// @dev Transient, closed market only (0 = open): hook share in pips << 32 | (pre-swap tick + 2^20).
    ///      The tick offset keeps the low word non-zero across the whole tick range.
    bytes32 internal constant CLOSED_TSLOT = keccak256("gapguard.closed.swap.transient");
    int256 internal constant TICK_OFFSET = 1 << 20;

    uint24 public immutable baseFee;
    uint24 public immutable closedSurcharge;
    /// @notice Pips of drift surcharge per tick (~1 bp) of final distance from the anchor.
    uint24 public immutable driftCoefficient;
    uint24 public immutable maxDriftSurcharge;
    /// @notice Largest tick move a single swap may make while the market is closed.
    uint24 public immutable maxClosedMoveTicks;
    /// @notice Session window in US Eastern minutes after midnight (NYSE regular: 570–960).
    uint16 public immutable openMinute;
    uint16 public immutable closeMinute;
    uint16 public immutable skimBips;
    uint16 public immutable protocolShareBips;
    address public immutable protocolRecipient;
    address public immutable operatorRecipient;

    /// @notice Unscheduled closures (Eastern day numbers) known at deployment. Regular NYSE holidays
    ///         are computed by MarketClock and do not need listing.
    mapping(uint256 => bool) public isExtraClosure;

    struct Anchor {
        int64 tickQ; // anchor tick × 2^16
        uint40 lastSwap; // the pool price has held since this time
    }

    mapping(PoolId => Anchor) public anchors;

    /// @notice Pull-based payouts, so one recipient that cannot receive never blocks the other.
    mapping(address => mapping(Currency => uint256)) public owed;
    mapping(Currency => uint256) public totalOwed;

    struct Config {
        uint24 baseFee;
        uint24 closedSurcharge;
        uint24 driftCoefficient;
        uint24 maxDriftSurcharge;
        uint24 maxClosedMoveTicks;
        uint16 openMinute;
        uint16 closeMinute;
        uint16 skimBips;
        uint16 protocolShareBips;
        address protocolRecipient;
        address operatorRecipient;
    }

    constructor(IPoolManager _poolManager, Config memory c, uint32[] memory extraClosures) BaseHook(_poolManager) {
        if (uint256(c.baseFee) + c.closedSurcharge + c.maxDriftSurcharge > MAX_TOTAL_FEE) revert FeeCapExceeded();
        if (c.skimBips > MAX_SKIM_BIPS) revert SkimCapExceeded();
        if (c.protocolShareBips > BIPS) revert InvalidShare();
        if (c.openMinute >= c.closeMinute || c.closeMinute > 1440) revert InvalidSession();
        if (c.maxClosedMoveTicks == 0) revert InvalidSession();
        if (c.protocolRecipient == address(0) || c.operatorRecipient == address(0)) revert ZeroRecipient();

        baseFee = c.baseFee;
        closedSurcharge = c.closedSurcharge;
        driftCoefficient = c.driftCoefficient;
        maxDriftSurcharge = c.maxDriftSurcharge;
        maxClosedMoveTicks = c.maxClosedMoveTicks;
        openMinute = c.openMinute;
        closeMinute = c.closeMinute;
        skimBips = c.skimBips;
        protocolShareBips = c.protocolShareBips;
        protocolRecipient = c.protocolRecipient;
        operatorRecipient = c.operatorRecipient;
        for (uint256 i; i < extraClosures.length; ++i) {
            isExtraClosure[extraClosures[i]] = true;
        }
    }

    /// @dev The PoolManager pays the hook's share in native ETH on ETH-paired pools.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ------------------------------------------------------------------
    // Hook callbacks
    // ------------------------------------------------------------------

    function _afterInitialize(address, PoolKey calldata key, uint160, int24 tick) internal override returns (bytes4) {
        if (!key.fee.isDynamicFee()) revert NotDynamicFeePool();
        anchors[key.toId()] = Anchor({tickQ: int64(tick) * int64(Q), lastSwap: uint40(block.timestamp)});
        return IHooks.afterInitialize.selector;
    }

    /// @dev Folds the price that has held since the last swap into the anchor, then sets the LP fee.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        (, int24 tickNow,,) = poolManager.getSlot0(id);

        Anchor memory a = anchors[id];
        int64 folded = _folded(a, tickNow);
        if (folded != a.tickQ) emit AnchorUpdated(id, _tickOf(folded));
        anchors[id] = Anchor({tickQ: folded, lastSwap: uint40(block.timestamp)});

        uint24 lpFee = baseFee;
        if (!isMarketOpen()) {
            uint24 surcharge = _closedSurcharge(tickNow - _tickOf(folded), params.zeroForOne);
            uint24 hookPips = uint24((uint256(surcharge) * skimBips) / BIPS);
            lpFee = baseFee + surcharge - hookPips;
            _tstore((uint256(hookPips) << 32) | uint256(int256(tickNow) + TICK_OFFSET));
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, lpFee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Closed market only: enforces the per-swap move limit and takes the hook's share of the
    ///      surcharge in the swap's unspecified currency.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        uint256 slot = _tload();
        if (slot == 0) return (IHooks.afterSwap.selector, int128(0));
        _tstore(0);

        PoolId id = key.toId();
        int24 preTick = int24(int256(uint256(uint32(slot))) - TICK_OFFSET);
        (, int24 postTick,,) = poolManager.getSlot0(id);
        int24 moved = postTick - preTick;
        if (_abs(moved) > maxClosedMoveTicks) revert ClosedMarketMoveTooLarge(moved, maxClosedMoveTicks);

        uint256 toHook = (_unspecifiedAmount(params, delta) * uint24(slot >> 32)) / PIPS;
        if (toHook == 0) return (IHooks.afterSwap.selector, int128(0));

        Currency c = (params.amountSpecified < 0) == params.zeroForOne ? key.currency1 : key.currency0;
        poolManager.mint(address(this), c.toId(), toHook);
        emit ClosedMarketFee(id, preTick - _tickOf(anchors[id].tickQ), uint24(slot >> 32), toHook);
        return (IHooks.afterSwap.selector, toHook.toInt128());
    }

    function _unspecifiedAmount(SwapParams calldata params, BalanceDelta delta) internal pure returns (uint256) {
        int128 amt = (params.amountSpecified < 0) == params.zeroForOne ? delta.amount1() : delta.amount0();
        return uint256(uint128(amt < 0 ? -amt : amt));
    }

    // ------------------------------------------------------------------
    // Fee distribution — claims → tokens, permissionless accounting, pull-based payout, fixed split
    // ------------------------------------------------------------------

    /// @notice Converts the hook's ERC-6909 claims on `currency` into tokens held by the hook.
    function collect(Currency currency) external returns (uint256 amount) {
        amount = poolManager.balanceOf(address(this), currency.toId());
        if (amount == 0) revert NothingToDistribute();
        poolManager.unlock(abi.encode(currency, amount));
        emit Collected(currency, amount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Currency currency, uint256 amount) = abi.decode(data, (Currency, uint256));
        poolManager.burn(address(this), currency.toId(), amount);
        poolManager.take(currency, address(this), amount);
        return "";
    }

    /// @notice Books the hook's unassigned balance of `currency` to the two recipients.
    function distribute(Currency currency) external returns (uint256 toProtocol, uint256 toOperator) {
        uint256 bal = currency.balanceOfSelf();
        if (bal <= totalOwed[currency]) revert NothingToDistribute();
        uint256 fresh = bal - totalOwed[currency];
        toProtocol = (fresh * protocolShareBips) / BIPS;
        toOperator = fresh - toProtocol;
        owed[protocolRecipient][currency] += toProtocol;
        owed[operatorRecipient][currency] += toOperator;
        totalOwed[currency] += fresh;
        emit Distributed(currency, toProtocol, toOperator);
    }

    /// @notice Pays `recipient` what it is owed in `currency`. Anyone may trigger it; funds only go to
    ///         the recipient.
    function withdraw(Currency currency, address recipient) external returns (uint256 amount) {
        amount = owed[recipient][currency];
        if (amount == 0) revert NothingOwed();
        owed[recipient][currency] = 0;
        totalOwed[currency] -= amount;
        currency.transfer(recipient, amount);
        emit Withdrawn(currency, recipient, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function isMarketOpen() public view returns (bool) {
        return _isOpenAt(block.timestamp);
    }

    /// @notice The anchor ("last close") a swap would be priced against right now.
    function anchorTick(PoolId id) public view returns (int24) {
        (, int24 tickNow,,) = poolManager.getSlot0(id);
        return _tickOf(_folded(anchors[id], tickNow));
    }

    /// @notice Total fee (LP fee + hook share) a swap in direction `zeroForOne` pays right now, in pips.
    ///         Independent of size: it depends only on the pre-swap state and direction. Approximate
    ///         only in that the hook's share is charged on the unspecified amount.
    function quoteFee(PoolId id, bool zeroForOne) external view returns (uint24 fee, uint24 surcharge) {
        if (isMarketOpen()) return (baseFee, 0);
        (, int24 tickNow,,) = poolManager.getSlot0(id);
        surcharge = _closedSurcharge(tickNow - _tickOf(_folded(anchors[id], tickNow)), zeroForOne);
        fee = baseFee + surcharge;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev `closedSurcharge`, plus drift for a swap that moves price away from the anchor (at zero
    ///      drift both directions are away). Drift is priced at the midpoint of the largest step a swap
    ///      may take, so one step at the limit and many small steps cost about the same, and small steps
    ///      never less.
    function _closedSurcharge(int24 drift, bool zeroForOne) internal view returns (uint24) {
        // zeroForOne lowers the tick.
        bool toward = (drift > 0 && zeroForOne) || (drift < 0 && !zeroForOne);
        if (toward) return closedSurcharge;
        uint256 p = (_abs(drift) + maxClosedMoveTicks / 2) * driftCoefficient;
        return closedSurcharge + (p >= maxDriftSurcharge ? maxDriftSurcharge : uint24(p));
    }

    /// @dev Moves the anchor toward `priceTick` (the price that has held since the last swap) by the
    ///      share of `ANCHOR_WINDOW` that price spent inside market hours. Fixed point, so frequent
    ///      small steps accumulate instead of rounding to zero.
    function _folded(Anchor memory a, int24 priceTick) internal view returns (int64) {
        if (a.lastSwap == 0) return a.tickQ;
        uint256 held = _openSecondsBetween(a.lastSwap, block.timestamp);
        int256 target = int256(priceTick) * Q;
        if (held >= ANCHOR_WINDOW) return int64(target);
        return int64(a.tickQ + ((target - a.tickQ) * int256(held)) / int256(ANCHOR_WINDOW));
    }

    /// @dev Market-hours seconds in [from, to), clipped day by day against each trading session and
    ///      capped at ANCHOR_WINDOW. Any span over 7 days contains a full session.
    function _openSecondsBetween(uint256 from, uint256 to) internal view returns (uint256 s) {
        if (to <= from) return 0;
        if (to - from > 7 days) return ANCHOR_WINDOW;
        uint256 lastDay = MarketClock.easternDay(to);
        for (uint256 day = MarketClock.easternDay(from); day <= lastDay; ++day) {
            if (!_isTradingDay(day)) continue;
            uint256 midnight = day * MarketClock.DAY + (MarketClock.isDst(day * MarketClock.DAY + 12 hours) ? 4 hours : 5 hours);
            uint256 open = midnight + uint256(openMinute) * 60;
            uint256 close = midnight + uint256(MarketClock.closeMinuteOn(day, closeMinute)) * 60;
            uint256 lo = from > open ? from : open;
            uint256 hi = to < close ? to : close;
            if (hi > lo) {
                s += hi - lo;
                if (s >= ANCHOR_WINDOW) return ANCHOR_WINDOW;
            }
        }
    }

    function _isOpenAt(uint256 ts) internal view returns (bool) {
        return MarketClock.isOpen(ts, openMinute, closeMinute, isExtraClosure[MarketClock.easternDay(ts)]);
    }

    function _isTradingDay(uint256 day) internal view returns (bool) {
        return MarketClock.isTradingDay(day) && !isExtraClosure[day];
    }

    /// @dev Rounds toward negative infinity, matching tick semantics.
    function _tickOf(int64 tickQ) internal pure returns (int24) {
        return int24(tickQ >> 16);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x >= 0 ? x : -x);
    }

    function _tstore(uint256 v) internal {
        bytes32 slot = CLOSED_TSLOT;
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    function _tload() internal view returns (uint256 v) {
        bytes32 slot = CLOSED_TSLOT;
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }
}
