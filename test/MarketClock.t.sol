// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MarketClock} from "../src/MarketClock.sol";

/// Timestamps are independent ground truth, computed with Python's calendar.timegm.
contract MarketClockTest is Test {
    uint16 constant OPEN = 570; // 09:30 ET
    uint16 constant CLOSE = 960; // 16:00 ET

    function open(uint256 ts) internal pure returns (bool) {
        return MarketClock.isOpen(ts, OPEN, CLOSE, false);
    }

    function test_civilRoundTrip() public pure {
        assertEq(MarketClock.daysFromCivil(2026, 11, 26), 20_783);
        (uint256 y, uint256 m, uint256 d) = MarketClock.civilFromDays(20_783);
        assertEq(y, 2026);
        assertEq(m, 11);
        assertEq(d, 26);
    }

    function test_summerSession() public pure {
        assertFalse(open(1_789_997_340)); // Mon 2026-09-21 13:29 UTC = 09:29 EDT
        assertTrue(open(1_789_997_400)); //  Mon 2026-09-21 13:30 UTC = 09:30 EDT
        assertTrue(open(1_789_999_200)); //  Mon 2026-09-21 14:00 UTC
        assertFalse(open(1_790_020_800)); // Mon 2026-09-21 20:00 UTC = 16:00 EDT
    }

    function test_winterSession() public pure {
        assertFalse(open(1_768_228_140)); // Mon 2026-01-12 14:29 UTC = 09:29 EST
        assertTrue(open(1_768_228_200)); //  Mon 2026-01-12 14:30 UTC = 09:30 EST
    }

    function test_weekendClosed() public pure {
        assertFalse(open(1_789_830_000)); // Sat 2026-09-19 15:00 UTC
        assertFalse(open(1_788_026_400)); // Sat 2026-08-29 18:00 UTC — the HIMS squeeze weekend
    }

    function test_dstBoundaries() public pure {
        assertFalse(MarketClock.isDst(1_772_953_140)); // 2026-03-08 06:59 UTC
        assertTrue(MarketClock.isDst(1_772_953_200)); //  2026-03-08 07:00 UTC
        assertTrue(MarketClock.isDst(1_793_512_740)); //  2026-11-01 05:59 UTC
        assertFalse(MarketClock.isDst(1_793_512_800)); // 2026-11-01 06:00 UTC
    }

    function test_holidayClosed() public pure {
        uint256 thanksgiving = 1_795_705_200; // Thu 2026-11-26 15:00 UTC = 10:00 EST
        assertTrue(open(thanksgiving));
        assertEq(MarketClock.easternDay(thanksgiving), 20_783);
        assertFalse(MarketClock.isOpen(thanksgiving, OPEN, CLOSE, true));
    }
}
