// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FixedPoint128} from "v4-core/src/libraries/FixedPoint128.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";

import {GapguardHook} from "../src/GapguardHook.sol";

/// @notice Reconstruction of the 29–31 Aug 2026 HIMS weekend float squeeze: one-way meme-driven buy
///         flow against a tokenized stock while its exchange was closed. The wrapper printed ~112%
///         over its $28.84 NYSE close before the issuer could mint again.
///
///         The same buy sequence is replayed through two identically-funded pools — a static 0.30%
///         pool and a Gapguard pool — and the outcomes are compared. This is a calibrated model, not a
///         replay of the actual on-chain transactions.
///
///   forge test --mc HimsReplay -vv
contract HimsReplayTest is Test, Deployers {
    using StateLibrary for *;
    using CurrencyLibrary for Currency;

    uint256 constant SATURDAY = 1_788_026_400; // Sat 2026-08-29 18:00 UTC
    uint256 constant BUYS = 30;
    int256 constant BUY_SIZE = -1.6e18; // exact-input quote token per buy
    int24 constant MAX_MOVE = 100;

    PoolKey staticKey;
    PoolKey guardKey;
    GapguardHook hook;

    function setUp() public {
        vm.warp(SATURDAY - 2 days); // deploy on a trading day
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        GapguardHook.Config memory c = GapguardHook.Config({
            baseFee: 3_000,
            closedSurcharge: 2_000,
            driftCoefficient: 20,
            maxDriftSurcharge: 45_000,
            maxClosedMoveTicks: 100,
            openMinute: 570,
            closeMinute: 960,
            skimBips: 1_500,
            protocolShareBips: 3_000,
            protocolRecipient: address(0xB17E),
            operatorRecipient: address(0x09E2)
        });
        uint32[] memory none = new uint32[](0);
        uint160 flags = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        (, bytes32 salt) =
            HookMiner.find(address(this), flags, type(GapguardHook).creationCode, abi.encode(manager, c, none));
        hook = new GapguardHook{salt: salt}(manager, c, none);

        (staticKey,) = initPool(currency0, currency1, IHooks(address(0)), 3_000, SQRT_PRICE_1_1);
        (guardKey,) = initPool(currency0, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);
        _fund(staticKey);
        _fund(guardKey);
    }

    function test_replay() public {
        vm.warp(SATURDAY);
        Result memory s = _run(staticKey);
        Result memory g = _run(guardKey);

        console2.log("");
        console2.log("  HIMS weekend replay: 30 one-way buys of 1.6 quote tokens, market closed");
        console2.log("  ---------------------------------------------------------------------------");
        console2.log("                               static 0.30%     Gapguard");
        console2.log("  premium over close, bps       ", s.premiumBps, g.premiumBps);
        console2.log("  LP income, milli-quote        ", s.lpIncome / 1e15, g.lpIncome / 1e15);
        console2.log("  hook revenue, milli-quote     ", s.hookRevenue / 1e15, g.hookRevenue / 1e15);
        console2.log("  all-in cost to buyers, pips   ", s.allInPips, g.allInPips);

        assertGt(g.lpIncome, s.lpIncome * 5, "Gapguard LPs earn several times more for the weekend gap");
        assertLe(g.premiumBps, s.premiumBps, "the same demand pushes the wrapper no further");
        assertGt(g.hookRevenue, 0, "the hook is paid out of the surcharges");
        assertEq(s.hookRevenue, 0);
    }

    struct Result {
        uint256 premiumBps;
        uint256 lpIncome; // quote-equivalent
        uint256 hookRevenue; // quote-equivalent
        uint256 allInPips; // (LP income + hook revenue) / notional
    }

    struct Step {
        uint256 premiumBps;
        uint256 lpIncome;
        uint256 hookRevenue;
    }

    /// @dev One buy, measured onchain: LP income from fee growth (LP fee in quote, drift donation in
    ///      stock) and the hook's balance change, stock amounts valued at the post-swap price.
    function _buy(PoolKey memory key) internal returns (Step memory st) {
        PoolId id = key.toId();
        (uint256 g0a, uint256 g1a) = manager.getFeeGrowthGlobals(id);
        uint256 h0 = manager.balanceOf(address(hook), currency0.toId());
        uint256 h1 = manager.balanceOf(address(hook), currency1.toId());

        _chunkedBuy(key, uint256(-BUY_SIZE));

        (uint256 g0b, uint256 g1b) = manager.getFeeGrowthGlobals(id);
        uint256 liq = manager.getLiquidity(id);
        (uint160 sqrtP,,,) = manager.getSlot0(id);
        uint256 priceX18 = (uint256(sqrtP) * uint256(sqrtP) * 1e18) >> 192;

        uint256 lp0 = ((g0b - g0a) * liq) / FixedPoint128.Q128;
        uint256 lp1 = ((g1b - g1a) * liq) / FixedPoint128.Q128;
        st.lpIncome = lp1 + (lp0 * priceX18) / 1e18;
        uint256 hk0 = manager.balanceOf(address(hook), currency0.toId()) - h0;
        uint256 hk1 = manager.balanceOf(address(hook), currency1.toId()) - h1;
        st.hookRevenue = hk1 + (hk0 * priceX18) / 1e18;
        st.premiumBps = (priceX18 - 1e18) / 1e14;
    }

    /// @dev Exact-input buy split into steps of at most MAX_MOVE ticks, as a router must route it while
    ///      the market is closed. Applied to both pools so the comparison is like for like.
    function _chunkedBuy(PoolKey memory key, uint256 amountIn) internal {
        uint256 left = amountIn;
        while (left > 0) {
            (, int24 t,,) = manager.getSlot0(key.toId());
            uint256 b = currency1.balanceOf(address(this));
            swapRouter.swap(
                key,
                SwapParams(false, -int256(left), TickMath.getSqrtPriceAtTick(t + MAX_MOVE)),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
            uint256 used = b - currency1.balanceOf(address(this));
            require(used > 0, "no progress");
            left -= used;
        }
    }

    function _run(PoolKey memory key) internal returns (Result memory r) {
        for (uint256 i; i < BUYS; ++i) {
            Step memory st = _buy(key);
            r.lpIncome += st.lpIncome;
            r.hookRevenue += st.hookRevenue;
            r.premiumBps = st.premiumBps;
        }
        r.allInPips = ((r.lpIncome + r.hookRevenue) * 1_000_000) / (uint256(-BUY_SIZE) * BUYS);
    }

    function _fund(PoolKey memory key) internal {
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(key.tickSpacing),
                tickUpper: TickMath.maxUsableTick(key.tickSpacing),
                liquidityDelta: 100e18,
                salt: 0
            }),
            ""
        );
    }
}
