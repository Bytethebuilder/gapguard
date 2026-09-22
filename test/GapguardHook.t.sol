// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

import {GapguardHook} from "../src/GapguardHook.sol";

contract GapguardHookTest is Test, Deployers {
    using StateLibrary for *;

    GapguardHook hook;
    PoolKey gKey;
    PoolId gId;

    address constant PROTOCOL = address(0xB17E);
    address constant OPERATOR = address(0x09E2);

    // Mon 2026-09-21 14:00 UTC (open) and Sat 2026-09-19 15:00 UTC (closed).
    uint256 constant MONDAY_OPEN = 1_789_999_200;
    uint256 constant SATURDAY = 1_789_830_000;
    uint256 constant THANKSGIVING = 1_795_705_200; // Thu 10:00 EST
    uint32 constant THANKSGIVING_DAY = 20_783;

    uint160 constant FLAGS =
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    function config() internal pure returns (GapguardHook.Config memory) {
        return GapguardHook.Config({
            baseFee: 3_000, //          0.30%
            closedSurcharge: 2_000, //  +0.20% on every closed-market swap
            driftCoefficient: 20, //    +0.002% per tick of drift...
            maxDriftSurcharge: 45_000, // ...capped at +4.5%
            openMinute: 570,
            closeMinute: 960,
            skimBips: 1_500,
            protocolShareBips: 3_000,
            protocolRecipient: PROTOCOL,
            operatorRecipient: OPERATOR
        });
    }

    function holidays() internal pure returns (uint32[] memory h) {
        h = new uint32[](1);
        h[0] = THANKSGIVING_DAY;
    }

    function mine(GapguardHook.Config memory c) internal view returns (address predicted, bytes32 salt) {
        bytes memory args = abi.encode(manager, c, holidays());
        (predicted, salt) = HookMiner.find(address(this), FLAGS, type(GapguardHook).creationCode, args);
    }

    function deployHook(GapguardHook.Config memory c) internal returns (GapguardHook) {
        (address predicted, bytes32 salt) = mine(c);
        GapguardHook h = new GapguardHook{salt: salt}(manager, c, holidays());
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
        modifyLiquidityRouter.modifyLiquidity(
            gKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(gKey.tickSpacing),
                tickUpper: TickMath.maxUsableTick(gKey.tickSpacing),
                liquidityDelta: 100e18,
                salt: bytes32(uint256(1))
            }),
            ""
        );
    }

    function tick() internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(gId);
    }

    // --- session behaviour ---------------------------------------------------

    function test_openMarketChargesBaseFeeAndSkimsNothing() public {
        assertTrue(hook.isMarketOpen());
        (uint24 fee, uint24 surcharge) = hook.quoteFee(gId, true);
        assertEq(fee, 3_000);
        assertEq(surcharge, 0);

        swap(gKey, true, -1e18, "");
        assertEq(currency0.balanceOf(address(hook)) + currency1.balanceOf(address(hook)), 0);
    }

    function test_closedMarketChargesSurchargeAndSkims() public {
        vm.warp(SATURDAY);
        assertFalse(hook.isMarketOpen());
        (uint24 fee, uint24 surcharge) = hook.quoteFee(gId, true);
        assertEq(surcharge, 2_000);
        assertEq(fee, 5_000);

        swap(gKey, true, -1e18, "");
        assertGt(currency0.balanceOf(address(hook)) + currency1.balanceOf(address(hook)), 0);
    }

    function test_holidayIsClosed() public {
        vm.warp(THANKSGIVING);
        assertFalse(hook.isMarketOpen());
        (, uint24 surcharge) = hook.quoteFee(gId, true);
        assertEq(surcharge, 2_000);
    }

    // --- drift ---------------------------------------------------------------

    function test_awayFromCloseCostsMoreThanTowardIt() public {
        vm.warp(SATURDAY);
        // oneForZero pushes the tick up, away from the Friday reference.
        for (uint256 i; i < 2; ++i) swap(gKey, false, -1e18, "");
        int24 drift = tick() - _refTick();
        assertGt(drift, 0);
        assertLt(uint24(drift) * 20, 45_000, "stay below the cap so the linear term is what's tested");

        (uint24 awayFee,) = hook.quoteFee(gId, false);
        (uint24 towardFee, uint24 towardSurcharge) = hook.quoteFee(gId, true);
        assertGt(awayFee, towardFee);
        assertEq(towardSurcharge, 2_000, "restoring flow pays only the flat closed surcharge");
        assertEq(awayFee, 3_000 + 2_000 + uint24(drift) * 20);
    }

    function test_driftSurchargeIsCapped() public {
        vm.warp(SATURDAY);
        for (uint256 i; i < 12; ++i) swap(gKey, false, -20e18, "");
        (uint24 fee, uint24 surcharge) = hook.quoteFee(gId, false);
        assertEq(surcharge, 2_000 + 45_000);
        assertEq(fee, 50_000);
    }

    function test_referenceTracksOpenMarketOnly() public {
        swap(gKey, false, -5e18, "");
        int24 fridayClose = tick();
        assertEq(_refTick(), fridayClose, "open-market swap refreshes the reference");

        vm.warp(SATURDAY);
        swap(gKey, false, -5e18, "");
        assertEq(_refTick(), fridayClose, "closed-market swap must not move the reference");
        assertGt(tick(), fridayClose);

        vm.warp(MONDAY_OPEN + 7 days);
        swap(gKey, true, -1e17, "");
        assertEq(_refTick(), tick(), "reopening re-anchors to the live price");
    }

    // --- fee rail ------------------------------------------------------------

    function test_distributeSplitsSkim() public {
        vm.warp(SATURDAY);
        swap(gKey, true, -5e18, "");
        Currency c = currency0.balanceOf(address(hook)) > 0 ? currency0 : currency1;
        uint256 bal = c.balanceOf(address(hook));
        hook.distribute(c);
        assertEq(c.balanceOf(PROTOCOL), (bal * 3_000) / 10_000);
        assertEq(c.balanceOf(PROTOCOL) + c.balanceOf(OPERATOR), bal);
    }

    // --- construction guards -------------------------------------------------

    function test_rejectsStaticFeePool() public {
        vm.expectRevert();
        initPool(currency0, currency1, IHooks(address(hook)), 3_000, SQRT_PRICE_1_1);
    }

    function test_rejectsFeeAboveCap() public {
        GapguardHook.Config memory c = config();
        c.maxDriftSurcharge = 96_000; // 3_000 + 2_000 + 96_000 > 100_000
        (, bytes32 salt) = mine(c);
        vm.expectRevert(GapguardHook.FeeCapExceeded.selector);
        new GapguardHook{salt: salt}(manager, c, holidays());
    }

    function test_rejectsBadSession() public {
        GapguardHook.Config memory c = config();
        c.openMinute = 960;
        c.closeMinute = 570;
        (, bytes32 salt) = mine(c);
        vm.expectRevert(GapguardHook.InvalidSession.selector);
        new GapguardHook{salt: salt}(manager, c, holidays());
    }

    function _refTick() internal view returns (int24 t) {
        (t,) = hook.lastClose(gId);
    }
}
