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

## How it works

| Market | Fee |
|---|---|
| Open (NYSE 09:30–16:00 ET, weekdays, not a holiday) | `baseFee`. The pool price is recorded as the reference "last close". |
| Closed, swap moves price **toward** the last close | `baseFee + closedSurcharge` |
| Closed, swap moves price **away** from the last close | `baseFee + closedSurcharge + min(drift × coefficient, cap)` |

- The market clock runs onchain from `block.timestamp`, including the US daylight-saving switch.
  No oracle, no keeper.
- Holidays are fixed at deployment (NYSE 2026–2027 in the deploy script).
- Flow that restores the peg stays cheap; flow that stretches it pays for the risk it creates.
- The hook takes a capped slice of the **surcharge only**, split between a protocol and a pool
  operator. It never touches the base fee, and earns nothing while the market is open.

## Safety

No owner, no admin, no pause, no proxy. Every parameter, the holiday calendar and both fee
recipients are immutable.

| Property | Enforcement |
|---|---|
| Total LP fee ≤ 10% | `MAX_TOTAL_FEE`, checked at construction |
| Hook's cut ≤ 20% of surcharge | `MAX_SKIM_BIPS`, checked at construction |
| Every callback PoolManager-only | `onlyPoolManager` on all IHooks entrypoints |
| Pool must be dynamic-fee | `afterInitialize` reverts otherwise |
| No liquidity or donate access | those permission bits are not set |

## Weekend replay

`forge test --mc HimsReplay -vv` replays the squeeze shape — 30 one-way buys while the market is
closed — through a static 0.30% pool and a Gapguard pool with identical liquidity.

| | Static 0.30% | Gapguard |
|---|---|---|
| Premium over last close | +118.6% | +112.9% |
| LP fees earned | 0.144 | **2.095** (14.5×) |
| Average fee paid | 0.30% | 4.37% |
| Hook revenue | 0 | 0.18 stock tokens |

Stated plainly: a fee cannot stop a squeeze driven by real demand, and the premium only falls
modestly. What Gapguard changes is **who gets paid for it** — LPs earn 14.5× more for carrying the
weekend gap. This is a calibrated model of the event, not a replay of its actual transactions.

## Run it

```bash
forge test                  # 17 tests: market clock, hook behaviour, weekend replay
forge test --mc HimsReplay -vv
```

Deploy the hook plus a live demo pool (mock gHIMS/gUSD):

```bash
POOL_MANAGER=0x... PROTOCOL_RECIPIENT=0x... OPERATOR_RECIPIENT=0x... \
  forge script script/Deploy.s.sol --rpc-url $RPC --account <keystore> --broadcast
```

## Limits

- The drift surcharge is priced from the pre-swap price, so it escalates across a run of
  same-direction swaps rather than within one large swap. `closedSurcharge` covers the first.
- Early closes (13:00 ET half-days) read as open, so those afternoons charge the base fee.
- The holiday list covers 2026–2027. A new calendar means a new hook — by design, nobody can edit it.

## License

MIT
