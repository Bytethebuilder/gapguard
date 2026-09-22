import { CONFIG, TESTNET, LINKS } from "./config.js";
import { isOpen, nextTransition, easternParts, easternDay, weekday, civilFromDays, isHoliday, isEarlyClose, OPEN_MINUTE, EARLY_CLOSE_MINUTE, DAY } from "./clock.js";
import { REPLAY, BUY_SIZE, TOTALS } from "./replay-data.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pad2 = (n) => String(n).padStart(2, "0");
const pct = (pips, dp = 2) => (pips / 1e4).toFixed(dp) + "%";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ------------------------------------------------------------------ network
const isTestnet = new URLSearchParams(location.search).get("net") === "testnet";
const NET = { ...(isTestnet ? TESTNET : CONFIG), name: isTestnet ? "Testnet" : "Mainnet" };
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const addrUrl = (a) => `${NET.explorer}/address/${a}`;
const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;

$("netBadge").textContent = `Robinhood Chain · ${NET.name}`;
$("netBadge").classList.toggle("testnet", isTestnet);

// ------------------------------------------------------------------ market clock
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let lastOpen = null;
let target = null;
let lastMinute = -1;

function fmtCountdown(sec) {
  const d = Math.floor(sec / DAY), h = Math.floor((sec % DAY) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const u = (v, k) => `${pad2(v)}<span class="u">${k}</span>`;
  return (d ? `${d}<span class="u">d</span>` : "") + u(h, "h") + u(m, "m") + u(s, "s");
}

function renderWeek(now) {
  const today = easternDay(now);
  const p = easternParts(now);
  const monday = today - ((weekday(today) + 6) % 7);
  let html = "";
  const labels = [];
  for (let i = 0; i < 7; i++) {
    const day = monday + i;
    const wd = weekday(day);
    const hol = isHoliday(day);
    const early = !hol && isEarlyClose(day) && wd !== 0 && wd !== 6;
    const off = wd === 0 || wd === 6 || hol;
    const past = day < today ? 100 : day === today ? (p.minuteOfDay / 1440) * 100 : 0;
    const [, , dd] = civilFromDays(day);
    const cls = ["wk", off ? "off" : "", hol ? "holiday" : "", day === today ? "today" : ""].join(" ");
    labels.push(`${DOW[wd]} ${dd}${hol ? " holiday" : off ? " closed" : early ? " 09:30 to 13:00 (early close)" : " 09:30 to 16:00"}`);
    const sessStyle = early ? ` style="width:${(((EARLY_CLOSE_MINUTE - OPEN_MINUTE) / 1440) * 100).toFixed(3)}%"` : "";
    html += `<div class="${cls}"><span>${DOW[wd]} ${pad2(dd)}</span><div class="wk-track"><div class="wk-sess"${sessStyle}></div>` +
      (past ? `<div class="wk-past" style="width:${past.toFixed(2)}%"></div>` : "") +
      (day === today ? `<div class="wk-now" style="left:calc(${past.toFixed(3)}% - 1px)"></div>` : "") +
      (hol ? `<span class="wk-tag">HOLIDAY</span>` : early ? `<span class="wk-tag">13:00 CLOSE</span>` : "") + `</div></div>`;
  }
  $("week").innerHTML = html;
  $("week").setAttribute("aria-label", "This week's NYSE sessions, Eastern time: " + labels.join("; "));
}

function tickClock() {
  const now = Math.floor(Date.now() / 1000);
  const open = isOpen(now);
  const p = easternParts(now);

  if (open !== lastOpen) {
    document.body.dataset.market = open ? "open" : "closed";
    const w = $("statusWord");
    w.textContent = open ? "OPEN" : "CLOSED";
    if (lastOpen !== null && !reduced) { w.classList.remove("flip"); void w.offsetWidth; w.classList.add("flip"); }
    lastOpen = open;
    target = null;
    document.title = `${open ? "OPEN" : "CLOSED"} · Gapguard — the hook that prices the closed market`;
  }
  if (target === null || now >= target) target = nextTransition(now);

  $("etTime").textContent = `${pad2(p.h)}:${pad2(p.min)}:${pad2(p.s)}`;
  $("etDate").textContent = `${DOW[p.wd]} ${p.d} ${MON[p.m - 1]} ${p.y} · ${p.dst ? "EDT" : "EST"}${p.holiday ? " · NYSE holiday" : p.earlyClose && isOpen(now) ? " · early close 13:00" : ""}`;
  $("countLabel").textContent = open ? "Closing bell in" : "Opening bell in";
  $("countVal").innerHTML = target ? fmtCountdown(target - now) : "beyond calendar";

  const minuteKey = Math.floor(now / 60);
  if (minuteKey !== lastMinute) { lastMinute = minuteKey; renderWeek(now); }
}
tickClock();
setTimeout(function loop() { tickClock(); setTimeout(loop, 1000 - (Date.now() % 1000) + 5); }, 1000 - (Date.now() % 1000));

// ------------------------------------------------------------------ fee model (Deploy.s.sol defaults)
// Closed market, all through the LP fee (dynamic override in beforeSwap):
//   surcharge = closed 0.20%, plus — for a swap moving price AWAY from the anchor (or any swap at zero
//   drift) — min((|pre-swap drift| + maxMove/2) × 0.002%, 4.5%). Drift is priced at the midpoint of a
//   full 100-tick step. The hook's 15% is taken out of the surcharge, never on top.
const P = { base: 3000, closed: 2000, coef: 20, maxDrift: 45000, skimBips: 1500, maxMove: 100 };
const driftFee = (ticks) => Math.min((ticks + P.maxMove / 2) * P.coef, P.maxDrift);
const CAP_TICKS = P.maxDrift / P.coef - P.maxMove / 2; // 2200
const awayFee = (ticks) => P.base + P.closed + driftFee(ticks);
const towardFee = () => P.base + P.closed;
const hookShare = (ticks) => ((P.closed + driftFee(ticks)) * P.skimBips) / 10000;
const driftPct = (ticks) => (Math.pow(1.0001, ticks) - 1) * 100;

function svgEl(svg, html) { svg.innerHTML = html; }
function setRangeFill(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty("--p", p + "%");
}

const SIM = { W: 640, H: 250, l: 50, r: 120, t: 18, b: 34, xMax: 3000, yMax: 55000 };
const sx = (t) => SIM.l + (t / SIM.xMax) * (SIM.W - SIM.l - SIM.r);
const sy = (f) => SIM.H - SIM.b - (f / SIM.yMax) * (SIM.H - SIM.t - SIM.b);

function drawSim(t) {
  let g = "";
  for (const f of [0, 10000, 20000, 30000, 40000, 50000]) {
    g += `<line class="grid" x1="${SIM.l}" x2="${SIM.W - SIM.r}" y1="${sy(f)}" y2="${sy(f)}"/>` +
      `<text class="tick" x="${SIM.l - 8}" y="${sy(f) + 4}" text-anchor="end">${f / 1e4}%</text>`;
  }
  for (const x of [0, 1000, 2000, 3000]) {
    g += `<text class="tick" x="${sx(x)}" y="${SIM.H - 12}" text-anchor="middle">${x ? "+" + driftPct(x).toFixed(1) + "%" : "0"}</text>`;
  }
  g += `<line class="ax" x1="${SIM.l}" x2="${SIM.W - SIM.r}" y1="${sy(0)}" y2="${sy(0)}"/>`;
  const R = SIM.W - SIM.r;
  g += `<path class="l-open" d="M${SIM.l},${sy(P.base)}H${R}"/>`;
  g += `<path class="l-toward" d="M${SIM.l},${sy(towardFee())}H${R}"/>`;
  g += `<path class="l-away" d="M${SIM.l},${sy(awayFee(0))}L${sx(CAP_TICKS)},${sy(awayFee(CAP_TICKS))}H${R}"/>`;
  g += `<text class="lbl a" x="${R + 8}" y="${sy(50000) + 4}">away from</text><text class="lbl a" x="${R + 8}" y="${sy(50000) + 19}">anchor 5.00%</text>`;
  g += `<text class="lbl t" x="${R + 8}" y="${sy(towardFee()) - 4}">toward 0.50%</text>`;
  g += `<text class="lbl o" x="${R + 8}" y="${sy(P.base) + 12}">open 0.30%</text>`;
  g += `<line class="cross" x1="${sx(t)}" x2="${sx(t)}" y1="${SIM.t}" y2="${sy(0)}"/>`;
  g += `<circle class="pt-a" cx="${sx(t)}" cy="${sy(awayFee(t))}" r="6"/>`;
  g += `<circle class="pt-g" style="fill:var(--tide)" cx="${sx(t)}" cy="${sy(towardFee())}" r="5"/>`;
  svgEl($("simChart"), g);
}

function updateSim() {
  const input = $("drift");
  const t = +input.value;
  setRangeFill(input);
  $("driftOut").textContent = "+" + driftPct(t).toFixed(1) + "%";
  $("driftTicks").textContent = t.toLocaleString("en-US");
  $("feeToward").textContent = pct(t === 0 ? awayFee(0) : towardFee());
  $("feeAway").textContent = pct(awayFee(t));
  const lp = awayFee(t) - hookShare(t);
  $("feeAwayN").textContent = (driftFee(t) >= P.maxDrift ? "drift at its +4.50% cap" : `0.50% + ${pct(driftFee(t), 3)} drift, priced at (distance + 50 ticks)`) +
    ` · LPs ${pct(lp, 3)}, hook ${pct(hookShare(t), 3)}`;
  $("feeTowardN").textContent = t === 0
    ? "at zero drift both directions are away, so both pay the 0.10% midpoint drift"
    : `restores the peg, no drift · LPs 0.470%, hook 0.030%`;
  drawSim(t);
}
$("drift").addEventListener("input", updateSim);
updateSim();

// ------------------------------------------------------------------ replay charts
const N = REPLAY.static.premiumBps.length;
const cum = (fees) => fees.reduce((a, f, i) => (a.push((a[i - 1] || 0) + (BUY_SIZE * f) / 1e6), a), []);
const CUM = { s: cum(REPLAY.static.allInPips), g: cum(REPLAY.gapguard.allInPips) };
const PREM = { s: REPLAY.static.premiumBps.map((b) => b / 100), g: REPLAY.gapguard.premiumBps.map((b) => b / 100) };

const C = { W: 560, H: 300, l: 44, r: 70, t: 14 };
const cx = (i) => C.l + (i / N) * (C.W - C.l - C.r);

function chart(svg, { yMax, yTicks, yFmt, s, g, bottom, endFmt, extra = "" }) {
  const y = (v) => bottom - (v / yMax) * (bottom - C.t);
  const pts = (arr) => [[0, 0], ...arr.map((v, i) => [i + 1, v])].map(([i, v]) => `${cx(i).toFixed(1)},${y(v).toFixed(1)}`);
  const id = svg.id;
  let h = `<defs><linearGradient id="gGuard-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9a23b" stop-opacity=".28"/><stop offset="1" stop-color="#e9a23b" stop-opacity="0"/></linearGradient>` +
    `<clipPath id="w-${id}"><rect class="wipe" x="${C.l}" y="0" width="${C.W - C.l - C.r + 8}" height="${C.H}"/></clipPath></defs>`;
  for (const v of yTicks) {
    h += `<line class="grid" x1="${C.l}" x2="${C.W - C.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${C.l - 8}" y="${y(v) + 4}" text-anchor="end">${yFmt(v)}</text>`;
  }
  h += `<line class="ax" x1="${C.l}" x2="${C.W - C.r}" y1="${bottom}" y2="${bottom}"/>`;
  h += extra;
  const gp = pts(g);
  h += `<g clip-path="url(#w-${id})"><path fill="url(#gGuard-${id})" d="M${gp.join("L")}L${cx(N)},${bottom}L${cx(0)},${bottom}Z"/>` +
    `<path class="l-static" d="M${pts(s).join("L")}"/><path class="l-guard" d="M${gp.join("L")}"/></g>`;
  const ys = y(s[N - 1]), yg = y(g[N - 1]);
  const [yS, yG] = Math.abs(ys - yg) < 16 ? (ys < yg ? [ys - 6, yg + 10] : [ys + 10, yg - 6]) : [ys + 4, yg + 4];
  h += `<g class="fade"><text class="lbl s" x="${cx(N) + 8}" y="${yS}">${endFmt(s[N - 1])}</text><text class="lbl g" x="${cx(N) + 8}" y="${yG}">${endFmt(g[N - 1])}</text></g>`;
  h += `<g class="cursor"><line class="cross" y1="${C.t}" y2="${bottom}"/><circle class="pt-s" r="4.5"/><circle class="pt-g" r="5.5"/></g>`;
  svg.innerHTML = h;
  return { y, s, g };
}

// premium chart
const premSvg = $("chartPremium");
const premAxisY = 262;
const prem = chart(premSvg, {
  yMax: 125, yTicks: [0, 25, 50, 75, 100, 125], yFmt: (v) => v + "%", s: PREM.s, g: PREM.g, bottom: premAxisY,
  endFmt: (v) => "+" + v.toFixed(1) + "%",
});
premSvg.insertAdjacentHTML("beforeend", xAxis(premAxisY));

// cost chart: cumulative all-in cost to buyers on top (LP income + hook revenue), per-buy all-in bars below
const feeSvg = $("chartFees");
const topBottom = 186, barTop = 204, barBottom = 262;
const BAR_MAX = 52000;
const G_ALL = REPLAY.gapguard.allInPips;
const gMax = Math.max(...G_ALL);
const barY = (pips) => barBottom - (pips / BAR_MAX) * (barBottom - barTop);
let bars = `<text class="tick" x="${C.l - 8}" y="${barY(50000) + 4}" text-anchor="end">5%</text><text class="tick" x="${C.l - 8}" y="${barBottom}" text-anchor="end">0</text>` +
  `<line class="ax" x1="${C.l}" x2="${C.W - C.r}" y1="${barBottom}" y2="${barBottom}"/><g class="fade">`;
const bw = (C.W - C.l - C.r) / N;
G_ALL.forEach((f, i) => {
  bars += `<rect class="bar-g${f >= 49500 ? " cap" : ""}" x="${(cx(i) + 1.5).toFixed(1)}" y="${barY(f).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${(barBottom - barY(f)).toFixed(1)}"/>`;
});
bars += `<line class="l-static" x1="${C.l}" x2="${C.W - C.r}" y1="${barY(2999)}" y2="${barY(2999)}"/>` +
  `<text class="lbl a" x="${C.W - C.r + 8}" y="${barY(gMax) + 8}">${pct(gMax)}</text><text class="lbl s" x="${C.W - C.r + 8}" y="${barY(2999) + 2}">0.30%</text></g>`;
const fees = chart(feeSvg, {
  yMax: 2.2, yTicks: [0, 0.5, 1, 1.5, 2], yFmt: (v) => v.toFixed(1), s: CUM.s, g: CUM.g, bottom: topBottom,
  endFmt: (v) => v.toFixed(3), extra: bars +
    `<text class="lbl g" x="${C.l + 10}" y="${C.t + 14}">Gapguard: ${TOTALS.lpIncome.gapguard.toFixed(3)} to LPs + ${TOTALS.hookRevenue.gapguard.toFixed(3)} to hook</text>` +
    `<text class="lbl s" x="${C.l + 10}" y="${C.t + 30}">Static: ${TOTALS.lpIncome.static.toFixed(3)} to LPs</text>`,
});
feeSvg.insertAdjacentHTML("beforeend", xAxis(barBottom));

function xAxis(yb) {
  return [1, 5, 10, 15, 20, 25, 30].map((i) => `<text class="tick" x="${cx(i - 0.5)}" y="${yb + 20}" text-anchor="middle">${i}</text>`).join("") +
    `<text class="tick" x="${C.W - C.r + 8}" y="${yb + 20}">buy #</text>`;
}

function setCursor(i) {
  // i is 1..N
  const place = (svg, c, xi) => {
    const g = svg.querySelector(".cursor");
    const x = cx(xi);
    g.querySelector("line").setAttribute("x1", x); g.querySelector("line").setAttribute("x2", x);
    g.querySelector(".pt-s").setAttribute("cx", x); g.querySelector(".pt-s").setAttribute("cy", c.y(c.s[i - 1]));
    g.querySelector(".pt-g").setAttribute("cx", x); g.querySelector(".pt-g").setAttribute("cy", c.y(c.g[i - 1]));
  };
  place(premSvg, prem, i);
  place(feeSvg, fees, i);
  const sc = $("scrub");
  sc.value = i; setRangeFill(sc);
  $("scrubN").textContent = i;
  $("scrubRead").innerHTML =
    `Static: premium <i>+${PREM.s[i - 1].toFixed(1)}%</i>, all-in cost <i>${pct(REPLAY.static.allInPips[i - 1])}</i>, cumulative paid <i>${CUM.s[i - 1].toFixed(3)}</i>. ` +
    `<b>Gapguard:</b> premium <i>+${PREM.g[i - 1].toFixed(1)}%</i>, all-in cost <b>${pct(G_ALL[i - 1])}</b>, cumulative paid <b>${CUM.g[i - 1].toFixed(3)}</b>, to LPs and the hook.`;
}
$("scrub").addEventListener("input", (e) => setCursor(+e.target.value));
for (const svg of [premSvg, feeSvg]) {
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * C.W;
    const i = Math.round(((vx - C.l) / (C.W - C.l - C.r)) * N + 0.5);
    setCursor(Math.min(N, Math.max(1, i)));
  });
}
setCursor(N);

// data table
{
  let t = `<thead><tr><th>Buy</th><th>Static premium</th><th>Static all-in</th><th>Gapguard premium</th><th>Gapguard all-in</th></tr></thead><tbody>`;
  for (let i = 0; i < N; i++) {
    t += `<tr><td>${i + 1}</td><td>+${PREM.s[i].toFixed(2)}%</td><td>${pct(REPLAY.static.allInPips[i], 3)}</td><td>+${PREM.g[i].toFixed(2)}%</td><td>${pct(G_ALL[i], 3)}</td></tr>`;
  }
  $("dataTable").insertAdjacentHTML("beforeend", t + "</tbody>");
}

// draw-in on scroll
if ("IntersectionObserver" in window && !reduced) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("drawn"); io.unobserve(e.target); }
  }, { threshold: 0.35 });
  document.querySelectorAll(".chart-fig").forEach((f) => io.observe(f));
} else {
  document.querySelectorAll(".chart-fig").forEach((f) => f.classList.add("drawn"));
}

// ------------------------------------------------------------------ footer
{
  const rows = [["Hook", NET.hook], ["Stock", NET.stock], ["USD", NET.usd], ["PoolManager", NET.poolManager]];
  $("addrList").innerHTML = rows.map(([k, v]) =>
    `<li><span class="k">${k}</span>${isAddr(v)
      ? `<a class="v" href="${esc(addrUrl(v))}" target="_blank" rel="noopener">${esc(v)}</a>`
      : `<span class="v pending">awaiting deployment</span>`}</li>`).join("");
  $("footNet").textContent = `· ${NET.name} ${NET.chainId}`;
  const repo = LINKS && LINKS.repo;
  $("linkList").innerHTML =
    (repo ? `<li><a href="${esc(repo)}" target="_blank" rel="noopener">GitHub repository ↗</a></li>` : `<li class="pending">GitHub repository — link added at submission</li>`) +
    `<li><a href="${esc(NET.explorer)}" target="_blank" rel="noopener">Robinhood Chain explorer ↗</a></li>`;
  $("netSwitch").innerHTML = isTestnet
    ? `Viewing testnet · <a href="?">switch to mainnet</a>`
    : `Viewing mainnet · <a href="?net=testnet">switch to testnet</a>`;
}

// ------------------------------------------------------------------ live pool panel
const panel = $("panel");
$("panelNet").textContent = `${NET.name} · chain ${NET.chainId}`;
const setRo = (id, v, note, cls = "") => {
  const el = $(id);
  el.innerHTML = v;
  el.className = "ro-v " + cls;
  if (note !== undefined) $(id + "N").innerHTML = note;
};

function ago(sec) {
  if (sec < 90) return `${sec}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`;
  if (sec < 2 * DAY) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / DAY)}d ago`;
}

function dirTag(open, drift, zeroForOne) {
  if (open) return `<span class="tag">BASE</span>`;
  if (drift === 0) return `<span class="tag away">AT ANCHOR</span>`; // both directions count as away
  const away = (drift > 0 && !zeroForOne) || (drift < 0 && zeroForOne);
  return away ? `<span class="tag away">AWAY</span>` : `<span class="tag toward">TOWARD</span>`;
}

function renderSnapshot(s, reader) {
  const now = Math.floor(Date.now() / 1000);
  const local = isOpen(now);
  setRo("roOpen", s.open ? "OPEN" : "CLOSED",
    `isMarketOpen() · ${s.open === local ? "matches page clock" : "differs from page clock (block time)"}` +
    (s.params ? ` · while closed, one swap moves ≤ ${s.params.maxClosedMoveTicks} ticks (maxClosedMoveTicks)` : ""), s.open ? "open" : "closed");

  if (!s.key) {
    for (const id of ["roBuy", "roSell", "roDrift", "roRef", "roTick"]) setRo(id, "—", "set <code>stock</code> + <code>usd</code> in config.js");
  } else if (!s.initialized) {
    for (const id of ["roBuy", "roSell", "roDrift", "roRef", "roTick"]) setRo(id, "—", "pool not initialized yet");
  } else {
    const d = s.tick - s.anchorTick;
    const buyZfo = !s.key.stockIs0; // paying USD for stock
    const buyFee = buyZfo ? s.fee0For1 : s.fee1For0;
    const sellFee = buyZfo ? s.fee1For0 : s.fee0For1;
    setRo("roBuy", pct(buyFee) + dirTag(s.open, d, buyZfo), `quoteFee(id, ${buyZfo}) · same for any size`);
    setRo("roSell", pct(sellFee) + dirTag(s.open, d, !buyZfo), `quoteFee(id, ${!buyZfo}) · same for any size`);
    const stockTicks = s.key.stockIs0 ? d : -d;
    const dp = driftPct(stockTicks);
    setRo("roDrift", (dp >= 0 ? "+" : "") + dp.toFixed(2) + "%", `${d > 0 ? "+" : ""}${d} ticks · stock price vs anchor`);
    setRo("roRef", String(s.anchorTick), s.lastSwap ? `anchorTick(id) · time-weighted · price held since ${ago(Math.max(0, now - s.lastSwap))}` : "anchorTick(id) · time-weighted");
    setRo("roTick", String(s.tick), "PoolManager.extsload · slot0");
  }

  const p = s.params;
  const paramNote = p ? ` Onchain params: base ${pct(Number(p.baseFee))}, closed +${pct(Number(p.closedSurcharge))}, drift ${pct(Number(p.driftCoefficient), 3)}/tick, cap +${pct(Number(p.maxDriftSurcharge))}, max move per closed swap ${p.maxClosedMoveTicks} ticks, hook share ${Number(p.skimBips) / 100}% of the surcharge.` : "";
  $("panelFoot").innerHTML =
    `Hook <a href="${esc(addrUrl(NET.hook))}" target="_blank" rel="noopener">${esc(short(NET.hook))}</a>` +
    (reader.poolId ? ` · poolId <code title="${esc(reader.poolId)}">${esc(short(reader.poolId))}</code>` : "") +
    `.${paramNote} Refreshes every 15s.`;
}

async function startLive() {
  if (!NET.hook) {
    panel.dataset.state = "idle";
    $("panelStatus").textContent = "Awaiting deployment";
    return;
  }
  panel.dataset.state = "loading";
  $("panelStatus").textContent = "Connecting…";
  if (![NET.hook, NET.poolManager].every(isAddr) || (NET.stock && !isAddr(NET.stock)) || (NET.usd && !isAddr(NET.usd))) {
    panel.dataset.state = "error";
    $("panelStatus").textContent = "Invalid address in config.js";
    return;
  }
  let reader;
  try {
    const mod = await import("./pool.js");
    reader = mod.makeReader(NET);
  } catch (err) {
    console.warn("[gapguard] live panel unavailable:", err);
    panel.dataset.state = "error";
    $("panelStatus").textContent = "Couldn't load the chain client";
    return;
  }
  let fails = 0;
  const poll = async () => {
    try {
      const s = await reader.snapshot();
      renderSnapshot(s, reader);
      fails = 0;
      panel.dataset.state = "live";
      const t = new Date();
      $("panelStatus").textContent = `Live · updated ${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
    } catch (err) {
      fails++;
      console.warn("[gapguard] read failed:", err && err.shortMessage ? err.shortMessage : err);
      panel.dataset.state = "error";
      $("panelStatus").textContent = fails > 1 ? `RPC unreachable · retrying (${fails})` : "RPC read failed · retrying";
    }
    setTimeout(poll, 15000);
  };
  poll();
}
startLive();
