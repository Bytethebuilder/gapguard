// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MarketClock — NYSE session calendar computed from block.timestamp
/// @notice Answers "is the US stock market open right now?" with no oracle, no keeper and no list to
///         maintain. US Eastern time is derived onchain, including the daylight-saving switch (second
///         Sunday of March 02:00 local → first Sunday of November 02:00 local), and NYSE's holiday and
///         early-close rules are evaluated as rules, so the calendar never runs out.
/// @dev Holidays (NYSE Rule 7.2): New Year's Day (not observed when it falls on a Saturday), Martin
///      Luther King Jr. Day, Washington's Birthday, Good Friday, Memorial Day, Juneteenth, Independence
///      Day, Labor Day, Thanksgiving, Christmas. Saturday holidays are observed the Friday before,
///      Sunday holidays the Monday after. Early 13:00 closes: July 3 (Mon–Thu), the day after
///      Thanksgiving, Christmas Eve (Mon–Thu). Unscheduled closures cannot be predicted by rule.
library MarketClock {
    uint256 internal constant DAY = 86_400;
    uint16 internal constant EARLY_CLOSE_MINUTE = 780; // 13:00 ET

    /// @notice Unix time shifted into US Eastern local time.
    function easternLocal(uint256 ts) internal pure returns (uint256) {
        return ts - (isDst(ts) ? 4 hours : 5 hours);
    }

    /// @notice Days since 1970-01-01 in Eastern local time.
    function easternDay(uint256 ts) internal pure returns (uint256) {
        return easternLocal(ts) / DAY;
    }

    /// @notice 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday.
    function weekday(uint256 dayNumber) internal pure returns (uint256) {
        return (dayNumber + 4) % 7;
    }

    /// @notice True between openMinute and the day's close (Eastern minutes after midnight) on a NYSE
    ///         trading day. `extraClosure` marks an unscheduled closure supplied by the caller.
    function isOpen(uint256 ts, uint16 openMinute, uint16 closeMinute, bool extraClosure) internal pure returns (bool) {
        uint256 local = easternLocal(ts);
        uint256 day = local / DAY;
        if (extraClosure || !isTradingDay(day)) return false;
        uint256 minute = (local % DAY) / 60;
        return minute >= openMinute && minute < closeMinuteOn(day, closeMinute);
    }

    /// @notice Weekday that is not a NYSE holiday.
    function isTradingDay(uint256 day) internal pure returns (bool) {
        uint256 wd = weekday(day);
        return wd != 0 && wd != 6 && !isHoliday(day);
    }

    /// @notice The session's close on `day`, honouring NYSE early closes.
    function closeMinuteOn(uint256 day, uint16 closeMinute) internal pure returns (uint16) {
        return isEarlyClose(day) && closeMinute > EARLY_CLOSE_MINUTE ? EARLY_CLOSE_MINUTE : closeMinute;
    }

    function isHoliday(uint256 day) internal pure returns (bool) {
        (uint256 y, uint256 m, uint256 d) = civilFromDays(day);
        uint256 wd = weekday(day);
        if (wd == 0 || wd == 6) return false;

        if (m == 1) {
            // New Year's Day; a Sunday one moves to Monday, a Saturday one is not observed.
            if (d == 1 || (d == 2 && wd == 1)) return true;
            return wd == 1 && d >= 15 && d <= 21; // MLK Day: third Monday
        }
        if (m == 2) return wd == 1 && d >= 15 && d <= 21; // Washington's Birthday: third Monday
        if (day + 2 == easter(y)) return true; // Good Friday
        if (m == 5) return wd == 1 && d >= 25; // Memorial Day: last Monday
        if (m == 6) return y >= 2022 && _observed(d, wd, 19); // Juneteenth
        if (m == 7) return _observed(d, wd, 4); // Independence Day
        if (m == 9) return wd == 1 && d <= 7; // Labor Day: first Monday
        if (m == 11) return wd == 4 && d >= 22 && d <= 28; // Thanksgiving: fourth Thursday
        if (m == 12) return _observed(d, wd, 25); // Christmas
        return false;
    }

    function isEarlyClose(uint256 day) internal pure returns (bool) {
        (, uint256 m, uint256 d) = civilFromDays(day);
        uint256 wd = weekday(day);
        if (m == 7 && d == 3) return wd >= 1 && wd <= 4;
        if (m == 11) return wd == 5 && d >= 23 && d <= 29; // day after Thanksgiving
        if (m == 12 && d == 24) return wd >= 1 && wd <= 4;
        return false;
    }

    /// @dev Weekday `d` observes a fixed-date holiday on `date` (Saturday → Friday, Sunday → Monday).
    function _observed(uint256 d, uint256 wd, uint256 date) private pure returns (bool) {
        return d == date || (d + 1 == date && wd == 5) || (d == date + 1 && wd == 1);
    }

    /// @notice Easter Sunday of year `y` as a day number (anonymous Gregorian algorithm).
    function easter(uint256 y) internal pure returns (uint256) {
        uint256 a = y % 19;
        uint256 b = y / 100;
        uint256 c = y % 100;
        uint256 h = (19 * a + b - b / 4 - (b - (b + 8) / 25 + 1) / 3 + 15) % 30;
        uint256 l = (32 + 2 * (b % 4) + 2 * (c / 4) - h - (c % 4)) % 7;
        uint256 mm = (a + 11 * h + 22 * l) / 451;
        uint256 month = (h + l - 7 * mm + 114) / 31;
        uint256 dd = ((h + l - 7 * mm + 114) % 31) + 1;
        return daysFromCivil(y, month, dd);
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
