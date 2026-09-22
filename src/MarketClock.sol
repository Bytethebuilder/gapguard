// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MarketClock — US equity session calendar computed from block.timestamp
/// @notice Answers "is the underlying stock market open right now?" with no oracle and no keeper.
///         US Eastern time is derived on-chain, including the daylight-saving switch (second Sunday
///         of March 02:00 local → first Sunday of November 02:00 local). Holidays are supplied by the
///         caller as Eastern-local day numbers; weekends are handled here.
/// @dev Early closes (e.g. 13:00 on the day after Thanksgiving) are not modelled: those afternoons
///      read as open, so the hook charges base fee — the conservative direction for traders.
library MarketClock {
    uint256 internal constant DAY = 86_400;

    /// @notice Unix time shifted into US Eastern local time.
    function easternLocal(uint256 ts) internal pure returns (uint256) {
        return ts - (isDst(ts) ? 4 hours : 5 hours);
    }

    /// @notice Days since 1970-01-01 in Eastern local time. This is the key used for holidays.
    function easternDay(uint256 ts) internal pure returns (uint256) {
        return easternLocal(ts) / DAY;
    }

    /// @notice 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday.
    function weekday(uint256 dayNumber) internal pure returns (uint256) {
        return (dayNumber + 4) % 7;
    }

    /// @notice True between openMinute and closeMinute (Eastern, minutes after midnight) on a
    ///         weekday that is not a holiday. Holiday lookup is delegated so storage stays with the caller.
    function isOpen(uint256 ts, uint16 openMinute, uint16 closeMinute, bool holiday) internal pure returns (bool) {
        uint256 local = easternLocal(ts);
        uint256 wd = weekday(local / DAY);
        if (wd == 0 || wd == 6 || holiday) return false;
        uint256 minute = (local % DAY) / 60;
        return minute >= openMinute && minute < closeMinute;
    }

    /// @notice US daylight saving time, evaluated at UTC instant `ts`.
    function isDst(uint256 ts) internal pure returns (bool) {
        (uint256 y,,) = civilFromDays(ts / DAY);
        // Second Sunday of March, 02:00 EST = 07:00 UTC.
        uint256 start = (_nthSunday(y, 3, 2) * DAY) + 7 hours;
        // First Sunday of November, 02:00 EDT = 06:00 UTC.
        uint256 end = (_nthSunday(y, 11, 1) * DAY) + 6 hours;
        return ts >= start && ts < end;
    }

    function _nthSunday(uint256 y, uint256 m, uint256 n) private pure returns (uint256) {
        uint256 first = daysFromCivil(y, m, 1);
        uint256 toSunday = (7 - weekday(first)) % 7;
        return first + toSunday + (n - 1) * 7;
    }

    /// @notice Gregorian date → days since epoch (Howard Hinnant's algorithm), for years ≥ 1970.
    function daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = m > 2 ? m - 3 : m + 9;
        uint256 doy = (153 * mp + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    /// @notice Days since epoch → Gregorian date.
    function civilFromDays(uint256 z) internal pure returns (uint256 y, uint256 m, uint256 d) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    }
}
