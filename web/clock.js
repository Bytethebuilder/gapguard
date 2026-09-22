// JS port of src/MarketClock.sol: US Eastern time with DST, NYSE holidays and early closes by rule.
// Pure, dependency-free; shared by the page and clock.test.mjs. Times are unix seconds (UTC).

export const DAY = 86400;
export const OPEN_MINUTE = 570; // 09:30 ET
export const CLOSE_MINUTE = 960; // 16:00 ET

export function daysFromCivil(y, m, d) {
  if (m <= 2) y -= 1;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (dayNumber) => (dayNumber + 4) % 7;

function nthSunday(y, m, n) {
  const first = daysFromCivil(y, m, 1);
  return first + ((7 - weekday(first)) % 7) + (n - 1) * 7;
}

export function isDst(ts) {
  const [y] = civilFromDays(Math.floor(ts / DAY));
  const start = nthSunday(y, 3, 2) * DAY + 7 * 3600; // 2nd Sun Mar, 02:00 EST
  const end = nthSunday(y, 11, 1) * DAY + 6 * 3600; // 1st Sun Nov, 02:00 EDT
  return ts >= start && ts < end;
}

export const easternLocal = (ts) => ts - (isDst(ts) ? 4 : 5) * 3600;
export const easternDay = (ts) => Math.floor(easternLocal(ts) / DAY);

// NYSE holiday and early-close rules, ported 1:1 from src/MarketClock.sol — no list, never expires.
export const EARLY_CLOSE_MINUTE = 780; // 13:00 ET

/** Easter Sunday of year y as a day number (anonymous Gregorian algorithm). */
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31);
  const dd = ((h + l - 7 * mm + 114) % 31) + 1;
  return daysFromCivil(y, month, dd);
}

/** Weekday d observes a fixed-date holiday on `date` (Saturday → Friday, Sunday → Monday). */
const observed = (d, wd, date) => d === date || (d + 1 === date && wd === 5) || (d === date + 1 && wd === 1);

export function isHoliday(day) {
  const [y, m, d] = civilFromDays(day);
  const wd = weekday(day);
  if (wd === 0 || wd === 6) return false;
  if (m === 1) {
    // New Year's Day; a Sunday one moves to Monday, a Saturday one is not observed.
    if (d === 1 || (d === 2 && wd === 1)) return true;
    return wd === 1 && d >= 15 && d <= 21; // MLK Day: third Monday
  }
  if (m === 2) return wd === 1 && d >= 15 && d <= 21; // Washington's Birthday: third Monday
  if (day + 2 === easter(y)) return true; // Good Friday
  if (m === 5) return wd === 1 && d >= 25; // Memorial Day: last Monday
  if (m === 6) return y >= 2022 && observed(d, wd, 19); // Juneteenth
  if (m === 7) return observed(d, wd, 4); // Independence Day
  if (m === 9) return wd === 1 && d <= 7; // Labor Day: first Monday
  if (m === 11) return wd === 4 && d >= 22 && d <= 28; // Thanksgiving: fourth Thursday
  if (m === 12) return observed(d, wd, 25); // Christmas
  return false;
}

export function isEarlyClose(day) {
  const [, m, d] = civilFromDays(day);
  const wd = weekday(day);
  if (m === 7 && d === 3) return wd >= 1 && wd <= 4;
  if (m === 11) return wd === 5 && d >= 23 && d <= 29; // day after Thanksgiving
  if (m === 12 && d === 24) return wd >= 1 && wd <= 4;
  return false;
}

export function isTradingDay(day) {
  const wd = weekday(day);
  return wd !== 0 && wd !== 6 && !isHoliday(day);
}

export const closeMinuteOn = (day, closeMinute = CLOSE_MINUTE) =>
  isEarlyClose(day) && closeMinute > EARLY_CLOSE_MINUTE ? EARLY_CLOSE_MINUTE : closeMinute;

export function isOpen(ts) {
  const local = easternLocal(ts);
  const day = Math.floor(local / DAY);
  if (!isTradingDay(day)) return false;
  const minute = Math.floor((local % DAY) / 60);
  return minute >= OPEN_MINUTE && minute < closeMinuteOn(day);
}

/** Next unix second at which isOpen() flips. State only changes on minute boundaries. */
export function nextTransition(ts) {
  const now = isOpen(ts);
  let t = Math.floor(ts / 60) * 60 + 60;
  for (let i = 0; i < 60 * 24 * 16; i++, t += 60) {
    if (isOpen(t) !== now) return t;
  }
  return null;
}

/** Eastern wall-clock parts for display. */
export function easternParts(ts) {
  const local = easternLocal(ts);
  const day = Math.floor(local / DAY);
  const [y, m, d] = civilFromDays(day);
  const sec = ((local % DAY) + DAY) % DAY;
  return {
    y, m, d,
    wd: weekday(day),
    h: Math.floor(sec / 3600),
    min: Math.floor((sec % 3600) / 60),
    s: sec % 60,
    minuteOfDay: Math.floor(sec / 60),
    dst: isDst(ts),
    holiday: isHoliday(day),
    earlyClose: isEarlyClose(day),
  };
}
