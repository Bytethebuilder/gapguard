// Per-buy series from the Foundry replay — generated, do not hand-edit.
// Source: forge test --mc ReplaySeries --mt test_series -vv  (test/ReplaySeries.t.sol)
// Same scenario as test/HimsReplay.t.sol: 30 exact-input buys of 1.6 quote tokens while the market is
// closed, each routed in ≤100-tick steps, through a static 0.30% pool and a Gapguard pool with
// identical liquidity.
// premiumBps = pool price over the last close after each buy.
// allInPips  = (LP income + hook revenue) / notional for that buy, measured onchain from LP fee growth
//              and the hook balance, valued in quote at the post-swap price.
export const REPLAY = {"static":{"premiumBps":[321,648,980,1316,1658,2005,2357,2715,3077,3444,3817,4194,4577,4965,5358,5756,6159,6567,6980,7398,7822,8250,8684,9122,9566,10015,10469,10928,11392,11861],"allInPips":[3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000,3000]},"gapguard":{"premiumBps":[320,643,970,1300,1633,1969,2308,2651,2997,3349,3705,4066,4432,4802,5177,5556,5941,6330,6724,7122,7525,7933,8345,8762,9184,9611,10042,10478,10919,11364],"allInPips":[8206,14426,20505,26473,32326,38052,43663,48743,49789,49787,49786,49785,49784,49783,49782,49781,49780,49779,49778,49777,49776,49775,49774,49773,49772,49771,49770,49770,49769,49768]}};
export const BUY_SIZE = 1.6;
// Totals printed by test_replay (milli-quote → quote).
export const TOTALS = { lpIncome: { static: 0.144, gapguard: 1.834 }, hookRevenue: { static: 0, gapguard: 0.289 } };
