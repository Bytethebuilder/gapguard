// research/measure.mjs — measure the closed-market gap across every Uniswap v4 pool on Robinhood Chain
// that holds a tokenized stock. Read-only. Talks to the public RPC, plus two public HTTP endpoints used
// only as cross-checks (Robinhood's token registry, Yahoo daily bars). Writes research/closed-market.json.
//
//   node research/measure.mjs                       # default window (see WINDOW)
//   node research/measure.mjs --from 2026-08-31T13:30:00Z --to 2026-09-21T13:30:00Z
//   node research/measure.mjs --fresh               # ignore the on-disk RPC cache
//
// Also runs under `npx tsx research/measure.mjs`. No dependencies: raw JSON-RPC over fetch. Market hours
// come from web/clock.js, the site's 1:1 JS port of src/MarketClock.sol.
// A cold run pulls several GB of logs from the public RPC and takes a while; results are cached in
// $TMPDIR/gapguard-measure-cache so reruns are fast.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isOpen, nextTransition, easternParts, isTradingDay, easternDay } from "../web/clock.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

// ---- constants -----------------------------------------------------------------------------------
const RPC = process.env.RH_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
// Every Robinhood stock token is the same 283-byte beacon proxy: its runtime code embeds this beacon as
// an immutable and delegates to beacon.implementation(). The proxy's constructor emits
// BeaconUpgraded(beacon), so the full set can be enumerated from chain data alone.
const STOCK_BEACON = "0xe10b6f6b275de231345c20d14ab812db62151b00";
const TOPIC = {
  beaconUpgraded: "0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e", // BeaconUpgraded(address)
  initialize: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438", // v4 Initialize
  swap: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", // v4 Swap
};
const DYNAMIC_FEE = 0x800000;
const NATIVE = "0x0000000000000000000000000000000000000000";
const REGISTRY_URL = "https://api.robinhood.com/rhj/assets/";
const QUOTES = JSON.parse(readFileSync(join(HERE, "quote-assets.json"), "utf8"));
const STABLES = new Set(QUOTES.stables.map((x) => x.address.toLowerCase()));
const ETHS = new Set(QUOTES.eth.map((x) => x.address.toLowerCase()));
// ETH/USD reference: the most active WETH/USDG v4 pool (0.02%, no hook) — see README.
const ETH_USD_POOL = "0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6";

// Window: 21 days, Monday 09:30 ET → Monday 09:30 ET, so every closed period inside it is whole. It starts
// the morning after the HIMS weekend on purpose: these numbers are not that one event.
const WINDOW = { from: arg("from", "2026-08-31T13:30:00Z"), to: arg("to", "2026-09-21T13:30:00Z") };
// Pools quoted in something other than USDG/ETH (overwhelmingly memecoins using a stock token as their
// quote asset) are measured from a systematic time sample of the whole chain's Swap log.
const SAMPLE_SLICES = Number(arg("slices", "120"));
const SLICE_BLOCKS = Number(arg("slice-blocks", "3000")); // ~5 minutes at ~10 blocks/s
// Drift: a pool must trade at least this many USD in the window to be in the all-pools distribution.
const MIN_POOL_USD = Number(arg("min-usd", "10000"));
// A swap's price counts as an observation only if the swap moved at least this many USD (dust prints in
// empty tick ranges otherwise dominate any max), and a stock's main pool must trade at least
// PRIMARY_MIN_USD in the window to be used at all.
const OBS_MIN_USD = Number(arg("obs-usd", "1000"));
const PRIMARY_MIN_USD = Number(arg("primary-usd", "100000"));

// ---- RPC with pacing, retries, and a disk cache ---------------------------------------------------
const CACHE_DIR = join(tmpdir(), "gapguard-measure-cache");
mkdirSync(CACHE_DIR, { recursive: true });
const FRESH = flag("fresh");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0, rpcCalls = 0;
const MIN_GAP_MS = 110;

class RangeRefused extends Error {}
const refusesRange = (m) => /exceeds limit|timed out|query returned more|response size/i.test(m);

async function post(body) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    rpcCalls++;
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text();
      if (res.status === 429 || /too many requests/i.test(text.slice(0, 300))) throw new Error("Too Many Requests");
      const json = JSON.parse(text);
      if (Array.isArray(json)) return json;
      if (json.error) {
        if (refusesRange(json.error.message)) throw new RangeRefused(json.error.message);
        throw new Error(json.error.message);
      }
      return json.result;
    } catch (e) {
      if (e instanceof RangeRefused) throw e;
      if (attempt >= 14) throw e;
      await sleep(Math.min(30_000, 800 * 2 ** attempt));
    }
  }
}
const rpc = (method, params) => post({ jsonrpc: "2.0", id: 1, method, params });
const hex = (n) => "0x" + BigInt(n).toString(16);

function cached(key, fn) {
  const file = join(CACHE_DIR, createHash("sha256").update(key).digest("hex") + ".json");
  if (!FRESH && existsSync(file)) return Promise.resolve(JSON.parse(readFileSync(file, "utf8")));
  return fn().then((v) => { writeFileSync(file, JSON.stringify(v)); return v; });
}

/** Batched calls; results in order (null for a per-item error). */
async function batch(calls, size = 50) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    const chunk = calls.slice(i, i + size).map((c, j) => ({ jsonrpc: "2.0", id: j, method: c[0], params: c[1] }));
    for (let attempt = 0; ; attempt++) {
      const res = await post(chunk);
      const byId = new Map(res.map((r) => [r.id, r]));
      const retry = chunk.some((c) => !byId.has(c.id) || /too many/i.test(byId.get(c.id).error?.message ?? ""));
      if (retry && attempt < 8) { await sleep(1000 * 2 ** attempt); continue; }
      for (const c of chunk) out.push(byId.get(c.id)?.result ?? null);
      break;
    }
  }
  return out;
}

/**
 * eth_getLogs over [from, to], halving the range whenever the node refuses it (10,000-result cap or
 * timeout). `decode` maps the raw logs to a compact form, which is what gets cached. Never drops a
 * range: one that still fails at a single block throws.
 */
const stats = { splits: 0 };
async function getLogs(filter, from, to, decode = (x) => x, tag = "raw") {
  const key = JSON.stringify(["logs", tag, filter, from, to]);
  return cached(key, async () => {
    try {
      return decode(await rpc("eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]));
    } catch (e) {
      if (!(e instanceof RangeRefused) || from === to) throw e;
      stats.splits++;
      const mid = Math.floor((from + to) / 2);
      const a = await getLogs(filter, from, mid, decode, tag);
      const b = await getLogs(filter, mid + 1, to, decode, tag);
      return concatDecoded(a, b);
    }
  });
}
function concatDecoded(a, b) {
  if (Array.isArray(a)) { for (const x of b) a.push(x); return a; }
  for (const k of Object.keys(a)) for (const x of b[k]) a[k].push(x);
  return a;
}

async function getLogsSpanned(filter, from, to, span, label, decode, tag) {
  let out = null;
  for (let s = from; s <= to; s += span) {
    const e = Math.min(to, s + span - 1);
    const part = await getLogs(filter, s, e, decode, tag);
    out = out ? concatDecoded(out, part) : part;
    const n = Array.isArray(out) ? out.length : out.b.length;
    process.stdout.write(`\r  ${label}: ${Math.round(((e - from + 1) / (to - from + 1)) * 100)}%  (${n} logs)   `);
  }
  process.stdout.write("\n");
  return out ?? [];
}

// ---- ABI helpers -----------------------------------------------------------------------------------
const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const u = (w) => BigInt("0x" + w);
const sgn = (w, bits) => { const v = u(w) & ((1n << BigInt(bits)) - 1n); return v >= 1n << BigInt(bits - 1) ? v - (1n << BigInt(bits)) : v; };
const addrFromTopic = (t) => "0x" + t.slice(26).toLowerCase();
const topicFromAddr = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
function decodeString(ret) {
  if (!ret || ret === "0x") return null;
  try {
    if (ret.length === 66) return Buffer.from(ret.slice(2), "hex").toString("utf8").replace(/\0+$/, "");
    const off = Number(u(word(ret, 0))) / 32, len = Number(u(word(ret, off)));
    return Buffer.from(ret.slice(2 + (off + 1) * 64, 2 + (off + 1) * 64 + len * 2), "hex").toString("utf8");
  } catch { return null; }
}
const SEL = { symbol: "0x95d89b41", decimals: "0x313ce567", implementation: "0x5c60da1b" };
const uintRet = (r) => (r && r !== "0x" ? Number(u(r.slice(2).padStart(64, "0").slice(-64))) : null);

/** Swap logs → compact columns: block, logIndex, pool id, amount0, amount1 (raw units, as floats),
 *  sqrtPriceX96 (float), fee (pips). */
const decodeSwaps = (logs) => {
  const o = { b: [], i: [], p: [], a0: [], a1: [], sq: [], f: [] };
  for (const l of logs) {
    const d = l.data;
    o.b.push(Number(l.blockNumber)); o.i.push(Number(l.logIndex)); o.p.push(l.topics[1].toLowerCase());
    o.a0.push(Number(sgn(word(d, 0), 128))); o.a1.push(Number(sgn(word(d, 1), 128)));
    o.sq.push(Number(u(word(d, 2)))); o.f.push(Number(u(word(d, 5))));
  }
  return o;
};
/** token1 per token0, decimal adjusted, from sqrtPriceX96 (as a float). */
const priceFromSqrt = (sq, dec0, dec1) => { const sp = sq / 2 ** 96; return sp * sp * 10 ** (dec0 - dec1); };

// ---- small stats ---------------------------------------------------------------------------------
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
};
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const iso = (ts) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
const etLabel = (ts) => { const p = easternParts(ts); return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.wd]} ${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")} ET`; };

// ---- block <-> time ----------------------------------------------------------------------------------
async function blockTs(n) {
  const b = await cached(JSON.stringify(["block", n]), () => rpc("eth_getBlockByNumber", [hex(n), false]).then((b) => ({ t: b.timestamp })));
  return Number(b.t);
}
/** First block whose timestamp is >= ts (binary search, exact). */
async function blockAtOrAfter(ts, lo, hi) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTs(mid)) >= ts) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// =================================================================================================
async function main() {
  const fromTs = Math.floor(Date.parse(WINDOW.from) / 1000);
  const toTs = Math.floor(Date.parse(WINDOW.to) / 1000);
  if (!(toTs > fromTs)) throw new Error("bad window");
  const head = Number(await rpc("eth_blockNumber", []));
  if (toTs > (await blockTs(head))) throw new Error(`window end ${WINDOW.to} is after the chain head`);
  console.log(`\n  Gapguard closed-market measurement — Robinhood Chain (${CHAIN_ID})`);

  // ---- window, sessions, exact boundary blocks --------------------------------------------------
  // Every market open/close inside the window is mapped to the exact first block at or after it, so each
  // swap is classified open/closed by block number with no timestamp interpolation.
  const fromBlock = await blockAtOrAfter(fromTs, 0, head);
  const endBlock = await blockAtOrAfter(toTs, fromBlock, head); // exclusive
  const toBlock = endBlock - 1;
  const periods = []; // closed periods
  for (let t = fromTs, open = isOpen(t); t < toTs; open = !open) {
    const nxt = Math.min(nextTransition(t) ?? toTs, toTs);
    if (!open) periods.push({ start: t, end: nxt, hours: (nxt - t) / 3600 });
    t = nxt;
  }
  for (const p of periods) {
    p.kind = p.hours > 24 ? "weekend/holiday" : "weeknight";
    p.startBlock = await blockAtOrAfter(p.start, fromBlock, endBlock);
    p.endBlock = await blockAtOrAfter(p.end, p.startBlock, endBlock); // exclusive
  }
  const closedSeconds = periods.reduce((k, p) => k + (p.end - p.start), 0);
  /** index of the closed period holding block b, or -1 if the market was open. */
  const periodIdx = (b) => {
    let lo = 0, hi = periods.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, p = periods[m];
      if (b < p.startBlock) hi = m - 1; else if (b >= p.endBlock) lo = m + 1; else return m;
    }
    return -1;
  };
  console.log(`  window ${WINDOW.from} → ${WINDOW.to} = blocks ${fromBlock} → ${toBlock}; ${periods.length} closed periods (${periods.filter((p) => p.kind !== "weeknight").length} weekend/holiday)`);

  // ---- 1. tokenized stocks ----------------------------------------------------------------------
  console.log("\n  [1] tokenized stocks");
  const bu = await getLogsSpanned({ topics: [TOPIC.beaconUpgraded, topicFromAddr(STOCK_BEACON)] }, 0, toBlock, 2_000_000, "BeaconUpgraded(stock beacon)");
  const proxyAddrs = [...new Set(bu.map((l) => l.address.toLowerCase()))];
  let registry = null, registryError = null;
  try {
    const j = await (await fetch(REGISTRY_URL, { headers: { "User-Agent": "Mozilla/5.0" } })).json();
    registry = new Map();
    for (const a of j.assets) for (const d of a.deployments) if (d.chainId === CHAIN_ID)
      registry.set(d.contractAddress.toLowerCase(), { symbol: a.tokenSymbol, multiplier: Number(a.currentMultiplier) });
  } catch (e) { registryError = String(e.message ?? e); }
  const candidates = [...new Set([...proxyAddrs, ...(registry ? registry.keys() : [])])];
  const codes = await batch(candidates.map((a) => ["eth_getCode", [a, "latest"]]));
  const refCode = codes[candidates.indexOf(proxyAddrs[0])];
  const meta = await batch(candidates.flatMap((a) => [["eth_call", [{ to: a, data: SEL.symbol }, "latest"]], ["eth_call", [{ to: a, data: SEL.decimals }, "latest"]]]));
  const impl = await rpc("eth_call", [{ to: STOCK_BEACON, data: SEL.implementation }, "latest"]);
  const stocks = new Map();
  candidates.forEach((a, i) => {
    const code = codes[i] ?? "0x";
    stocks.set(a, {
      address: a, symbol: decodeString(meta[i * 2]) ?? registry?.get(a)?.symbol ?? "?", decimals: uintRet(meta[i * 2 + 1]) ?? 18,
      beaconProxy: proxyAddrs.includes(a) && code === refCode && code.includes(STOCK_BEACON.slice(2)),
      inRegistry: registry ? registry.has(a) : null, multiplier: registry?.get(a)?.multiplier ?? null, codeBytes: (code.length - 2) / 2,
    });
  });
  // Counted as a tokenized stock only if BOTH: exact-code beacon proxy AND listed by the issuer registry.
  const stockSet = new Set([...stocks.values()].filter((x) => x.beaconProxy && (registry ? x.inRegistry : true)).map((x) => x.address));
  const registryOnly = [...stocks.values()].filter((x) => x.inRegistry && !x.beaconProxy);
  const proxyOnly = [...stocks.values()].filter((x) => x.beaconProxy && x.inRegistry === false);
  console.log(`  beacon proxies: ${proxyAddrs.length} · registry: ${registry?.size ?? "unavailable"} · counted (both): ${stockSet.size}`);
  if (proxyOnly.length) console.log(`  proxy but not in registry (excluded): ${proxyOnly.map((x) => x.symbol).join(", ")}`);
  if (registryOnly.length) console.log(`  registry but not a beacon proxy (excluded): ${registryOnly.map((x) => x.symbol).join(", ")}`);

  // ---- 2. every v4 pool holding a stock ---------------------------------------------------------
  console.log("\n  [2] v4 pools containing a stock");
  const stockTopics = [...stockSet].sort().map(topicFromAddr);
  const pools = new Map();
  const decodeInit = (logs) => logs.map((l) => [l.topics[1].toLowerCase(), addrFromTopic(l.topics[2]), addrFromTopic(l.topics[3]), Number(u(word(l.data, 0))), Number(sgn(word(l.data, 1), 24)), "0x" + word(l.data, 2).slice(24).toLowerCase(), Number(l.blockNumber)]);
  for (const pos of [2, 3]) for (let i = 0; i < stockTopics.length; i += 100) {
    const topics = [TOPIC.initialize, null, null, null];
    topics[pos] = stockTopics.slice(i, i + 100);
    const logs = await getLogsSpanned({ address: POOL_MANAGER, topics: topics.slice(0, pos + 1) }, 0, toBlock, 20_000_000, `Initialize (stock as currency${pos - 2}, ${i / 100 + 1})`, decodeInit, "init");
    for (const [id, c0, c1, fee, ts, hooks, blk] of logs) pools.set(id, { id, currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks, initBlock: blk });
  }
  const quoteOf = (p) => (stockSet.has(p.currency0) && !stockSet.has(p.currency1) ? p.currency1 : stockSet.has(p.currency1) && !stockSet.has(p.currency0) ? p.currency0 : null);
  for (const p of pools.values()) {
    p.quote = quoteOf(p);
    p.stock = stockSet.has(p.currency0) ? p.currency0 : p.currency1;
    p.ticker = stocks.get(p.stock).symbol;
    p.kind = p.quote == null ? "stock/stock" : STABLES.has(p.quote) ? "usdg" : ETHS.has(p.quote) ? "eth" : "other";
    p.dynamic = p.fee === DYNAMIC_FEE;
    p.hooked = p.hooks !== NATIVE;
  }
  const all = [...pools.values()];
  const censusPools = all.filter((p) => p.kind === "usdg" || p.kind === "eth");
  console.log(`  pools ever initialized with a stock: ${all.length}  (USDG-quoted ${all.filter((p) => p.kind === "usdg").length}, ETH/WETH-quoted ${all.filter((p) => p.kind === "eth").length}, other ${all.filter((p) => p.kind === "other").length}, stock/stock ${all.filter((p) => p.kind === "stock/stock").length})`);

  // ---- 3. census: every swap in every USDG- or ETH-quoted stock pool ----------------------------
  console.log("\n  [3] swaps — full census of USDG/ETH-quoted pools");
  const ids = censusPools.map((p) => p.id).sort();
  const B = 998; // the RPC allows 1000 address+topic selectors: 1 address + topic0 + 998 pool ids
  let S = null;
  for (let i = 0; i < ids.length; i += B) {
    const part = await getLogsSpanned({ address: POOL_MANAGER, topics: [TOPIC.swap, ids.slice(i, i + B)] }, fromBlock, toBlock, 250_000, `Swap census ${i / B + 1}/${Math.ceil(ids.length / B)}`, decodeSwaps, "swapc");
    S = S ? concatDecoded(S, part) : part;
  }
  const N = S.b.length;
  console.log(`  census swaps: ${N}`);

  // ETH/USD from the reference WETH/USDG pool, looked up by block.
  const ref = await getLogsSpanned({ address: POOL_MANAGER, topics: [TOPIC.swap, ETH_USD_POOL] }, fromBlock, toBlock, 1_000_000, "ETH/USD reference", decodeSwaps, "swapc");
  const refOrder = ref.b.map((_, k) => k).sort((x, y) => ref.b[x] - ref.b[y] || ref.i[x] - ref.i[y]);
  const ethB = refOrder.map((k) => ref.b[k]), ethPx = refOrder.map((k) => priceFromSqrt(ref.sq[k], 18, 6)); // WETH(18)=c0, USDG(6)=c1
  const ethUsdAt = (b) => { let lo = 0, hi = ethB.length - 1, a = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (ethB[m] <= b) { a = m; lo = m + 1; } else hi = m - 1; } return ethPx[a]; };
  console.log(`  ETH/USD reference: ${ethB.length} swaps, ${r2(ethPx.reduce((a, x) => Math.min(a, x), Infinity))}–${r2(ethPx.reduce((a, x) => Math.max(a, x), 0))} USD`);

  // Decimals for the stocks and every census quote (read, not assumed).
  const decOf = new Map([[NATIVE, 18]]);
  const needDec = [...new Set([...stockSet, ...STABLES, ...ETHS])].filter((a) => a !== NATIVE);
  (await batch(needDec.map((a) => ["eth_call", [{ to: a, data: SEL.decimals }, "latest"]]))).forEach((r, k) => decOf.set(needDec[k], uintRet(r) ?? 18));

  // Per swap: open/closed, USD notional, USD price of the stock.
  for (const p of censusPools) Object.assign(p, { swaps: 0, swapsClosed: 0, usd: 0, usdClosed: 0, feeSumOpen: 0, feeNOpen: 0, feeSumClosed: 0, feeNClosed: 0, idx: [] });
  // A swap's post-swap price only counts as a price observation if it is a real, tradable price: the
  // swap moved ≥ OBS_MIN_USD, the pool did not end at a tick bound (liquidity exhausted), and the post-swap price is
  // within 50% of the average price the swap actually executed at.
  const MIN_SQRT = 4295128739, MAX_SQRT = 1461446703485210103287273052203988822378723970342;
  const per = new Int32Array(N), usd = new Float64Array(N), px = new Float64Array(N), valid = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const p = pools.get(S.p[k]);
    const d0 = decOf.get(p.currency0), d1 = decOf.get(p.currency1);
    const stockIs0 = p.stock === p.currency0;
    const p1per0 = priceFromSqrt(S.sq[k], d0, d1);
    const stockInQuote = stockIs0 ? p1per0 : 1 / p1per0;
    const quoteAmt = Math.abs(stockIs0 ? S.a1[k] : S.a0[k]) / 10 ** (stockIs0 ? d1 : d0);
    const mult = p.kind === "eth" ? ethUsdAt(S.b[k]) : 1;
    px[k] = stockInQuote * mult; usd[k] = quoteAmt * mult;
    const stockAmt = Math.abs(stockIs0 ? S.a0[k] : S.a1[k]) / 10 ** (stockIs0 ? d0 : d1);
    const exec = stockAmt > 0 ? quoteAmt / stockAmt : NaN;
    valid[k] = usd[k] >= OBS_MIN_USD && S.sq[k] > MIN_SQRT * 1.0001 && S.sq[k] < MAX_SQRT * 0.9999 && Math.abs(stockInQuote / exec - 1) <= 0.5 ? 1 : 0;
    per[k] = periodIdx(S.b[k]);
    p.swaps++; p.usd += usd[k]; p.idx.push(k);
    if (per[k] >= 0) { p.swapsClosed++; p.usdClosed += usd[k]; p.feeSumClosed += S.f[k]; p.feeNClosed++; }
    else { p.feeSumOpen += S.f[k]; p.feeNOpen++; }
  }
  const active = censusPools.filter((p) => p.swaps > 0);

  // ---- 4. sample: pools quoted in anything else --------------------------------------------------
  // Systematic time sample: SAMPLE_SLICES slices of SLICE_BLOCKS blocks, evenly spaced across the window
  // (the spacing is not a multiple of a day, so slices land at every hour of the week). Each slice pulls
  // the whole chain's Swap log and keeps swaps in stock pools. Open and closed rates are estimated
  // separately and scaled by the exact open/closed block counts (ratio estimator).
  console.log("\n  [4] swaps — time sample of other-quoted pools (chain-wide Swap log)");
  const otherIds = new Set(all.filter((p) => p.kind === "other" || p.kind === "stock/stock").map((p) => p.id));
  const censusIds = new Set(ids);
  const step = Math.floor((endBlock - fromBlock - SLICE_BLOCKS) / (SAMPLE_SLICES - 1));
  const smp = { blocksOpen: 0, blocksClosed: 0, otherOpen: 0, otherClosed: 0, censusOpen: 0, censusClosed: 0, usdOpen: 0, usdClosed: 0, poolsSeen: new Set(), allSwaps: 0 };
  // Stock USD reference for valuing the stock leg of sampled swaps: median census USDG-pool price of that stock.
  const stockRefUsd = new Map();
  {
    const byStock = new Map();
    for (const p of active) if (p.kind === "usdg") for (const k of p.idx) { if (!byStock.has(p.stock)) byStock.set(p.stock, []); byStock.get(p.stock).push(px[k]); }
    for (const [a, xs] of byStock) stockRefUsd.set(a, quantile(xs, 0.5));
  }
  const decodeLite = (logs) => { const o = { b: [], p: [], a0: [], a1: [] }; for (const l of logs) { o.b.push(Number(l.blockNumber)); o.p.push(l.topics[1].toLowerCase()); o.a0.push(Number(sgn(word(l.data, 0), 128))); o.a1.push(Number(sgn(word(l.data, 1), 128))); } return o; };
  for (let j = 0; j < SAMPLE_SLICES; j++) {
    const a = fromBlock + j * step, b = a + SLICE_BLOCKS - 1;
    const L = await getLogs({ address: POOL_MANAGER, topics: [TOPIC.swap] }, a, b, decodeLite, "swapl");
    for (let blk = a; blk <= b; blk++) (periodIdx(blk) >= 0 ? smp.blocksClosed++ : smp.blocksOpen++);
    smp.allSwaps += L.b.length;
    for (let k = 0; k < L.b.length; k++) {
      const closed = periodIdx(L.b[k]) >= 0;
      if (censusIds.has(L.p[k])) { closed ? smp.censusClosed++ : smp.censusOpen++; continue; }
      if (!otherIds.has(L.p[k])) continue;
      smp.poolsSeen.add(L.p[k]);
      closed ? smp.otherClosed++ : smp.otherOpen++;
      const p = pools.get(L.p[k]);
      const amt = Math.abs(p.stock === p.currency0 ? L.a0[k] : L.a1[k]) / 10 ** decOf.get(p.stock);
      const v = amt * (stockRefUsd.get(p.stock) ?? 0);
      closed ? (smp.usdClosed += v) : (smp.usdOpen += v);
    }
    process.stdout.write(`\r  slice ${j + 1}/${SAMPLE_SLICES}  (${smp.otherOpen + smp.otherClosed} other-pool swaps)   `);
  }
  process.stdout.write("\n");
  const blocksClosedTotal = periods.reduce((k, p) => k + (p.endBlock - p.startBlock), 0);
  const blocksOpenTotal = (endBlock - fromBlock) - blocksClosedTotal;
  const est = (o, c) => { const eo = (o / smp.blocksOpen) * blocksOpenTotal, ec = (c / smp.blocksClosed) * blocksClosedTotal; return { total: eo + ec, closedPct: (ec / (eo + ec)) * 100 }; };
  const otherEst = est(smp.otherOpen, smp.otherClosed);
  const otherUsdEst = est(smp.usdOpen, smp.usdClosed);
  const censusEst = est(smp.censusOpen, smp.censusClosed); // calibration: we know the census truth

  // ---- 5. aggregates -------------------------------------------------------------------------------
  const sum = (xs, f) => xs.reduce((k, x) => k + f(x), 0);
  let swapsClosed = 0, usdTotal = 0, usdClosed = 0;
  const closedByKind = { weeknight: { swaps: 0, usd: 0, hours: 0 }, "weekend/holiday": { swaps: 0, usd: 0, hours: 0 } };
  for (const p of periods) closedByKind[p.kind].hours += p.hours;
  for (let k = 0; k < N; k++) {
    usdTotal += usd[k];
    if (per[k] >= 0) { swapsClosed++; usdClosed += usd[k]; const c = closedByKind[periods[per[k]].kind]; c.swaps++; c.usd += usd[k]; }
  }
  for (const c of Object.values(closedByKind)) { c.usd = Math.round(c.usd); c.hours = r1(c.hours); }
  const byKind = {};
  for (const k of ["usdg", "eth"]) {
    const xs = active.filter((p) => p.kind === k);
    byKind[k] = { activePools: xs.length, swaps: sum(xs, (p) => p.swaps), swapsClosed: sum(xs, (p) => p.swapsClosed), usd: Math.round(sum(xs, (p) => p.usd)), usdClosed: Math.round(sum(xs, (p) => p.usdClosed)) };
    byKind[k].usdClosedPct = r2((byKind[k].usdClosed / byKind[k].usd) * 100);
  }
  const byUsd = [...active].sort((a, b) => b.usd - a.usd);
  const top10Share = sum(byUsd.slice(0, 10), (p) => p.usd) / usdTotal;

  // Fee settings.
  const feeLabel = (p) => (p.dynamic ? "dynamic" : `${+(p.fee / 1e4).toFixed(4)}%`);
  const tally = (xs, f) => { const m = {}; for (const x of xs) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1])); };
  const topN = (o, n) => Object.fromEntries(Object.entries(o).slice(0, n));
  // Does any dynamic/hooked pool charge more while the market is closed? Compare the fee each Swap event
  // reports (the fee actually applied) between open and closed swaps.
  const feeRows = active.filter((p) => (p.dynamic || p.hooked) && p.feeNOpen >= 5 && p.feeNClosed >= 5).map((p) => ({
    pool: p.id, ticker: p.ticker, quote: p.kind === "usdg" ? "USDG" : "ETH", hooks: p.hooks, dynamic: p.dynamic, usd: Math.round(p.usd),
    avgFeeOpenPct: r4(p.feeSumOpen / p.feeNOpen / 1e4), avgFeeClosedPct: r4(p.feeSumClosed / p.feeNClosed / 1e4),
  }));
  // What did closed-market flow actually pay? Volume-weighted mean applied LP fee, open vs closed.
  let fwO = 0, vO = 0, fwC = 0, vC = 0;
  for (let k = 0; k < N; k++) { if (per[k] >= 0) { fwC += S.f[k] * usd[k]; vC += usd[k]; } else { fwO += S.f[k] * usd[k]; vO += usd[k]; } }
  const volWeightedFee = { openPct: r4(fwO / vO / 1e4), closedPct: r4(fwC / vC / 1e4) };
  // Robustness: the same activity split for hookless pools only (plain v4 AMM; excludes custom hooks).
  const plain = active.filter((p) => !p.hooked);
  const plainSplit = { pools: plain.length, swaps: sum(plain, (p) => p.swaps), swapsClosed: sum(plain, (p) => p.swapsClosed), usd: Math.round(sum(plain, (p) => p.usd)), usdClosed: Math.round(sum(plain, (p) => p.usdClosed)) };
  plainSplit.swapsClosedPct = r2((plainSplit.swapsClosed / plainSplit.swaps) * 100); plainSplit.usdClosedPct = r2((plainSplit.usdClosed / plainSplit.usd) * 100);
  const busy = active.filter((p) => p.swaps >= 100);
  const medianPoolClosedUsdPct = r2(quantile(busy.map((p) => (p.usd > 0 ? p.usdClosed / p.usd : 0)), 0.5) * 100);
  const chargesMoreClosed = feeRows.filter((r) => r.avgFeeClosedPct > r.avgFeeOpenPct * 1.25 && r.avgFeeClosedPct - r.avgFeeOpenPct >= 0.05);

  // Public daily bars (Yahoo) — used only for NYSE-close comparisons and context, never for census numbers.
  const yahoo = new Map();
  async function bars(t) {
    if (yahoo.has(t)) return yahoo.get(t);
    let v = null;
    try {
      const j = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t.replace(".", "-"))}?period1=${fromTs - 10 * 86400}&period2=${toTs + 5 * 86400}&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } })).json();
      const r = j.chart.result[0], q = r.indicators.quote[0];
      v = r.timestamp.map((ts, i) => ({ day: easternDay(ts), open: q.open[i], close: q.close[i] }));
    } catch { v = null; }
    yahoo.set(t, v);
    return v;
  }
  // ---- 6. drift while closed -------------------------------------------------------------------------
  // Anchor = the pool's price after its last swap in the open session immediately before the closed
  // period (the pool's own "last close"; NOT the NYSE closing price). Episode = one pool × one closed
  // period with ≥1 swap. Value = max |price / anchor − 1| over that period's swaps.
  const sessionStartBlock = (pi) => (pi === 0 ? fromBlock : periods[pi - 1].endBlock);
  function episodesOf(p) {
    const out = [];
    const idx = [...p.idx].sort((x, y) => S.b[x] - S.b[y] || S.i[x] - S.i[y]);
    let anchor = -1, cur = null;
    for (const k of idx) {
      if (!valid[k]) continue;
      if (per[k] < 0) { if (cur) { out.push(cur); cur = null; } anchor = k; continue; }
      if (!cur || cur.pi !== per[k]) {
        if (cur) out.push(cur);
        cur = { pi: per[k], ok: anchor >= 0 && S.b[anchor] >= sessionStartBlock(per[k]), anchor, swaps: 0, usd: 0, wSum: 0, ks: [], worst: -1, dev: 0, pool: p };
      }
      if (!cur.ok) continue;
      cur.swaps++; cur.usd += usd[k];
      const d = px[k] / px[cur.anchor] - 1;
      cur.wSum += usd[k] * Math.abs(d);
      cur.ks.push(k);
      if (Math.abs(d) >= Math.abs(cur.dev)) { cur.dev = d; cur.worst = k; }
    }
    if (cur) out.push(cur);
    return out;
  }
  const dist = (xs) => xs.length ? ({ n: xs.length, medianPct: r2(quantile(xs, 0.5) * 100), p90Pct: r2(quantile(xs, 0.9) * 100), maxPct: r2(Math.max(...xs) * 100),
    over1Pct: xs.filter((x) => x > 0.01).length, over5Pct: xs.filter((x) => x > 0.05).length, over10Pct: xs.filter((x) => x > 0.10).length }) : null;
  // Primary venue per stock = its highest-USD-volume plain (no-hook) USDG pool in the window: a hook can
  // change what a swap pays, so only hookless pools are used as the stock's reference price.
  const primaryAll = new Map();
  for (const p of active.filter((p) => p.kind === "usdg" && !p.hooked && p.usd >= PRIMARY_MIN_USD)) if (!primaryAll.has(p.stock) || p.usd > primaryAll.get(p.stock).usd) primaryAll.set(p.stock, p);
  // Tracking check: a venue is used only if, while NYSE is open, it trades near the real stock — median
  // |price / (that session's NYSE close × multiplier) − 1| over its valid open-market swaps ≤ TRACK_MAX.
  // A pool that is far off even while the exchange is open is broken or isolated, not closed-market drift.
  const TRACK_MAX = 0.05;
  const sessionCloseDay = (b) => { for (const P of periods) if (P.startBlock > b) return easternDay(P.start); return null; };
  const primary = new Map(), tracking = [];
  for (const [a, p] of primaryAll) {
    const m = stocks.get(a).multiplier ?? 1;
    const bs = await bars(p.ticker);
    const closeByDay = new Map((bs ?? []).filter((x) => x.close).map((x) => [x.day, x.close]));
    const errs = [];
    for (const k of p.idx) if (valid[k] && per[k] < 0) { const c = closeByDay.get(sessionCloseDay(S.b[k])); if (c) errs.push(Math.abs(px[k] / (c * m) - 1)); }
    const med = errs.length ? quantile(errs, 0.5) : null;
    const ok = med != null && med <= TRACK_MAX && m >= 0.9 && m <= 1.1;
    tracking.push({ ticker: p.ticker, pool: p.id, usd: Math.round(p.usd), openSwaps: errs.length, medianOpenTrackingErrorPct: med == null ? null : r2(med * 100), multiplier: m, used: ok });
    if (ok) primary.set(a, p);
  }
  const primEps = [...primary.values()].flatMap(episodesOf);
  const primOk = primEps.filter((e) => e.ok);
  const bigEps = active.filter((p) => p.kind === "usdg" && p.usd >= MIN_POOL_USD).flatMap(episodesOf).filter((e) => e.ok);
  const ethEps = active.filter((p) => p.kind === "eth" && p.usd >= MIN_POOL_USD).flatMap(episodesOf).filter((e) => e.ok);
  const absDev = (es) => es.map((e) => Math.abs(e.dev));
  const isWk = (e) => periods[e.pi].kind !== "weeknight";
  const BUCKETS = [[0, 0.005, "<0.5%"], [0.005, 0.01, "0.5–1%"], [0.01, 0.02, "1–2%"], [0.02, 0.05, "2–5%"], [0.05, 0.10, "5–10%"], [0.10, Infinity, "≥10%"]];
  const hist = (xs) => BUCKETS.map(([lo, hi, label]) => ({ label, n: xs.filter((x) => x >= lo && x < hi).length }));
  const drift = {
    method: "Per closed period: max |pool price / anchor − 1| over the period's swaps. Anchor = the pool's price after its last swap in the open session just before that closed period (the pool's own last close, not the NYSE close). Episodes with no anchor in that session are dropped and counted.",
    primaryVenues: {
      definition: `each stock's highest-USD-volume hookless USDG pool that traded ≥ $${PRIMARY_MIN_USD.toLocaleString("en-US")} in the window (one pool per stock); price observations only from swaps of ≥ $${OBS_MIN_USD.toLocaleString("en-US")} that did not end at a tick bound and whose post-swap price is within 50% of their execution price`,
      dollarWeighted: dist(primOk.map((e) => e.wSum / e.usd)),
      dollarWeightedWeekend: dist(primOk.filter(isWk).map((e) => e.wSum / e.usd)),
      invalidObservationsDropped: [...primary.values()].reduce((k, p) => k + p.idx.filter((j) => !valid[j]).length, 0),
      stocks: primary.size,
      candidates: primaryAll.size,
      trackingRule: "used only if median |open-market price / that session's NYSE close × multiplier − 1| ≤ 5% and multiplier within 0.9–1.1",
      excludedByTracking: tracking.filter((t) => !t.used),
      trackingMedianOfUsedPct: r2(quantile(tracking.filter((t) => t.used).map((t) => t.medianOpenTrackingErrorPct), 0.5)),
      all: dist(absDev(primOk)),
      weekendHoliday: dist(absDev(primOk.filter(isWk))),
      weeknight: dist(absDev(primOk.filter((e) => !isWk(e)))),
      histogramWeeknight: hist(absDev(primOk.filter((e) => !isWk(e)))),
      histogramWeekend: hist(absDev(primOk.filter(isWk))),
      droppedNoAnchor: primEps.filter((e) => !e.ok).length,
    },
    allUsdgPoolsOverMin: { minPoolUsd: MIN_POOL_USD, ...dist(absDev(bigEps)) },
    ethPoolsOverMinInUsd: { minPoolUsd: MIN_POOL_USD, ...dist(absDev(ethEps)) },
  };

  // Worst episodes on primary venues, with the real NYSE gap over the same closure for context.
  const worst = [...primOk].sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev)).slice(0, 12);

  // Baseline: how far did the real stock move over the same closures? |next open / last close − 1| from
  // Yahoo daily bars, for every primary-venue episode (context only; not used in the drift numbers).
  const nyseGap = async (ticker, P) => {
    const bs = await bars(ticker);
    if (!bs) return null;
    const before = bs.filter((x) => x.day <= easternDay(P.start) && isTradingDay(x.day) && x.close).pop();
    const after = bs.find((x) => x.day >= easternDay(P.end) && x.open);
    return before && after ? after.open / before.close - 1 : null;
  };
  const gapPairs = [];
  for (const e of primOk) { const g = await nyseGap(e.pool.ticker, periods[e.pi]); if (g != null) gapPairs.push({ pool: Math.abs(e.dev), nyse: Math.abs(g), wk: isWk(e) }); }
  drift.primaryVenues.nyseBaseline = {
    note: "same episodes, where Yahoo had bars: the underlying's own move over the closure (next regular open vs last regular close)",
    episodes: gapPairs.length,
    medianPoolMaxDevPct: r2(quantile(gapPairs.map((x) => x.pool), 0.5) * 100), medianNyseGapPct: r2(quantile(gapPairs.map((x) => x.nyse), 0.5) * 100),
    p90PoolMaxDevPct: r2(quantile(gapPairs.map((x) => x.pool), 0.9) * 100), p90NyseGapPct: r2(quantile(gapPairs.map((x) => x.nyse), 0.9) * 100),
    shareWherePoolMovedMoreThan2xNyse: r2((gapPairs.filter((x) => x.pool > 2 * x.nyse).length / gapPairs.length) * 100),
  };
  // Second anchor: the real NYSE close. Premium = pool price / (last regular close × token multiplier) − 1.
  // Only tokens whose registry multiplier is within 0.9–1.1 (the multiplier is today's value; a split or
  // large adjustment inside the window would distort the comparison). Control: the same pool's median
  // premium over its valid swaps in the ~30 minutes (≈18,000 blocks) before the bell that starts the closure.
  const lastClose = async (ticker, P) => {
    const bs = await bars(ticker);
    const before = bs?.filter((x) => x.day <= easternDay(P.start) && isTradingDay(x.day) && x.close).pop();
    return before ? before.close : null;
  };
  const navEps = [];
  const excludedMultiplier = new Set();
  for (const p of primary.values()) {
    const m = stocks.get(p.stock).multiplier;
    if (m == null || m < 0.9 || m > 1.1) { excludedMultiplier.add(`${p.ticker} (${m})`); continue; }
    const sorted = [...p.idx].filter((k) => valid[k]).sort((x, y) => S.b[x] - S.b[y] || S.i[x] - S.i[y]);
    for (let pi = 0; pi < periods.length; pi++) {
      const P = periods[pi];
      const close = await lastClose(p.ticker, P);
      if (!close) continue;
      const nav = close * m;
      const inPeriod = sorted.filter((k) => S.b[k] >= P.startBlock && S.b[k] < P.endBlock);
      if (!inPeriod.length) continue;
      const pre = sorted.filter((k) => S.b[k] >= P.startBlock - 18000 && S.b[k] < P.startBlock).map((k) => Math.abs(px[k] / nav - 1));
      let worst = inPeriod[0];
      for (const k of inPeriod) if (Math.abs(px[k] / nav - 1) > Math.abs(px[worst] / nav - 1)) worst = k;
      navEps.push({ ticker: p.ticker, pi, wk: P.kind !== "weeknight", maxPrem: px[worst] / nav - 1, preClose: pre.length ? quantile(pre, 0.5) : null, worst, nav });
    }
  }
  const absP = (xs) => xs.map((e) => Math.abs(e.maxPrem));
  drift.vsNyseClose = {
    method: "Per closed period, on the same primary venues and valid observations: max |pool price / (last NYSE regular close × registry multiplier) − 1|. Closes from Yahoo daily bars (public, off-chain).",
    stocks: new Set(navEps.map((e) => e.ticker)).size,
    excludedForMultiplier: [...excludedMultiplier],
    all: dist(absP(navEps)),
    weekendHoliday: dist(absP(navEps.filter((e) => e.wk))),
    weeknight: dist(absP(navEps.filter((e) => !e.wk))),
    histogramWeeknight: hist(absP(navEps.filter((e) => !e.wk))),
    histogramWeekend: hist(absP(navEps.filter((e) => e.wk))),
    controlLast30MinBeforeClose: (() => { const xs = navEps.filter((e) => e.preClose != null).map((e) => e.preClose); return { episodesWithPreCloseSwaps: xs.length, medianPct: r2(quantile(xs, 0.5) * 100), p90Pct: r2(quantile(xs, 0.9) * 100) }; })(),
    worst: await Promise.all([...navEps].sort((a, b) => Math.abs(b.maxPrem) - Math.abs(a.maxPrem)).slice(0, 10).map(async (e) => ({
      ticker: e.ticker, periodKind: periods[e.pi].kind, closedFrom: etLabel(periods[e.pi].start), closedTo: etLabel(periods[e.pi].end),
      nyseCloseTimesMultiplier: r4(e.nav), worstUsd: r4(px[e.worst]), maxPremiumPct: r2(e.maxPrem * 100), worstBlock: S.b[e.worst], worstLogIndex: S.i[e.worst], worstAt: etLabel(await blockTs(S.b[e.worst])),
      preCloseMedianPremiumPct: e.preClose == null ? null : r2(e.preClose * 100), pool: primary.get([...primary.keys()].find((a) => stocks.get(a).symbol === e.ticker)).id,
    }))),
  };
  const worstEpisodes = [];
  for (const e of worst) {
    const P = periods[e.pi], p = e.pool;
    const bs = await bars(p.ticker);
    let nyseLastClose = null, nyseNextOpen = null, nyseGapPct = null;
    if (bs) {
      const before = bs.filter((x) => x.day < easternDay(P.end) && x.day <= easternDay(P.start) && isTradingDay(x.day) && x.close).pop();
      const after = bs.find((x) => x.day >= easternDay(P.end) && x.open);
      if (before && after) { nyseLastClose = r2(before.close); nyseNextOpen = r2(after.open); nyseGapPct = r2((after.open / before.close - 1) * 100); }
    }
    const k = e.worst, a = e.anchor;
    worstEpisodes.push({
      ticker: p.ticker, pool: p.id, fee: feeLabel(p), hooks: p.hooked ? p.hooks : null, periodKind: P.kind,
      closedFrom: etLabel(P.start), closedTo: etLabel(P.end),
      anchorUsd: r4(px[a]), anchorBlock: S.b[a], worstUsd: r4(px[k]), worstBlock: S.b[k], worstLogIndex: S.i[k], worstAt: etLabel(await blockTs(S.b[k])),
      maxDevPct: r2(e.dev * 100), swapsInPeriod: e.swaps, usdInPeriod: Math.round(e.usd), poolUsdInWindow: Math.round(p.usd),
      nyseLastClose, nyseNextOpen, nyseGapPct, tokenMultiplier: stocks.get(p.stock).multiplier,
    });
  }

  // Spot-check list: a few census swaps, decoded, for checking by hand with cast.
  const spot = [];
  for (const q of [0.11, 0.37, 0.62, 0.88]) {
    const k = Math.floor(N * q), p = pools.get(S.p[k]);
    spot.push({ pool: p.id, ticker: p.ticker, kind: p.kind, block: S.b[k], logIndex: S.i[k], blockTime: iso(await blockTs(S.b[k])), marketOpen: per[k] < 0, amount0: S.a0[k], amount1: S.a1[k], stockUsd: r4(px[k]), usd: r2(usd[k]), fee: S.f[k] });
  }

  // ---- 7. output ----------------------------------------------------------------------------------------
  const out = {
    generated: new Date().toISOString(),
    script: "research/measure.mjs",
    chain: { id: CHAIN_ID, rpc: RPC, poolManager: POOL_MANAGER },
    window: {
      from: WINDOW.from, to: WINDOW.to, fromBlock, toBlock, days: r2((toTs - fromTs) / 86400),
      closedPeriods: periods.length, weekendHolidayPeriods: periods.filter((p) => p.kind !== "weeknight").length,
      closedTimePct: r2((closedSeconds / (toTs - fromTs)) * 100), closedBlockPct: r2((blocksClosedTotal / (endBlock - fromBlock)) * 100),
      logRangeSplits: stats.splits, droppedRanges: 0,
      note: "Market hours from web/clock.js (1:1 port of src/MarketClock.sol): NYSE regular session 09:30–16:00 ET with DST, holidays and 13:00 early closes. Everything else is 'closed', including weeknights. Each open/close is mapped to its exact first block; swaps are classified by block number.",
    },
    identification: {
      method: "Tokenized stock = emitted BeaconUpgraded(stockBeacon) with runtime code byte-identical to the stock-token beacon proxy, AND listed for chain 4663 by Robinhood's public token registry. Tokens passing only one test are listed and excluded.",
      stockBeacon: STOCK_BEACON, beaconImplementation: impl ? "0x" + impl.slice(26) : null, proxyCodeBytes: (refCode.length - 2) / 2,
      beaconProxies: proxyAddrs.length, registryCount: registry?.size ?? null, registryError, counted: stockSet.size,
      proxyNotInRegistry: proxyOnly.map((x) => ({ symbol: x.symbol, address: x.address })),
      registryNotProxy: registryOnly.map((x) => ({ symbol: x.symbol, address: x.address, codeBytes: x.codeBytes })),
      tickersWithV4Pools: [...new Set(all.map((p) => p.ticker))].sort(),
      tickersActiveInCensus: [...new Set(active.map((p) => p.ticker))].sort(),
    },
    quoteAssets: QUOTES, ethUsdReferencePool: ETH_USD_POOL,
    pools: {
      everInitialized: all.length,
      byQuote: tally(all, (p) => p.kind),
      census: { pools: censusPools.length, activeInWindow: active.length, byQuote: byKind },
      feeTiersAll: topN(tally(all, feeLabel), 12), feeTiersCensusActive: topN(tally(active, feeLabel), 12),
      dynamicFeeAll: all.filter((p) => p.dynamic).length, dynamicFeeCensusActive: active.filter((p) => p.dynamic).length,
      hookedAll: all.filter((p) => p.hooked).length, hookedCensusActive: active.filter((p) => p.hooked).length,
      topHooksAll: topN(tally(all.filter((p) => p.hooked), (p) => p.hooks), 8),
      topHooksCensusActive: topN(tally(active.filter((p) => p.hooked), (p) => p.hooks), 8),
      feeOpenVsClosed: {
        method: "Dynamic-fee or hooked pools active in the census with ≥5 open and ≥5 closed swaps: mean applied fee (from the Swap event) while open vs while closed.",
        poolsCompared: feeRows.length,
        chargeMoreWhileClosed: chargesMoreClosed.length,
        volumeWeightedFee: volWeightedFee,
        rule: "closed mean ≥ 1.25× open mean and ≥ 0.05 percentage points higher",
        flagged: chargesMoreClosed.slice(0, 10),
        largestByVolume: [...feeRows].sort((a, b) => b.usd - a.usd).slice(0, 10),
      },
    },
    activity: {
      census: {
        scope: "every swap in every USDG- or ETH/WETH-quoted pool holding a stock",
        swaps: N, swapsClosed, swapsClosedPct: r2((swapsClosed / N) * 100),
        usd: Math.round(usdTotal), usdClosed: Math.round(usdClosed), usdClosedPct: r2((usdClosed / usdTotal) * 100),
        closedByKind, top10PoolsUsdShare: r2(top10Share * 100),
        hooklessPoolsOnly: plainSplit, medianPoolClosedUsdPct: medianPoolClosedUsdPct, poolsWith100Swaps: busy.length,
        valuation: "USDG leg as dollars; ETH leg × ETH/USD from the reference WETH/USDG pool at that block. Raw swap volume: includes bots and any wash trading.",
      },
      otherQuotedSample: {
        scope: "pools pairing a stock with anything else (memecoins using a stock token as quote; stock/stock)",
        pools: otherIds.size, slices: SAMPLE_SLICES, sliceBlocks: SLICE_BLOCKS, sampledBlocks: smp.blocksOpen + smp.blocksClosed,
        sampledPct: r2(((smp.blocksOpen + smp.blocksClosed) / (endBlock - fromBlock)) * 100),
        sampledSwaps: smp.otherOpen + smp.otherClosed, sampledChainSwaps: smp.allSwaps, distinctPoolsSeen: smp.poolsSeen.size,
        estSwaps: Math.round(otherEst.total), estSwapsClosedPct: r2(otherEst.closedPct),
        estStockLegUsd: Math.round(otherUsdEst.total), estStockLegUsdClosedPct: r2(otherUsdEst.closedPct),
        calibration: { note: "same estimator applied to census pools, whose true totals are known", estimatedSwaps: Math.round(censusEst.total), trueSwaps: N, estimatedClosedPct: r2(censusEst.closedPct), trueClosedPct: r2((swapsClosed / N) * 100) },
        valuation: "stock leg × that stock's median USDG-pool price in the window (approximate)",
      },
    },
    drift,
    worstEpisodes,
    spotChecks: spot,
    topPools: byUsd.slice(0, 25).map((p) => ({ pool: p.id, ticker: p.ticker, quote: p.kind === "usdg" ? "USDG" : "ETH", fee: feeLabel(p), hooks: p.hooked ? p.hooks : null, swaps: p.swaps, swapsClosed: p.swapsClosed, usd: Math.round(p.usd), usdClosed: Math.round(p.usdClosed) })),
    rpcCalls,
  };
  writeFileSync(join(HERE, "closed-market.json"), JSON.stringify(out, null, 2) + "\n");

  const c = out.activity.census, o = out.activity.otherQuotedSample, dp = drift.primaryVenues;
  console.log(`\n  census: ${c.swaps} swaps (${c.swapsClosedPct}% closed), $${c.usd.toLocaleString()} (${c.usdClosedPct}% closed); closed time ${out.window.closedTimePct}%`);
  console.log(`  other-quoted (sampled ${o.sampledPct}%): ~${o.estSwaps.toLocaleString()} swaps, ${o.estSwapsClosedPct}% closed; calibration ${o.calibration.estimatedClosedPct}% est vs ${o.calibration.trueClosedPct}% true`);
  console.log(`  drift, primary venues: ${JSON.stringify(dp.all)}  weekend: ${JSON.stringify(dp.weekendHoliday)}`);
  console.log(`  dynamic-fee pools: ${out.pools.dynamicFeeAll}/${all.length} ever; charge more while closed: ${chargesMoreClosed.length}/${feeRows.length}`);
  console.log(`  worst: ${worstEpisodes.slice(0, 5).map((e) => `${e.ticker} ${e.closedFrom} ${e.maxDevPct}% (NYSE gap ${e.nyseGapPct}%)`).join(" | ")}`);
  console.log(`\n  wrote research/closed-market.json (${rpcCalls} RPC calls, ${stats.splits} range splits)\n`);
}

main().catch((e) => { console.error("\n  fatal:", e.stack ?? e.message); process.exit(1); });
