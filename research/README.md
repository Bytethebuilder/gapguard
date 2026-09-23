# The closed-market gap, measured

How much tokenized-stock trading on Robinhood Chain happens while NYSE is closed, how far pool prices
drift during those hours, and whether any pool charges for it. Everything comes from onchain logs of the
Uniswap v4 PoolManager and can be re-run.

```bash
node research/measure.mjs              # writes research/closed-market.json (also: npx tsx research/measure.mjs)
node research/export-site-data.mjs     # copies the site's numbers into web/measured-data.js
python3 research/crosscheck.py         # independent re-count of a few pools (Python stdlib only)
```

No dependencies. A cold run pulls several GB of logs from the public RPC (~2 hours). Results are cached in
`$TMPDIR/gapguard-measure-cache`, so a rerun takes about a minute. `--fresh` ignores the cache.

## Window

**2026-08-31 13:30 UTC → 2026-09-21 13:30 UTC** (Monday 09:30 ET to Monday 09:30 ET, 21 days),
blocks **50,901,278 → 68,833,663**. That covers 14 closed periods: 11 weeknights and 3 weekends (one with
Labor Day). The market is closed 81.9% of that time. The window starts the morning after the HIMS weekend
on purpose, so the results don't depend on that one event. No log range was skipped. Any range the RPC
refused was split in half until it succeeded, and a range that still fails stops the script with an error.

Market hours come from `web/clock.js`, the site's 1:1 port of the hook's `MarketClock.sol`: 09:30–16:00 ET
with DST, NYSE holidays and 13:00 early closes. Everything outside the session counts as *closed*,
including weeknights. Each open and close in the window is mapped to the exact first block at or after
it, and every swap is classified by its block number.

## What counts as a tokenized stock

A token counts only if it passes **both** tests:

1. **Onchain.** It emitted `BeaconUpgraded(0xe10b…1b00)`, and its runtime code is byte-identical to the
   283-byte stock-token beacon proxy, which embeds that beacon. This is the strict version of the
   bytecode-shape check in our earlier scanner, which used symbol → ticker plus a proxy code-length band.
2. **Issuer list.** Robinhood's public token registry (`api.robinhood.com/rhj/assets/`) lists it for
   chain 4663.

204 proxies pass test 1, and 195 of them also pass test 2, so **195 stocks** are counted. The 9 proxies the
registry doesn't list are reported and excluded: WEEK, ARM, NASA, RVI, NOK, DRAM, ZETA, JEPQ and
PEACH_DEFI_1. No registry token failed test 1.

The pools come from every v4 `Initialize` event, up to the window's end, that has a stock as `currency0`
or `currency1`. That gives **84,546 pools**: 8,185 quoted in USDG, 2,917 in ETH or WETH, 73,255 in other
tokens (almost all memecoins that use a stock token as their quote asset) and 189 stock/stock.

## Swaps: census plus a sample

- **Census (every swap):** all USDG-, ETH- and WETH-quoted stock pools, 6,347,865 swaps across 5,320
  active pools. USDG (`0x5fc5…d168`, "Global Dollar") counts as $1. ETH legs are valued at ETH/USD from
  the most active WETH/USDG v4 pool (`0x84bd…0b6`, 0.02%, no hook) at the same block. Wrapped USDG is
  **not** treated as a dollar, because it held no USDG against its supply when checked (see
  `quote-assets.json`).
- **Sample (the other 73,444 pools):** 120 evenly spaced slices of 3,000 blocks (2.0% of the window's
  blocks) from the whole chain's Swap log. Open and closed rates are estimated separately, then scaled by
  the exact open/closed block counts. As a calibration, the same estimator applied to the census pools
  gives 75.8% of swaps while closed against a true 72.7%. Read the sample's closed share as roughly
  ±3 points.

Volume is raw onchain flow. It includes bots and any wash trading. The 10 largest pools carry 34% of
census volume.

## Results

| | |
|---|---|
| Census swaps while closed | **72.69%** of 6,347,865 |
| Census USD volume while closed | **72.52%**: $1,289,297,140 of $1,777,959,201 |
| …hookless pools only | 69.72% of $1,195,139,796 |
| …median pool (≥100 swaps, 1,552 pools) | 79.96% |
| Weeknights / weekends | $648.9M over 192.5 h / $640.4M over 220.5 h |
| Other-quoted pools (sampled) | ~24.4M swaps, 73.4% while closed |
| Volume-weighted fee paid, open vs closed | 0.529% vs 0.573% |

**Fee settings.** 51,470 of the 84,546 pools are dynamic-fee (`0x800000`), and 71,345 have a hook. Most
come from launchpad hooks (one hook alone has 49,248 pools). Among the 5,320 active census pools, 455 are dynamic-fee.
The most common static tiers are 5% (524 pools), 1% (137), 0% (137), 4.8–4.9% (258), 0.25% (102) and
3% (96). Some pools even set 88–90%. We can't read every
hook's logic, so we measured what each one did. The fee in each `Swap` event is the fee actually
applied, including the protocol fee. We took 232 dynamic or hooked pools with at least 5 open and
5 closed swaps each, and compared their average fee while open with their average fee while closed.
19 of them charged noticeably more while closed (≥1.25× and ≥0.05 points). We don't know why; it could
be a volatility-based fee. Across all census volume, closed-market swaps paid almost the same fee as
open-market swaps.

**Drift while closed.** Measured on each stock's *main pool*, defined as its busiest hookless USDG pool
that:

- traded at least $100,000 in the window, and
- tracked NYSE while open: the median distance from that session's NYSE close × the registry
  multiplier is ≤5%.

77 of 93 candidate pools qualify. The 16 that don't, with their tracking errors, are listed in the JSON.
Median tracking error of the 77 is 1.24%.

A price observation is a swap's post-swap price, counted only when the swap:

- moved at least $1,000,
- didn't end at a tick bound (liquidity exhausted), and
- left a price within 50% of the price it actually executed at.

These filters remove dust prints in empty tick ranges, which otherwise reach absurd values
(e.g. 10⁵¹%).

*Drift* is the largest |price / anchor − 1| during one closed period. The *anchor* is the pool's price
after its last valid swap in the open session just before that closure, i.e. the pool's own last close.
There are no NAV or historical closing prices in our tooling, so the primary metric uses the pool's own
price. A second view below uses NYSE closes from Yahoo.

| Drift vs the pool's last open-market price | closures | median | p90 | max |
|---|---|---|---|---|
| All | 578 | 1.50% | 4.92% | 150.12% |
| Weeknights | 430 | 1.29% | 3.87% | 47.35% |
| Weekends and holidays | 148 | 2.36% | 8.71% | 150.12% |
| Dollar-weighted (all) | 578 | 0.70% | 2.25% | 48.36% |
| *The underlying's own gap, same closures* (next open vs last close) | 578 | 1.01% | 3.22% | |

Wider nets give noisier tails. Across all USDG pools with at least $10k volume, 1,166 closures have a
median of 1.37% and a p90 of 5.28%. ETH-quoted pools, valued in USD, have a median of 2.29% and a p90 of
28.43%; these are mostly thin, and their numbers include ETH's own moves.

96 closures were dropped because the pool had no valid swap in the preceding session to use as an
anchor. In 37% of closures the pool moved more than twice the stock's real gap.

| Drift vs the NYSE close × multiplier (Yahoo daily bars) | closures | median | p90 |
|---|---|---|---|
| Control: the last ~30 minutes before the bell | 296 | 0.41% | 1.39% |
| While closed | 674 | 1.42% | 5.37% |
| Weekends and holidays | 173 | 2.04% | 8.57% |

**Worst closures (main pools)**, vs the pool's last open-market price:

| Stock | Closed | Last open-market | Worst closed | Drift | NYSE close → next open |
|---|---|---|---|---|---|
| GLXY | Fri 9/11 16:00 → Mon 9/14 09:30 | $25.08 | $62.74 (Sun 11:18 ET) | **+150.1%** | $24.40 → gap −5.5% |
| P | Wed 9/2 → Thu 9/3 | $96.94 | $142.84 | +47.4% | $92.43, −0.7% |
| QUBT | Mon 8/31 → Tue 9/1 | $8.24 | $4.45 | −46.0% | $8.23, −2.8% |
| PENG | Fri 9/4 → Tue 9/8 | $52.89 | $74.92 | +41.6% | $51.76, +2.2% |
| IBM | Thu 9/3 → Fri 9/4 | $234.21 | $323.71 | +38.2% | $234.71, −0.6% |

In the GLXY episode, $1,016,279 traded in that one pool over the weekend.

**Reading it honestly.** Most closures are calm: the median move is close to the stock's own overnight
gap. The problem sits in the tail, and the tail is heaviest on weekends. Meanwhile about three quarters
of the flow trades during closed hours, at the same fee as open-hours flow.

## Checks performed

- **Spot checks by hand (`cast`).** For three swaps listed in the JSON, we re-read the raw log, block
  timestamp and pool key with `cast logs` / `cast block`, then decoded amounts and price by hand. All
  three matched:
  - DJT, Sat 9/19 11:49 EDT: closed, $8.8284, $130.84
  - BABA, Fri 9/18 09:55 EDT: open, $112.63, $92.73
  - the GLXY worst print, Sun 9/13 11:18 EDT: tx `0x53ee…808d`, 1,229.10 USDG for 19.63 GLXY,
    post-swap price $62.7355
- **Independent recount (`crosscheck.py`).** Python stdlib only, with its own log fetching and exact
  per-swap block timestamps. Market hours come from `zoneinfo` plus a hand-typed holiday list instead of
  `clock.js`. We ran it on three pools (NVDA, SPY and GOOGL/USDG; 20,125 swaps), and it matched
  `measure.mjs` exactly on swap count, closed count, USD volume and closed USD volume:

  | Pool | Swaps | Closed | USD | USD closed |
  |---|---|---|---|---|
  | NVDA `0xcd5c…` | 9,528 | 9,528 | $64,989,272 | $64,989,272 |
  | SPY `0xf566…` | 1,978 | 1,978 | $25,440,072 | $25,440,072 |
  | GOOGL `0x3b01…` | 8,619 | 6,315 | $22,973,261 | $17,420,192 |

  The first two are 0%-fee hooked pools that traded only while closed. That fits the raw-flow caveat
  below.
- **Sampling calibration.** Covered above: a 3.1-point bias on census pools.

## Limits

- **Robinhood Chain v4 only.** The chain also has Uniswap v3 pools holding stock tokens; they aren't
  included.
- **Raw flow.** Volume and swap counts include bots and possible wash trading. Some large 0%-fee hooked
  pools look like it. That is why the drift uses hookless pools, and why the hookless-only volume split is
  shown above.
- **Registry multipliers are today's values.** Tokens whose multiplier is outside 0.9–1.1 are excluded
  from the NYSE-close comparisons.
- **Off-chain data is context only.** Yahoo daily bars feed only the NYSE-close comparisons and the
  "NYSE gap" column; the census numbers never use them.
- **Hooks aren't read.** The fee check covers what pools charged, not what their hooks could charge.
- **The sample is an estimate.** The other-quoted numbers carry about ±3 points of error on the closed
  share.
- **Weeknights count as closed** even though some venues trade US stocks overnight. That is why weekends
  and weeknights are reported separately.
