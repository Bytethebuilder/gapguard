// Per-buy series from the Foundry replay — generated, do not hand-edit.
// Source: forge test --mc ReplaySeries --mt test_series -vv  (test/ReplaySeries.t.sol)
// Same scenario as test/HimsReplay.t.sol: 30 exact-input buys of 1.6 quote tokens, market closed,
// identical full-range liquidity in a static 0.30% pool and a Gapguard pool.
// premiumBps = pool price over the last close after each buy.
// allInPips  = (LP income + hook revenue) / notional for that buy, measured onchain from LP fee growth
//              plus donations and the hook balance, valued in quote at the post-swap price.
export const REPLAY = {"static":{"premiumBps":[321,648,980,1316,1658,2005,2357,2715,3077,3444,3817,4194,4577,4965,5358,5756,6159,6567,6980,7398,7822,8250,8684,9122,9566,10015,10469,10928,11392,11861],"allInPips":[2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999,2999]},"gapguard":{"premiumBps":[321,647,978,1314,1655,2002,2353,2710,3071,3438,3810,4187,4569,4955,5348,5745,6147,6554,6966,7384,7806,8234,8666,9104,9547,9995,10448,10906,11369,11837],"allInPips":[11393,17679,23862,29960,35955,41867,47675,50433,50423,50415,50406,50398,50389,50381,50374,50366,50359,50352,50345,50338,50331,50325,50318,50312,50306,50300,50294,50289,50283,50278]}};
export const BUY_SIZE = 1.6;
// Totals printed by test_replay (milli-quote → quote).
export const TOTALS = { lpIncome: { static: 0.143, gapguard: 1.879 }, hookRevenue: { static: 0, gapguard: 0.306 } };
