// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {GapguardHook} from "../src/GapguardHook.sol";
import {MarketClock} from "../src/MarketClock.sol";

/// @notice Deploys GapguardHook plus a live demo pool: two mock tokens (a tokenized stock and a
///         dollar quote), test routers, a dynamic-fee pool bound to the hook, and full-range liquidity.
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
            openMinute: 570, // 09:30 ET
            closeMinute: 960, // 16:00 ET
            skimBips: 1_500,
            protocolShareBips: 3_000,
            protocolRecipient: vm.envAddress("PROTOCOL_RECIPIENT"),
            operatorRecipient: vm.envAddress("OPERATOR_RECIPIENT")
        });
        uint32[] memory holidays = nyseHolidays();

        uint160 flags = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        (address predicted, bytes32 salt) = HookMiner.find(
            CREATE2_DEPLOYER, flags, type(GapguardHook).creationCode, abi.encode(pm, c, holidays)
        );

        vm.startBroadcast();

        GapguardHook hook = new GapguardHook{salt: salt}(pm, c, holidays);
        require(address(hook) == predicted, "address mismatch");

        MockERC20 stock = new MockERC20("Gapguard Demo HIMS", "gHIMS", 18);
        MockERC20 usd = new MockERC20("Gapguard Demo USD", "gUSD", 18);
        stock.mint(msg.sender, 1_000_000e18);
        usd.mint(msg.sender, 1_000_000e18);

        PoolModifyLiquidityTest lpRouter = new PoolModifyLiquidityTest(pm);
        PoolSwapTest swapRouter = new PoolSwapTest(pm);
        stock.approve(address(lpRouter), type(uint256).max);
        usd.approve(address(lpRouter), type(uint256).max);
        stock.approve(address(swapRouter), type(uint256).max);
        usd.approve(address(swapRouter), type(uint256).max);

        (Currency c0, Currency c1) = address(stock) < address(usd)
            ? (Currency.wrap(address(stock)), Currency.wrap(address(usd)))
            : (Currency.wrap(address(usd)), Currency.wrap(address(stock)));
        PoolKey memory key = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 10_000e18,
                salt: 0
            }),
            ""
        );

        vm.stopBroadcast();

        console2.log("GapguardHook:   ", address(hook));
        console2.log("gHIMS:          ", address(stock));
        console2.log("gUSD:           ", address(usd));
        console2.log("LP router:      ", address(lpRouter));
        console2.log("Swap router:    ", address(swapRouter));
        console2.log("market open now:", hook.isMarketOpen());
    }

    /// @notice NYSE full-day closures for 2026–2027 as US-Eastern day numbers (days since 1970-01-01).
    ///         Weekends are handled by MarketClock. Source: NYSE holiday calendar.
    function nyseHolidays() internal pure returns (uint32[] memory h) {
        uint16[20] memory ymd = [
            // 2026: New Year, MLK, Presidents, Good Friday, Memorial, Juneteenth, Independence (obs.),
            //       Labor, Thanksgiving, Christmas
            uint16(0x0101), 0x0113, 0x0210, 0x0403, 0x0519, 0x0613, 0x0703, 0x0907, 0x0B1A, 0x0C19,
            // 2027: New Year, MLK, Presidents, Good Friday, Memorial, Juneteenth (obs.), Independence (obs.),
            //       Labor, Thanksgiving, Christmas (obs.)
            0x0101, 0x0112, 0x020F, 0x031A, 0x051F, 0x0612, 0x0705, 0x0906, 0x0B19, 0x0C18
        ];
        h = new uint32[](20);
        for (uint256 i; i < 20; ++i) {
            uint256 year = i < 10 ? 2026 : 2027;
            h[i] = uint32(MarketClock.daysFromCivil(year, ymd[i] >> 8, ymd[i] & 0xff));
        }
    }
}
