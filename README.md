# Gapguard

**A Uniswap v4 hook that prices the hours when the stock market is closed.**

Tokenized stocks trade 24/7 onchain. The real stock does not. Outside exchange hours the issuer
can't mint or redeem and there is no live price to arbitrage against, so a pool has no anchor: LPs
carry the whole overnight and weekend gap, and one-way flow can push the wrapper far from its last
real close.

On 29–31 Aug 2026 a memecoin routed its main liquidity as BONER/HIMS on Robinhood Chain. Every
dollar of meme demand became a forced bid for tokenized Hims & Hers. The wrapper printed **$61.15
against a $28.84 NYSE close — a 112% premium** — and collapsed within hours of minting reopening.
Across the chain's top pools, **zero used a dynamic fee**. Nothing priced the closed market.

## Live on Robinhood Chain

| | |
|---|---|
| Demo site | https://gapguard-one.vercel.app |
| GapguardHook | [`0x17DaD741593cEf7801c8C80c92Bb987766cA90C4`](https://robinhoodchain.blockscout.com/address/0x17DaD741593cEf7801c8C80c92Bb987766cA90C4) |
| Demo pool | gSTOCK [`0x7991…13AD`](https://robinhoodchain.blockscout.com/address/0x7991b23378788C45F57809805aEA1a9C560113AD) / gUSD [`0xF5A9…0C85`](https://robinhoodchain.blockscout.com/address/0xF5A9f3D0bE7F0f82528a242cEA4C4A1f04Cd0C85), dynamic fee, tick spacing 60 |
| Locked demo liquidity | [`0x78eb…5A20`](https://robinhoodchain.blockscout.com/address/0x78eb9e5D3465f05C2c3dc9C855540B1420d95A20) |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Source verification | [Sourcify — runtime match](https://sourcify.dev/server/v2/contract/4663/0x17DaD741593cEf7801c8C80c92Bb987766cA90C4) |

The site's **Hook revenue** panel shows the hook's pending fees, and its one **Collect fees** button
runs `collect` → `distribute` → `withdraw` from any wallet (funds only ever go to the recipients).

The demo tokens are fixed-supply and worthless by design; they exist so the hook can be exercised
live without touching a real tokenized stock.

## How it works

| Market | What a swap pays |
|---|---|
| Open (NYSE session, computed onchain) | `baseFee` (0.30%). The time-weighted "last close" anchor follows the pool price. |
| Closed, swap moves price **toward** the anchor | `baseFee + closedSurcharge` (0.50%) |
| Closed, swap moves price **away** from the anchor | `+ min((distance + 50) × 0.002%/tick, 4.5%)` drift surcharge |
| Closed, any swap | may move the price at most **100 ticks (~1%)** |

- **Everything is an LP fee.** The surcharges are set through v4's dynamic fee override, so they
  accrue along the swap's path to the liquidity that actually filled it. There is no lump-sum payout
  for just-in-time liquidity to capture, and `quoteFee` doesn't depend on swap size.
- **Repricing can't be dodged by splitting.** While the market is closed a single swap can move the
  price at most `maxClosedMoveTicks`. A bigger move takes several swaps, and drift is priced at the
  midpoint of a full step (`distance + limit/2`), so splitting into smaller swaps never makes a move
  cheaper — tiny steps pay at most ~0.1% more than steps at the limit.
- **Onchain NYSE calendar.** Eastern time with DST, and NYSE's holiday and early-close rules
  (weekend observance, nth-weekday holidays, Good Friday from Easter, 13:00 half-days) are computed
  by rule — no oracle, no keeper, and no list that runs out.
- **Time-weighted anchor.** A price moves the anchor only in proportion to how long it held during
  market hours — clipped exactly against each trading session — with full weight after 30 minutes.
  Pushing the price just before the close barely moves it: the push would have to survive half an
  hour while the issuer can mint and redeem. Closed-market prices carry no weight.
- **Who gets paid.** LPs get the base fee and ~85% of the surcharges. The hook keeps 15% of the
  surcharges — taken out of them, never added on top, never from the base fee. It is booked as
  ERC-6909 claims (no tokens move mid-swap), turned into tokens by anyone via `collect`, then split
  between two immutable recipients through pull-based payouts (`distribute`, `withdraw`).

## Safety

No owner, no admin, no pause, no proxy. Every parameter and both fee recipients are immutable.

| Property | Enforcement |
|---|---|
| base + closed + drift ≤ 10% | `MAX_TOTAL_FEE`, checked at construction |
| Hook's share ≤ 20% of the surcharges | `MAX_SKIM_BIPS`, checked at construction |
| Closed-market move per swap | `maxClosedMoveTicks`, enforced in `afterSwap` |
| Every callback PoolManager-only | `onlyPoolManager`; ETH only accepted from the PoolManager |
| Pool must be dynamic-fee | `afterInitialize` reverts otherwise |
| No liquidity access | those permission bits are not set |

Reviewed adversarially three times before deployment. Every confirmed finding is fixed and pinned
by a test in [`test/GapguardHook.t.sol`](test/GapguardHook.t.sol): ETH pools in all four swap modes,
dust-swap anchor freezing, whole-session gaps, split-swap drift dodging, the move limit, exact-output
swaps into one-sided pools, and last-second close manipulation. Key tests were mutation-checked (the protection removed → the test
fails).

## Weekend replay

`forge test --mc HimsReplay -vv` replays the squeeze shape — 30 one-way buys while the market is
closed, each routed in ≤100-tick steps — through a static 0.30% pool and a Gapguard pool with
identical liquidity. Everything is measured onchain (LP fee growth, hook balance), valued in quote
at the post-swap price.

| | Static 0.30% | Gapguard |
|---|---|---|
| Premium over last close | +118.6% | +113.6% |
| LP income | 0.144 | **1.834** (12.7×) |
| Hook revenue | 0 | 0.289 |
| All-in cost to weekend buyers | 0.30% | 4.43% |

Stated plainly: a fee cannot stop a squeeze driven by real demand; the premium falls only modestly.
What Gapguard changes is **who gets paid for it** — LPs earn about 13× more for carrying the weekend
gap, paid by the flow that creates it. This is a calibrated model of the event, not a replay of its
actual transactions.

## Run it

```bash
git clone --recurse-submodules https://github.com/bytethebuilder/gapguard && cd gapguard
forge test                  # calendar rules, hook behaviour, review regressions, weekend replay
forge test --mc HimsReplay -vv
```

Deploy the hook plus a live demo pool (fixed-supply gSTOCK/gUSD demo tokens, liquidity locked in an
add-only holder):

```bash
POOL_MANAGER=0x... PROTOCOL_RECIPIENT=0x... OPERATOR_RECIPIENT=0x... \
  forge script script/Deploy.s.sol --rpc-url $RPC --account <keystore> --broadcast
```

## Limits

- **Size while closed.** A closed-market swap that would move the price more than ~1% reverts, and
  the standard v4 router can't partially fill, so the largest trade is roughly the pool's depth over
  1%. Quoters simulate the hook, so aggregators see the revert and route elsewhere. If LPs pull
  liquidity for the weekend, the pool gets thin. That is the point — but it is a real constraint.
- **The hook's share** is charged on the swap's unspecified amount (the output for exact-input
  swaps), so `quoteFee` is approximate by a hair.
- **Fixed forever.** Unscheduled closures (e.g. a national day of mourning) or new NYSE holidays read
  as open unless listed at deployment. Stock splits need more repricing than the closed-market limit
  allows until the market reopens. Rebasing tokens and recipients that can't receive ETH are not
  supported.
- **Demo pool.** Its liquidity sits in an add-only holder (one add per position) and can never be
  removed or its fees collected — the demo tokens are worthless by design.

## License

MIT
