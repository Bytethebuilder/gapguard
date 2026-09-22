// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Test.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

import {HimsReplayTest} from "./HimsReplay.t.sol";

/// @notice Same scenario as HimsReplayTest, logged per buy for the demo page's replay chart.
///         Each line: step, premium over the last close in bps, all-in cost of that buy in pips.
///
///   forge test --mc ReplaySeries --mt test_series -vv
contract ReplaySeriesTest is HimsReplayTest {
    using StateLibrary for *;

    function test_series() public {
        vm.warp(SATURDAY);
        _series(staticKey, "static");
        _series(guardKey, "gapguard");
    }

    function _series(PoolKey memory key, string memory label) internal {
        for (uint256 i; i < BUYS; ++i) {
            Step memory st = _buy(key);
            uint256 allInPips = ((st.lpIncome + st.hookRevenue) * 1_000_000) / uint256(-BUY_SIZE);
            console2.log(string.concat("SERIES ", label), i + 1, st.premiumBps, allInPips);
        }
    }
}
