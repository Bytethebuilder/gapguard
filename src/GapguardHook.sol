// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {MarketClock} from "./MarketClock.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @title GapguardHook — market-hours-aware LP fee for tokenized equities
/// @notice A tokenized stock trades 24/7 onchain, but the issuer can only mint and redeem — and the
///         real price can only be discovered — while the underlying exchange is open. Outside those
///         hours a pool has no anchor: LPs carry the full overnight/weekend gap, and one-way flow can
///         push the wrapper far from its last real close with nothing to pull it back.
///
///         Gapguard prices that. While the market is open the pool charges `baseFee` and records the
///         pool tick as the reference "last close". While it is closed every swap pays a gap-risk
///         surcharge, and swaps that push price *further* from the last close pay a drift surcharge
///         that grows with the distance. Swaps that move price back toward the close pay no drift
///         surcharge, so the flow that restores the peg stays cheap.
///
///         The hook is paid only out of the surcharge it creates, never the base fee.
///
/// @dev Deliberate, permanent constraints — no owner, no admin, no pause, no proxy:
///        - every parameter, the holiday calendar and the fee recipients are fixed at construction
///        - total LP fee is hard-capped at `MAX_TOTAL_FEE` (10%)
///        - the hook's cut is hard-capped at `MAX_SKIM_BIPS` (20%) of the surcharge only
///        - every callback is `onlyPoolManager` (see BaseHook)
///        - the pool must be a dynamic-fee pool, enforced in `afterInitialize`
///      The drift surcharge is priced from the pre-swap price, so it escalates across a sequence of
///      same-direction swaps rather than inside a single one; `closedSurcharge` covers the first.
contract GapguardHook is BaseHook {
    using LPFeeLibrary for uint24;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;

    error NotDynamicFeePool();
    error FeeCapExceeded();
    error SkimCapExceeded();
    error InvalidShare();
    error InvalidSession();
    error ZeroRecipient();
    error NothingToDistribute();

    event FeeApplied(PoolId indexed poolId, bool marketOpen, uint24 appliedFee, uint24 surcharge, int24 drift);
    event ReferenceUpdated(PoolId indexed poolId, int24 refTick, uint40 refTime);
    event Skimmed(PoolId indexed poolId, Currency indexed currency, uint256 amount);
    event Distributed(Currency indexed currency, uint256 toProtocol, uint256 toOperator);

    /// @notice Fees are in pips. 1_000_000 pips = 100%.
    uint24 public constant PIPS = 1_000_000;
    /// @notice Ceiling on base + closed + drift surcharge. 100_000 pips = 10%.
    uint24 public constant MAX_TOTAL_FEE = 100_000;
    uint16 public constant MAX_SKIM_BIPS = 2_000;
    uint16 public constant BIPS = 10_000;

    bytes32 internal constant SURCHARGE_TSLOT = keccak256("gapguard.surcharge.transient");

    /// @notice LP fee while the market is open, in pips.
    uint24 public immutable baseFee;
    /// @notice Flat surcharge on every swap while the market is closed, in pips.
    uint24 public immutable closedSurcharge;
    /// @notice Pips of drift surcharge per tick (~1 bp) the pool sits away from the last close.
    uint24 public immutable driftCoefficient;
    /// @notice Cap on the drift surcharge, in pips.
    uint24 public immutable maxDriftSurcharge;
    /// @notice Session window in US Eastern minutes after midnight (NYSE regular: 570–960).
    uint16 public immutable openMinute;
    uint16 public immutable closeMinute;
    uint16 public immutable skimBips;
    uint16 public immutable protocolShareBips;
    address public immutable protocolRecipient;
    address public immutable operatorRecipient;

    /// @notice Eastern-local day numbers (days since 1970-01-01) on which the market is closed.
    mapping(uint256 => bool) public isHoliday;

    struct Reference {
        int24 tick; // pool tick at the last swap while the market was open
        uint40 time;
    }

    mapping(PoolId => Reference) public lastClose;

    struct Config {
        uint24 baseFee;
        uint24 closedSurcharge;
        uint24 driftCoefficient;
        uint24 maxDriftSurcharge;
        uint16 openMinute;
        uint16 closeMinute;
        uint16 skimBips;
        uint16 protocolShareBips;
        address protocolRecipient;
        address operatorRecipient;
    }

    constructor(IPoolManager _poolManager, Config memory c, uint32[] memory holidays) BaseHook(_poolManager) {
        if (uint256(c.baseFee) + c.closedSurcharge + c.maxDriftSurcharge > MAX_TOTAL_FEE) revert FeeCapExceeded();
        if (c.skimBips > MAX_SKIM_BIPS) revert SkimCapExceeded();
        if (c.protocolShareBips > BIPS) revert InvalidShare();
        if (c.openMinute >= c.closeMinute || c.closeMinute > 1440) revert InvalidSession();
        if (c.protocolRecipient == address(0) || c.operatorRecipient == address(0)) revert ZeroRecipient();

        baseFee = c.baseFee;
        closedSurcharge = c.closedSurcharge;
        driftCoefficient = c.driftCoefficient;
        maxDriftSurcharge = c.maxDriftSurcharge;
        openMinute = c.openMinute;
        closeMinute = c.closeMinute;
        skimBips = c.skimBips;
        protocolShareBips = c.protocolShareBips;
        protocolRecipient = c.protocolRecipient;
        operatorRecipient = c.operatorRecipient;
        for (uint256 i; i < holidays.length; ++i) {
            isHoliday[holidays[i]] = true;
        }
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
        _setReference(key.toId(), tick);
        return IHooks.afterInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        (bool open, uint24 surcharge, int24 drift) = _quote(id, params.zeroForOne);
        _setTransientSurcharge(surcharge);

        uint24 appliedFee = baseFee + surcharge;
        emit FeeApplied(id, open, appliedFee, surcharge, drift);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, appliedFee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Refreshes the reference while the market is open, then takes the hook's cut of the
    ///      surcharge in the swap's unspecified currency.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        if (isMarketOpen()) {
            (, int24 tickNow,,) = poolManager.getSlot0(id);
            _setReference(id, tickNow);
        }

        uint24 surcharge = _getTransientSurcharge();
        if (surcharge == 0 || skimBips == 0) return (IHooks.afterSwap.selector, int128(0));

        bool specifiedTokenIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        (Currency feeCurrency, int128 unspecifiedAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (unspecifiedAmount < 0) unspecifiedAmount = -unspecifiedAmount;

        uint256 skim = (uint256(uint128(unspecifiedAmount)) * surcharge) / PIPS;
        skim = (skim * skimBips) / BIPS;
        if (skim == 0) return (IHooks.afterSwap.selector, int128(0));

        poolManager.take(feeCurrency, address(this), skim);
        emit Skimmed(id, feeCurrency, skim);
        return (IHooks.afterSwap.selector, skim.toInt128());
    }

    // ------------------------------------------------------------------
    // Fee distribution — permissionless, non-custodial, fixed split
    // ------------------------------------------------------------------

    function distribute(Currency currency) external returns (uint256 toProtocol, uint256 toOperator) {
        uint256 bal = currency.balanceOfSelf();
        if (bal == 0) revert NothingToDistribute();
        toProtocol = (bal * protocolShareBips) / BIPS;
        toOperator = bal - toProtocol;
        if (toProtocol > 0) currency.transfer(protocolRecipient, toProtocol);
        if (toOperator > 0) currency.transfer(operatorRecipient, toOperator);
        emit Distributed(currency, toProtocol, toOperator);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function isMarketOpen() public view returns (bool) {
        return MarketClock.isOpen(
            block.timestamp, openMinute, closeMinute, isHoliday[MarketClock.easternDay(block.timestamp)]
        );
    }

    /// @notice The LP fee a swap in direction `zeroForOne` would pay on `id` right now, in pips.
    function quoteFee(PoolId id, bool zeroForOne) external view returns (uint24 appliedFee, uint24 surcharge) {
        (, surcharge,) = _quote(id, zeroForOne);
        appliedFee = baseFee + surcharge;
    }

    function _quote(PoolId id, bool zeroForOne) internal view returns (bool open, uint24 surcharge, int24 drift) {
        (, int24 tickNow,,) = poolManager.getSlot0(id);
        drift = tickNow - lastClose[id].tick;
        open = isMarketOpen();
        if (open) return (true, 0, drift);

        surcharge = closedSurcharge;
        // zeroForOne lowers the tick. A swap is "away" if it moves the tick further from the reference.
        bool away = (drift > 0 && !zeroForOne) || (drift < 0 && zeroForOne);
        if (away) {
            uint256 d = uint256(uint24(drift > 0 ? drift : -drift)) * driftCoefficient;
            surcharge += d >= maxDriftSurcharge ? maxDriftSurcharge : uint24(d);
        }
    }

    function _setReference(PoolId id, int24 tick) internal {
        lastClose[id] = Reference({tick: tick, time: uint40(block.timestamp)});
        emit ReferenceUpdated(id, tick, uint40(block.timestamp));
    }

    function _setTransientSurcharge(uint24 v) internal {
        bytes32 slot = SURCHARGE_TSLOT;
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    function _getTransientSurcharge() internal view returns (uint24 v) {
        bytes32 slot = SURCHARGE_TSLOT;
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }
}
