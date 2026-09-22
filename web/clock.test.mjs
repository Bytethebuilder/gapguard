// node web/clock.test.mjs — checks the JS market clock (port of src/MarketClock.sol) against known instants
// and the published NYSE calendar.
import { isOpen, nextTransition, isHoliday, isEarlyClose, daysFromCivil, weekday, easter } from "./clock.js";

const at = (iso) => Date.parse(iso) / 1000;
const day = (iso) => daysFromCivil(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10));
let fail = 0, n = 0;
const check = (ok, msg) => { n++; if (!ok) fail++; if (!ok || process.env.VERBOSE) console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };

// --- instants ---------------------------------------------------------------------------------
const cases = [
  ["2026-09-21T13:29:00Z", false, "Mon 09:29 EDT, pre-open"],
  ["2026-09-21T13:30:00Z", true, "Mon 09:30 EDT, open"],
  ["2026-09-21T19:59:59Z", true, "Mon 15:59:59 EDT, last second"],
  ["2026-09-21T20:00:00Z", false, "Mon 16:00 EDT, closed"],
  ["2026-01-12T14:30:00Z", true, "Mon 09:30 EST, open"],
  ["2026-01-12T14:29:00Z", false, "Mon 09:29 EST, pre-open"],
  ["2026-09-19T15:00:00Z", false, "Saturday"],
  ["2026-11-26T15:00:00Z", false, "Thanksgiving"],
  ["2026-08-29T18:00:00Z", false, "HIMS weekend (replay SATURDAY)"],
  ["2026-03-09T13:30:00Z", true, "Mon after DST start, 09:30 EDT"],
  ["2026-11-02T14:30:00Z", true, "Mon after DST end, 09:30 EST"],
  ["2026-11-02T13:30:00Z", false, "Mon after DST end, 08:30 EST"],
  ["2023-01-02T15:00:00Z", false, "New Year 2023 (Sun) observed Mon Jan 2"],
  ["2027-12-31T15:00:00Z", true, "Fri 2027-12-31 open: Sat New Year 2028 not observed"],
  ["2030-04-19T15:00:00Z", false, "Good Friday 2030"],
  ["2026-11-27T17:59:00Z", true, "day after Thanksgiving 12:59 EST, open"],
  ["2026-11-27T18:00:00Z", false, "day after Thanksgiving 13:00 EST, early close"],
  ["2025-07-03T16:59:00Z", true, "Thu 2025-07-03 12:59 EDT, open"],
  ["2025-07-03T17:00:00Z", false, "Thu 2025-07-03 13:00 EDT, early close"],
  ["2026-12-24T17:59:00Z", true, "Thu Christmas Eve 2026 12:59 EST, open"],
  ["2026-12-24T18:00:00Z", false, "Thu Christmas Eve 2026 13:00 EST, early close"],
];
for (const [iso, want, why] of cases) check(isOpen(at(iso)) === want, `${iso} ${want ? "OPEN  " : "CLOSED"} ${why}`);

// --- published NYSE full-day closures 2026–2028 (29) -------------------------------------------
const PUBLISHED = [
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  // 2028 (New Year's Day falls on a Saturday: not observed)
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
];
check(PUBLISHED.length === 29, "29 published closures listed");
for (const d of PUBLISHED) check(isHoliday(day(d)), `holiday ${d}`);
const found = [];
for (let dn = day("2026-01-01"); dn <= day("2028-12-31"); dn++) if (isHoliday(dn)) found.push(dn);
const pub = new Set(PUBLISHED.map(day));
check(found.length === 29 && found.every((d) => pub.has(d)), `exactly 29 holidays computed across 2026–2028 (got ${found.length})`);
check(easter(2030) === day("2030-04-21"), "Easter 2030 = Apr 21");

// early closes 2026–2028: day after Thanksgiving + Mon–Thu Jul 3 / Dec 24
const EARLY = ["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"];
const early = [];
for (let dn = day("2026-01-01"); dn <= day("2028-12-31"); dn++) if (isEarlyClose(dn) && !isHoliday(dn) && weekday(dn) % 6) early.push(dn);
check(early.length === EARLY.length && EARLY.every((d) => early.includes(day(d))), `early closes 2026–2028 = ${EARLY.join(", ")}`);

// --- countdown targets -------------------------------------------------------------------------
const trans = [
  ["2026-09-19T15:00:00Z", "2026-09-21T13:30:00Z", "Sat → Mon open"],
  ["2026-09-21T13:30:00Z", "2026-09-21T20:00:00Z", "open → close"],
  ["2026-11-25T21:00:00Z", "2026-11-27T14:30:00Z", "skips Thanksgiving"],
  ["2026-11-27T15:00:00Z", "2026-11-27T18:00:00Z", "close countdown honours 13:00 early close"],
  ["2026-11-27T18:30:00Z", "2026-11-30T14:30:00Z", "after early close → Mon open"],
  ["2025-07-03T14:00:00Z", "2025-07-03T17:00:00Z", "2025-07-03 closes 13:00 EDT"],
  ["2025-07-03T17:00:00Z", "2025-07-07T13:30:00Z", "skips Jul 4 + weekend"],
  ["2027-12-30T21:00:00Z", "2027-12-31T14:30:00Z", "opens Fri 2027-12-31"],
];
for (const [from, want, why] of trans) {
  const got = new Date(nextTransition(at(from)) * 1000).toISOString().replace(".000", "");
  check(got === want, `next after ${from} = ${got} (${why})`);
}

console.log(fail ? `\n${fail} of ${n} checks failed` : `all ${n} checks passed`);
process.exit(fail ? 1 : 0);
