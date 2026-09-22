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
        assertEq(MarketClock.easternDay(thanksgiving), 20_783);
        assertFalse(open(thanksgiving), "computed by rule, no list needed");
    }

    /// Every NYSE full closure 2026–2028, checked against the published calendar.
    function test_nyseHolidaysByRule() public pure {
        uint16[29] memory ymd = [
            uint16(0x0101), 0x0113, 0x0210, 0x0403, 0x0519, 0x0613, 0x0703, 0x0907, 0x0B1A, 0x0C19, // 2026
            0x0101, 0x0112, 0x020F, 0x031A, 0x051F, 0x0612, 0x0705, 0x0906, 0x0B19, 0x0C18, // 2027
            0x0111, 0x0215, 0x040E, 0x051D, 0x0613, 0x0704, 0x0904, 0x0B17, 0x0C19 // 2028
        ];
        for (uint256 i; i < 29; ++i) {
            uint256 y = i < 10 ? 2026 : i < 20 ? 2027 : 2028;
            uint256 day = MarketClock.daysFromCivil(y, ymd[i] >> 8, ymd[i] & 0xff);
            assertTrue(MarketClock.isHoliday(day), "listed NYSE holiday not detected");
            assertFalse(MarketClock.isTradingDay(day));
        }
    }

    /// No false positives: across 2026–2028 the rules flag exactly the 29 published closures.
    function test_noExtraHolidays() public pure {
        uint256 start = MarketClock.daysFromCivil(2026, 1, 1);
        uint256 end = MarketClock.daysFromCivil(2029, 1, 1);
        uint256 n;
        for (uint256 day = start; day < end; ++day) {
            if (MarketClock.isHoliday(day)) ++n;
        }
        assertEq(n, 29);
    }

    function test_holidayEdgeRules() public pure {
        // New Year's Day on a Sunday moves to Monday 2023-01-02.
        assertTrue(MarketClock.isHoliday(MarketClock.daysFromCivil(2023, 1, 2)));
        // New Year's Day 2028 is a Saturday and is NOT observed on Friday 2027-12-31.
        assertTrue(MarketClock.isTradingDay(MarketClock.daysFromCivil(2027, 12, 31)));
        // Juneteenth only from 2022.
        assertTrue(MarketClock.isTradingDay(MarketClock.daysFromCivil(2021, 6, 18)));
        // Good Friday 2025 and 2030 (Easter Apr 20, Apr 21).
        assertTrue(MarketClock.isHoliday(MarketClock.daysFromCivil(2025, 4, 18)));
        assertTrue(MarketClock.isHoliday(MarketClock.daysFromCivil(2030, 4, 19)));
        // Ordinary days stay open.
        assertTrue(MarketClock.isTradingDay(MarketClock.daysFromCivil(2026, 9, 21)));
        assertTrue(MarketClock.isTradingDay(MarketClock.daysFromCivil(2026, 12, 28)));
    }

    function test_earlyCloses() public pure {
        assertTrue(open(1_795_802_340)); //  Fri 2026-11-27 12:59 EST (day after Thanksgiving)
        assertFalse(open(1_795_802_400)); // 13:00 EST
        assertTrue(open(1_798_135_140)); //  Thu 2026-12-24 12:59 EST
        assertFalse(open(1_798_135_140 + 60));
        assertTrue(open(1_751_561_940)); //  Thu 2025-07-03 12:59 EDT
        assertFalse(open(1_751_562_000)); // 13:00 EDT
        // A July 3rd that is itself the observed holiday (2026, a Friday) is a full closure.
        assertFalse(MarketClock.isTradingDay(MarketClock.daysFromCivil(2026, 7, 3)));
    }

    function test_extraClosureFlag() public pure {
        assertFalse(MarketClock.isOpen(1_789_999_200, OPEN, CLOSE, true));
    }
}
