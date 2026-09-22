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
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

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

    uint256 constant SATURDAY = 1_788_026_400; // Sat 2026-08-29 18:00 UTC
    uint256 constant BUYS = 30;
    int256 constant BUY_SIZE = -1.6e18; // exact-input quote token per buy

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
        console2.log("                          static 0.30%     Gapguard");
        console2.log("  premium over close, bps  ", s.premiumBps, g.premiumBps);
        console2.log("  LP fees, milli-quote     ", s.lpFees / 1e15, g.lpFees / 1e15);
        console2.log("  hook revenue, milli-stock", s.hookRevenue / 1e15, g.hookRevenue / 1e15);
        console2.log("  avg fee paid, pips       ", s.avgFeePips, g.avgFeePips);

        assertGt(g.lpFees, s.lpFees, "Gapguard LPs earn more for carrying the weekend gap");
        assertLt(g.premiumBps, s.premiumBps, "the same demand pushes the wrapper less far");
        assertGt(g.hookRevenue, 0, "the hook is paid out of the surcharge");
        assertEq(s.hookRevenue, 0);
    }

    struct Result {
        uint256 premiumBps;
        uint256 lpFees;
        uint256 hookRevenue;
        uint256 avgFeePips;
    }

    function _run(PoolKey memory key) internal returns (Result memory r) {
        PoolId id = key.toId();
        uint256 feeSum;
        uint256 hookBefore = currency0.balanceOf(address(hook));
        for (uint256 i; i < BUYS; ++i) {
            uint24 fee = address(key.hooks) == address(0) ? 3_000 : _quote(id);
            feeSum += fee;
            // The LP fee is taken from the input. The hook's skim is charged on top, out of the
            // swapper's output, so it never reduces what LPs earn.
            r.lpFees += (uint256(-BUY_SIZE) * fee) / 1_000_000;
            swap(key, false, BUY_SIZE, "");
        }
        // Exact-input quote → the skim is paid in the unspecified currency: the stock token.
        r.hookRevenue = currency0.balanceOf(address(hook)) - hookBefore;
        (uint160 sqrtP,,,) = manager.getSlot0(id);
        // price = (sqrtP / 2^96)^2; premium vs the 1.0 open price, in bps.
        uint256 priceX18 = (uint256(sqrtP) * uint256(sqrtP) * 1e18) >> 192;
        r.premiumBps = (priceX18 - 1e18) / 1e14;
        r.avgFeePips = feeSum / BUYS;
    }

    function _quote(PoolId id) internal view returns (uint24 fee) {
        (fee,) = hook.quoteFee(id, false);
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
