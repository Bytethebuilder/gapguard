// § 02 — The problem, measured. Renders web/measured-data.js (generated from research/closed-market.json).
import { MEASURED as M } from "./measured-data.js";

const $ = (id) => document.getElementById(id);
const int = (n) => Math.round(n).toLocaleString("en-US");
const pct = (n, dp = 1) => n.toFixed(dp) + "%";
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

const usdB = (n) => "$" + (n / 1e9).toFixed(2) + "B";
const signed = (n, dp = 1) => (n > 0 ? "+" : "") + n.toFixed(dp) + "%";
const etDay = (label) => label.split(" ").slice(0, 2).join(" "); // "Fri 2026-09-11 16:00 ET" → "Fri 2026-09-11"
const REPO = "https://github.com/Bytethebuilder/gapguard/tree/main/research";

// window line
$("mWindow").textContent = `${day(M.window.from)} – ${day(M.window.to)} 2026 · ${M.window.days} days · blocks ${int(M.window.fromBlock)}–${int(M.window.toBlock)} · ${M.window.closedPeriods} closures, ${M.window.weekendHolidayPeriods} of them weekends`;

// headline numbers
{
  const W = M.worst, D = M.drift;
  const stats = [
    ["Dollar volume traded while NYSE was closed", `<span class="g hot">${pct(M.census.usdClosedPct)}</span>`,
      `${usdB(M.census.usdClosed)} of ${usdB(M.census.usd)} across ${int(M.census.swaps)} swaps. The market is closed ${pct(M.window.closedTimePct)} of the hours.`],
    ["Weekend drift · worst 1 in 10", `<span class="g hot">${pct(D.weekend.p90Pct)}</span>`,
      `Weeknights: ${pct(D.weeknight.p90Pct)}. Median ${pct(D.weekend.medianPct)} vs ${pct(D.weeknight.medianPct)}. Largest move of each main pool from its last open-market price.`],
    ["Fee paid, closed vs open", `<span class="g">${M.fees.closedPct.toFixed(2)}%</span><span class="m-vs">vs ${M.fees.openPct.toFixed(2)}% open</span>`,
      `Volume-weighted. ${int(M.pools.dynamicAll)} of ${int(M.pools.ever)} stock pools use a dynamic fee, yet closed-market swaps paid about what open-market swaps paid.`],
    [`Worst ${W.periodKind === "weeknight" ? "night" : "weekend"} · ${W.ticker}`, `<span class="g cool">${signed(W.maxDevPct)}</span>`,
      `$${W.worstUsd.toFixed(2)} on ${etDay(W.worstAt)} vs $${W.anchorUsd.toFixed(2)} at the last open-market swap (NYSE close $${W.nyseLastClose.toFixed(2)}). $${int(W.usdInPeriod)} traded in that pool that ${W.periodKind === "weeknight" ? "night" : "weekend"}.`],
  ];
  $("mStats").innerHTML = stats.map(([dt, dd, sub]) => `<div><dt>${dt}</dt><dd>${dd}<span class="m-sub">${sub}</span></dd></div>`).join("");
}

// reading column
$("mRead").innerHTML =
  `<p><b>Every pool, not one anecdote.</b> ${M.stocks} Robinhood stock tokens sit in ${int(M.pools.ever)} v4 pools. Every swap in the ${int(M.pools.censusActive)} active USDG- and ETH-quoted pools was counted. The memecoin pools that use a stock token as their quote were sampled (${pct(M.other.sampledPct)} of blocks): about ${(M.other.estSwaps / 1e6).toFixed(0)}M swaps, ${pct(M.other.estSwapsClosedPct)} of them while closed.</p>` +
  `<p><b>At the bell, pools track the stock.</b> In the half hour before the close, the main pools sit a median ${pct(M.vsNyse.preCloseMedianPct, 2)} from the NYSE price. While closed, a typical closure's widest gap from that close is ${pct(M.vsNyse.closedMedianPct)}; 1 in 10 goes past ${pct(M.vsNyse.closedP90Pct)}.</p>` +
  `<p><b>Stated plainly:</b> most closures are calm. The median move (${pct(M.drift.all.medianPct)}) is close to the real stock's own overnight gap (median ${pct(M.drift.nyseMedianGapPct)}). The risk is the tail, and it is heaviest on weekends.</p>`;

// method note
$("mNote").innerHTML =
  `Method: onchain logs from the public Robinhood Chain RPC. Market hours from the hook's own NYSE calendar, mapped to exact blocks. ` +
  `Main pool = each stock's busiest hookless USDG pool that tracks NYSE within 5% while open (${M.drift.stocks} stocks); prices only from swaps of $1,000 or more. ` +
  `Volume is raw onchain flow and includes bots. The window starts after the HIMS weekend, so it is not in these numbers. ` +
  `<a href="${REPO}" target="_blank" rel="noopener">Script, data and limits →</a>`;

// drift histogram: weeknight vs weekend closures on each stock's main USDG pool
{
  const svg = $("mChart");
  const W = 640, l = 44, r = 12, t = 24, b = 250;
  const buckets = M.drift.histWeeknight.map((x, i) => ({ label: x.label, n: x.n, w: M.drift.histWeekend[i].n }));
  const nNight = M.drift.weeknight.n, nWk = M.drift.weekend.n;
  const share = buckets.map((x) => ({ ...x, sn: (x.n / nNight) * 100, sw: (x.w / nWk) * 100 }));
  const yMax = Math.max(10, Math.ceil(Math.max(...share.flatMap((x) => [x.sn, x.sw])) / 10) * 10);
  const y = (v) => b - (v / yMax) * (b - t);
  const gw = (W - l - r) / share.length, bw = Math.min(34, gw * 0.34);
  let h = "";
  for (let v = 0; v <= yMax; v += yMax > 40 ? 20 : 10) {
    h += `<line class="grid" x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${l - 8}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
  }
  h += `<text class="tick" x="${l}" y="${t - 4}">% of closures</text>`;
  h += `<line class="ax" x1="${l}" x2="${W - r}" y1="${b}" y2="${b}"/>`;
  share.forEach((x, i) => {
    const cx = l + gw * i + gw / 2;
    h += `<g class="m-grp"><rect class="m-bar night" x="${cx - bw - 2}" y="${y(x.sn)}" width="${bw}" height="${b - y(x.sn)}"><title>Weeknights, ${x.label}: ${x.n} of ${nNight}</title></rect>` +
      `<rect class="m-bar we" x="${cx + 2}" y="${y(x.sw)}" width="${bw}" height="${b - y(x.sw)}"><title>Weekends, ${x.label}: ${x.w} of ${nWk}</title></rect></g>` +
      `<text class="tick" x="${cx}" y="${b + 20}" text-anchor="middle">${x.label}</text>`;
  });
  h += `<text class="tick" x="${l + (W - l - r) / 2}" y="${b + 42}" text-anchor="middle">largest move vs the pool's last open-market price</text>`;
  svg.innerHTML = h;
  svg.setAttribute("aria-label",
    `Share of closures by largest price move. Weeknights (${nNight}): median ${pct(M.drift.weeknight.medianPct, 2)}, 90th percentile ${pct(M.drift.weeknight.p90Pct, 2)}. ` +
    `Weekends and holidays (${nWk}): median ${pct(M.drift.weekend.medianPct, 2)}, 90th percentile ${pct(M.drift.weekend.p90Pct, 2)}.`);
  $("mLegend").innerHTML = `<span class="lg-b night">Weeknights · ${nNight}</span><span class="lg-b we">Weekends &amp; holidays · ${nWk}</span>`;
}
