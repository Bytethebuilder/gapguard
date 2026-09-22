// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FixedPoint128} from "v4-core/src/libraries/FixedPoint128.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {GapguardHook} from "../src/GapguardHook.sol";

contract GapguardHookTest is Test, Deployers {
    using StateLibrary for *;
    using CurrencyLibrary for Currency;

    GapguardHook hook;
    PoolKey gKey;
    PoolId gId;

    address constant PROTOCOL = address(0xB17E);
    address constant OPERATOR = address(0x09E2);
    uint24 constant MAX_MOVE = 100;

    // Mon 2026-09-21 14:00 UTC = 10:00 EDT (open); the following Friday and Saturday.
    uint256 constant MONDAY_OPEN = 1_789_999_200;
    uint256 constant MONDAY_0800 = MONDAY_OPEN - 2 hours; // 08:00 EDT, before the open
    uint256 constant MONDAY_1700 = MONDAY_OPEN + 7 hours; // 17:00 EDT, after the close
    uint256 constant FRIDAY_1559_30 = 1_790_366_370; // Fri 2026-09-25 15:59:30 EDT
    uint256 constant FRIDAY_1700 = FRIDAY_1559_30 + 1 hours + 30; // Fri 17:00 EDT
    uint256 constant SATURDAY = 1_790_434_800; // Sat 2026-09-26 11:00 EDT
    uint256 constant THANKSGIVING = 1_795_705_200; // Thu 2026-11-26 10:00 EST
    uint256 constant EXTRA_CLOSURE_TS = 1_791_986_400; // Wed 2026-10-14 10:00 EDT
    uint32 constant EXTRA_CLOSURE_DAY = 20_740; // 2026-10-14

    uint160 constant FLAGS =
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    function config() internal pure returns (GapguardHook.Config memory) {
        return GapguardHook.Config({
            baseFee: 3_000, //          0.30%
            closedSurcharge: 2_000, //  +0.20% on every closed-market swap
            driftCoefficient: 20, //    +0.002% per tick of drift...
            maxDriftSurcharge: 45_000, // ...capped at +4.5%
            maxClosedMoveTicks: MAX_MOVE, // ~1% per swap while closed
            openMinute: 570,
            closeMinute: 960,
            skimBips: 1_500,
            protocolShareBips: 3_000,
            protocolRecipient: PROTOCOL,
            operatorRecipient: OPERATOR
        });
    }

    function extraClosures() internal pure returns (uint32[] memory h) {
        h = new uint32[](1);
        h[0] = EXTRA_CLOSURE_DAY;
    }

    function mine(GapguardHook.Config memory c) internal view returns (address predicted, bytes32 salt) {
        bytes memory args = abi.encode(manager, c, extraClosures());
        (predicted, salt) = HookMiner.find(address(this), FLAGS, type(GapguardHook).creationCode, args);
    }

    function deployHook(GapguardHook.Config memory c) internal returns (GapguardHook) {
        (address predicted, bytes32 salt) = mine(c);
        GapguardHook h = new GapguardHook{salt: salt}(manager, c, extraClosures());
        require(address(h) == predicted, "mined address mismatch");
        return h;
    }

    function setUp() public {
        vm.warp(MONDAY_OPEN);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        hook = deployHook(config());

        (gKey, gId) =
            initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);
        _addFullRange(gKey, 0);
    }

    function _addFullRange(PoolKey memory key, uint256 value) internal {
        modifyLiquidityRouter.modifyLiquidity{value: value}(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(key.tickSpacing),
                tickUpper: TickMath.maxUsableTick(key.tickSpacing),
                liquidityDelta: 100e18,
                salt: bytes32(uint256(1))
            }),
            ""
        );
    }

    function tick() internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(gId);
    }

    /// @dev The hook's share lives as ERC-6909 claims until someone calls collect().
    function hookClaims() internal view returns (uint256) {
        return manager.balanceOf(address(hook), currency0.toId()) + manager.balanceOf(address(hook), currency1.toId());
    }

    /// @dev LP fee income so far, per currency.
    function lpIncome() internal view returns (uint256 i0, uint256 i1) {
        (uint256 g0, uint256 g1) = manager.getFeeGrowthGlobals(gId);
        uint256 liq = manager.getLiquidity(gId);
        i0 = (g0 * liq) / FixedPoint128.Q128;
        i1 = (g1 * liq) / FixedPoint128.Q128;
    }

    /// @dev Moves the price by `ticks` (sign = direction) in exact-input steps of at most `step`
    ///      ticks, as a router must while the market is closed. Returns total input spent.
    function walk(int24 ticks, int24 step) internal returns (uint256 spent) {
        bool zeroForOne = ticks < 0;
        Currency inC = zeroForOne ? currency0 : currency1;
        int24 target = tick() + ticks;
        while (zeroForOne ? tick() > target : tick() < target) {
            int24 t = tick();
            int24 next = zeroForOne ? (t - step > target ? t - step : target) + 1 : (t + step < target ? t + step : target);
            uint256 b = inC.balanceOf(address(this));
            swapRouter.swap(
                gKey,
                SwapParams(zeroForOne, -1_000e18, TickMath.getSqrtPriceAtTick(next)),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
            spent += b - inC.balanceOf(address(this));
            require(tick() != t, "walk made no progress");
        }
    }

    // --- session behaviour ---------------------------------------------------

    function test_openMarketChargesBaseFeeAndTakesNothing() public {
        assertTrue(hook.isMarketOpen());
        (uint24 fee, uint24 surcharge) = hook.quoteFee(gId, true);
        assertEq(fee, 3_000);
        assertEq(surcharge, 0);

        swap(gKey, true, -5e18, ""); // no move limit while open
        assertEq(hookClaims(), 0);
    }

    function test_closedMarketChargesSurchargeAndSkims() public {
        vm.warp(SATURDAY);
        assertFalse(hook.isMarketOpen());
        (uint24 fee, uint24 surcharge) = hook.quoteFee(gId, true);
        // At zero drift both directions are "away": closed surcharge + midpoint drift (50 ticks × 20).
        assertEq(surcharge, 2_000 + 1_000);
        assertEq(fee, 6_000);

        swap(gKey, true, -1e17, "");
        assertGt(hookClaims(), 0);
    }

    function test_ruleBasedHolidayIsClosed() public {
        vm.warp(THANKSGIVING); // not in any list — computed by MarketClock
        assertFalse(hook.isMarketOpen());
    }

    function test_extraClosureIsClosed() public {
        vm.warp(EXTRA_CLOSURE_TS);
        assertFalse(hook.isMarketOpen());
        vm.warp(EXTRA_CLOSURE_TS + 1 days);
        assertTrue(hook.isMarketOpen());
    }

    // --- drift ------------------------------------------------------------------

    function test_awayCostsMoreThanTowardAndQuoteIsExact() public {
        vm.warp(SATURDAY);
        walk(300, 100);
        int24 drift = tick() - hook.anchorTick(gId);
        assertApproxEqAbs(drift, 300, 1);

        (uint24 awayFee,) = hook.quoteFee(gId, false);
        (uint24 towardFee, uint24 towardSurcharge) = hook.quoteFee(gId, true);
        assertEq(towardSurcharge, 2_000, "restoring flow pays only the flat closed surcharge");
        assertEq(awayFee, 3_000 + 2_000 + (uint24(uint256(int256(drift))) + MAX_MOVE / 2) * 20, "midpoint pricing");
        assertGt(awayFee, towardFee);

        // The quote is what a swap of any size is charged: the LP fee applied is quote − hook share.
        (uint256 i0Before, uint256 i1Before) = lpIncome();
        swap(gKey, false, -1e16, "");
        (uint256 i0After, uint256 i1After) = lpIncome();
        uint256 lpPips = awayFee - (uint256(awayFee - 3_000) * 1_500) / 10_000;
        assertApproxEqRel((i1After - i1Before), (1e16 * lpPips) / 1_000_000, 0.001e18);
        assertEq(i0After, i0Before);
    }

    function test_driftSurchargeIsCapped() public {
        vm.warp(SATURDAY);
        walk(2_400, 100);
        (uint24 fee, uint24 surcharge) = hook.quoteFee(gId, false);
        assertEq(surcharge, 2_000 + 45_000);
        assertEq(fee, 50_000);
    }

    /// Review 2, H-2 / H-3: a single swap can no longer reprice far while the market is closed.
    function test_closedSwapMovingPastTheLimitReverts() public {
        vm.warp(SATURDAY);
        vm.expectRevert();
        swap(gKey, false, -5e18, ""); // ~1000 ticks in one swap
        vm.expectRevert();
        swap(gKey, true, -5e18, "");
    }

    /// Splitting a move never makes it cheaper: drift is priced at the midpoint of a full step, so
    /// tiny steps pay at least as much as steps at the limit (and at most ~0.1% more).
    function test_splittingCannotDodgeDrift() public {
        vm.warp(SATURDAY);
        uint256 snap = vm.snapshotState();

        (uint256 f0,) = _lpIncome1Delta(400, 100);
        vm.revertToState(snap);
        (uint256 f1, uint256 spent) = _lpIncome1Delta(400, 5);

        assertGt(f1, f0, "finer steps pay more, never less");
        uint256 discountPips = ((f1 - f0) * 1_000_000) / spent;
        assertLe(discountPips, 1_100, "tiny steps overpay by at most ~0.1% of volume");
    }

    function _lpIncome1Delta(int24 ticks, int24 step) internal returns (uint256 fees, uint256 spent) {
        (, uint256 before) = lpIncome();
        spent = walk(ticks, step);
        (, uint256 afterI) = lpIncome();
        fees = afterI - before;
    }

    /// A "toward" swap can overshoot past the anchor by at most the move limit.
    function test_towardOvershootIsBoundedByTheMoveLimit() public {
        vm.warp(SATURDAY);
        walk(50, 50);
        vm.expectRevert();
        swap(gKey, true, -5e18, ""); // would cross and overshoot far below
    }

    // --- anchor ---------------------------------------------------------------

    function test_anchorFollowsPriceThatHeldThroughTheSession() public {
        swap(gKey, false, -5e18, "");
        int24 held = tick();
        assertEq(hook.anchorTick(gId), 0, "a brand-new price has no weight yet");

        vm.warp(block.timestamp + 15 minutes);
        assertApproxEqAbs(hook.anchorTick(gId), held / 2, 1, "half the window -> half the move");

        vm.warp(block.timestamp + 15 minutes);
        assertEq(hook.anchorTick(gId), held, "a full window of market hours -> full weight");
    }

    /// Review 1, H-2: frequent small swaps must not freeze the anchor through rounding.
    function test_dustSwapsDoNotFreezeTheAnchor() public {
        swap(gKey, false, -1e18, "");
        int24 target = tick();
        assertGt(target, 100);
        for (uint256 i; i < 1_200; ++i) {
            vm.warp(block.timestamp + 3);
            swap(gKey, i % 2 == 0, -1e9, "");
        }
        assertGt(int256(hook.anchorTick(gId)) * 10, int256(target) * 8, "an hour of 3 s dust swaps: >80% of the way");
    }

    function test_closedMarketPricesNeverMoveTheAnchor() public {
        vm.warp(SATURDAY);
        int24 anchor = hook.anchorTick(gId);
        walk(200, 100);
        vm.warp(SATURDAY + 20 hours);
        walk(200, 100);
        assertEq(hook.anchorTick(gId), anchor, "weekend prices carry no market-hours weight");
        assertGt(tick(), anchor);

        vm.warp(SATURDAY + 2 days); // Mon 11:00 EDT, 90 min into the session
        assertEq(hook.anchorTick(gId), tick(), "a price that holds into the open becomes the anchor");
    }

    /// Review 2, M-1: full sessions on the first and last day of a gap count.
    function test_fullSessionAtTheEndOfTheGapCounts() public {
        vm.warp(FRIDAY_1700);
        walk(100, 100); // after Friday's close
        vm.warp(FRIDAY_1700 + 3 days); // Mon 17:00 — Monday's whole session held this price
        assertEq(hook.anchorTick(gId), tick());
    }

    function test_fullSessionAtTheStartOfTheGapCounts() public {
        vm.warp(MONDAY_0800);
        walk(100, 100); // before Monday's open
        vm.warp(MONDAY_1700); // the whole session held this price
        assertEq(hook.anchorTick(gId), tick());
    }

    function test_dailyDustAfterTheCloseCannotFreezeTheAnchor() public {
        vm.warp(MONDAY_1700 - 30 minutes); // 16:30, closed
        walk(100, 100);
        int24 held = tick();
        for (uint256 d = 1; d <= 3; ++d) {
            vm.warp(MONDAY_1700 - 30 minutes + d * 1 days);
            swap(gKey, d % 2 == 0, -1e9, "");
        }
        assertApproxEqAbs(hook.anchorTick(gId), held, 1);
    }

    /// The attack the time weighting exists to stop: push the price 30 s before Friday's close,
    /// paying only base fee, so the whole weekend is priced against a fake "close".
    function test_lastSecondPushBarelyMovesTheAnchor() public {
        vm.warp(FRIDAY_1559_30);
        int24 before = hook.anchorTick(gId);
        swap(gKey, false, -20e18, "");
        int24 pushed = tick();

        vm.warp(SATURDAY);
        int256 moved = int256(hook.anchorTick(gId)) - before;
        int256 push = int256(pushed) - before;
        assertGt(push, 3_000);
        assertLe(moved * 60, push + 60, "30 s of a 30 min window: at most 1/60th of the push counts");

        (, uint24 surcharge) = hook.quoteFee(gId, false);
        assertEq(surcharge, 2_000 + 45_000, "on Saturday the pushed price is drift, not the close");
    }

    function test_anchorViewOnUnknownPoolDoesNotRevert() public view {
        hook.anchorTick(PoolId.wrap(bytes32(uint256(123))));
    }

    // --- swap modes -------------------------------------------------------------

    function test_exactOutputSwapsWhileClosedSkim() public {
        vm.warp(SATURDAY);
        swap(gKey, true, 1e17, "");
        swap(gKey, false, 1e17, "");
        assertGt(hookClaims(), 0);
    }

    /// Review 1, H-1: ETH-paired pools must work in every mode while the market is closed.
    function test_nativeEthPoolWorksInEveryModeWhileClosed() public {
        (PoolKey memory ethKey,) = initPool(
            CurrencyLibrary.ADDRESS_ZERO, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );
        vm.deal(address(this), 1_000 ether);
        _addFullRange(ethKey, 200 ether);
        vm.warp(SATURDAY);

        swapNativeInput(ethKey, true, -1e17, "", 1e17); // exact-in, ETH in
        swapNativeInput(ethKey, false, -1e17, "", 0); // exact-in, ETH out (hook share paid in ETH)
        swapNativeInput(ethKey, true, 1e17, "", 2e17); // exact-out, ETH in (hook share paid in ETH)
        swapNativeInput(ethKey, false, 1e17, "", 0); // exact-out, ETH out
        assertGt(manager.balanceOf(address(hook), CurrencyLibrary.ADDRESS_ZERO.toId()), 0);
        hook.collect(CurrencyLibrary.ADDRESS_ZERO);
        assertGt(address(hook).balance, 0);
    }

    /// Review 3, L-1: an exact-output swap into a pool whose input token the PoolManager doesn't hold
    /// (one-sided liquidity) must not revert while closed — the hook's share is a claim, not a take.
    function test_exactOutputIntoOneSidedPoolWhileClosed() public {
        (Currency a, Currency b) = deployMintAndApprove2Currencies();
        (PoolKey memory k,) = initPool(a, b, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: 60, tickUpper: 6_000, liquidityDelta: 1e18, salt: 0}), ""
        ); // above the price: only token0 deposited, the PoolManager holds no token1
        vm.warp(SATURDAY);
        swapRouter.swap(
            k,
            SwapParams(false, 1e14, TickMath.getSqrtPriceAtTick(90)), // exact-out token0, paying token1
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertGt(manager.balanceOf(address(hook), b.toId()), 0);
    }

    function test_hookRejectsStrayEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(hook).call{value: 1 wei}("");
        assertFalse(ok);
    }

    // --- fee rail -----------------------------------------------------------------

    function test_collectDistributeWithdraw() public {
        vm.warp(SATURDAY);
        swap(gKey, true, -1e17, "");
        Currency c = manager.balanceOf(address(hook), currency0.toId()) > 0 ? currency0 : currency1;

        vm.prank(address(0xA11CE)); // anyone may collect; tokens only go to the hook
        uint256 claimed = hook.collect(c);
        assertEq(hookClaims(), 0);
        uint256 bal = c.balanceOf(address(hook));
        assertEq(bal, claimed);

        hook.distribute(c);
        assertEq(hook.owed(PROTOCOL, c), (bal * 3_000) / 10_000);
        assertEq(hook.owed(PROTOCOL, c) + hook.owed(OPERATOR, c), bal);

        hook.withdraw(c, OPERATOR); // paid without the protocol side ever withdrawing
        assertEq(c.balanceOf(OPERATOR), bal - (bal * 3_000) / 10_000);
        vm.expectRevert(GapguardHook.NothingToDistribute.selector);
        hook.distribute(c);
        hook.withdraw(c, PROTOCOL);
        assertEq(c.balanceOf(address(hook)), 0);
    }

    // --- construction guards ------------------------------------------------------

    function test_rejectsStaticFeePool() public {
        vm.expectRevert();
        initPool(currency0, currency1, IHooks(address(hook)), 3_000, SQRT_PRICE_1_1);
    }

    function test_rejectsFeeAboveCap() public {
        GapguardHook.Config memory c = config();
        c.maxDriftSurcharge = 96_000; // 3_000 + 2_000 + 96_000 > 100_000
        (, bytes32 salt) = mine(c);
        vm.expectRevert(GapguardHook.FeeCapExceeded.selector);
        new GapguardHook{salt: salt}(manager, c, extraClosures());
    }

    function test_rejectsBadSession() public {
        GapguardHook.Config memory c = config();
        c.openMinute = 960;
        c.closeMinute = 570;
        (, bytes32 salt) = mine(c);
        vm.expectRevert(GapguardHook.InvalidSession.selector);
        new GapguardHook{salt: salt}(manager, c, extraClosures());
    }
}
