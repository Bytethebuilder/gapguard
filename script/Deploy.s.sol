// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {GapguardHook} from "../src/GapguardHook.sol";
import {DemoToken} from "./DemoToken.sol";
import {DemoLiquidity} from "./DemoLiquidity.sol";

/// @notice Deploys GapguardHook plus a live demo pool: two fixed-supply demo tokens (no mint, no owner,
///         no real-world ticker), a dynamic-fee pool bound to the hook, full-range liquidity locked in
///         an add-only holder, and Uniswap's test swap router to drive demo swaps (no slippage
///         protection — it is for the demo, not for users).
///
/// Required env:
///   POOL_MANAGER        v4 PoolManager on the target chain
///   PROTOCOL_RECIPIENT  receives the author's share of the hook's skim, forever
///   OPERATOR_RECIPIENT  receives the remainder
///
///   forge script script/Deploy.s.sol --rpc-url $RPC --account <keystore> --broadcast
contract Deploy is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        IPoolManager pm = IPoolManager(vm.envAddress("POOL_MANAGER"));

        GapguardHook.Config memory c = GapguardHook.Config({
            baseFee: 3_000,
            closedSurcharge: 2_000,
            driftCoefficient: 20,
            maxDriftSurcharge: 45_000,
            maxClosedMoveTicks: 100,
            openMinute: 570, // 09:30 ET
            closeMinute: 960, // 16:00 ET
            skimBips: 1_500,
            protocolShareBips: 3_000,
            protocolRecipient: vm.envAddress("PROTOCOL_RECIPIENT"),
            operatorRecipient: vm.envAddress("OPERATOR_RECIPIENT")
        });
        // NYSE holidays and early closes are computed by rule inside the hook. This list is only for
        // unscheduled closures already announced at deploy time — none.
        uint32[] memory extraClosures = new uint32[](0);

        uint160 flags = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        (address predicted, bytes32 salt) = HookMiner.find(
            CREATE2_DEPLOYER, flags, type(GapguardHook).creationCode, abi.encode(pm, c, extraClosures)
        );

        require(CREATE2_DEPLOYER.code.length > 0, "no CREATE2 deployer on this chain");
        vm.startBroadcast();

        GapguardHook hook = new GapguardHook{salt: salt}(pm, c, extraClosures);
        require(address(hook) == predicted, "address mismatch");

        DemoToken stock = new DemoToken("Gapguard Demo Stock", "gSTOCK", 1_000_000e18);
        DemoToken usd = new DemoToken("Gapguard Demo Dollar", "gUSD", 1_000_000e18);

        DemoLiquidity lp = new DemoLiquidity(pm);
        require(stock.transfer(address(lp), 20_000e18), "transfer");
        require(usd.transfer(address(lp), 20_000e18), "transfer");
        PoolSwapTest swapRouter = new PoolSwapTest(pm);
        stock.approve(address(swapRouter), type(uint256).max);
        usd.approve(address(swapRouter), type(uint256).max);

        (Currency c0, Currency c1) = address(stock) < address(usd)
            ? (Currency.wrap(address(stock)), Currency.wrap(address(usd)))
            : (Currency.wrap(address(usd)), Currency.wrap(address(stock)));
        PoolKey memory key = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
        lp.add(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 10_000e18,
                salt: 0
            })
        );

        vm.stopBroadcast();

        console2.log("GapguardHook:   ", address(hook));
        console2.log("gSTOCK:         ", address(stock));
        console2.log("gUSD:           ", address(usd));
        console2.log("Locked LP:      ", address(lp));
        console2.log("Swap router:    ", address(swapRouter));
        console2.log("market open now:", hook.isMarketOpen());
    }

}
