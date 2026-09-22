// Chain reads for the live pool panel. Loaded lazily by app.js so a CDN or RPC failure
// can never break the rest of the page.
import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  concat,
  pad,
  toHex,
  getAddress,
} from "./viem.js";

export const DYNAMIC_FEE_FLAG = 0x800000;
const POOLS_SLOT = 6n; // StateLibrary.POOLS_SLOT

const HOOK_ABI = [
  { type: "function", name: "isMarketOpen", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "quoteFee", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }, { name: "zeroForOne", type: "bool" }],
    outputs: [{ name: "appliedFee", type: "uint24" }, { name: "surcharge", type: "uint24" }],
  },
  {
    type: "function", name: "anchors", stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ name: "tickQ", type: "int64" }, { name: "lastSwap", type: "uint40" }],
  },
  {
    type: "function", name: "anchorTick", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "int24" }],
  },
  ...["baseFee", "closedSurcharge", "driftCoefficient", "maxDriftSurcharge", "maxClosedMoveTicks"].map((name) => ({
    type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }],
  })),
  { type: "function", name: "skimBips", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
];

const PM_ABI = [
  {
    type: "function", name: "extsload", stateMutability: "view",
    inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ type: "bytes32" }],
  },
];

/** Sorted PoolKey for a stock/usd pair bound to the hook. */
export function poolKey(cfg) {
  const a = getAddress(cfg.stock);
  const b = getAddress(cfg.usd);
  const stockIs0 = BigInt(a) < BigInt(b);
  return {
    currency0: stockIs0 ? a : b,
    currency1: stockIs0 ? b : a,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: cfg.tickSpacing,
    hooks: getAddress(cfg.hook),
    stockIs0,
  };
}

/** PoolId = keccak256(abi.encode(PoolKey)) — identical to v4-core PoolIdLibrary.toId. */
export function computePoolId(key) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

/** StateLibrary._getPoolStateSlot: keccak256(abi.encodePacked(poolId, POOLS_SLOT)). */
export function poolStateSlot(poolId) {
  return keccak256(concat([poolId, pad(toHex(POOLS_SLOT), { size: 32 })]));
}

export function decodeSlot0(word) {
  const w = BigInt(word);
  const sqrtPriceX96 = w & ((1n << 160n) - 1n);
  let tick = Number((w >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  const lpFee = Number((w >> 208n) & 0xffffffn);
  return { sqrtPriceX96, tick, lpFee };
}

export function makeReader(cfg) {
  const client = createPublicClient({ transport: http(cfg.rpc, { timeout: 10_000, retryCount: 1 }) });
  const hook = getAddress(cfg.hook);
  const read = (functionName, args = []) => client.readContract({ address: hook, abi: HOOK_ABI, functionName, args });

  const params = Promise.all(
    ["baseFee", "closedSurcharge", "driftCoefficient", "maxDriftSurcharge", "maxClosedMoveTicks", "skimBips"].map((n) => read(n))
  ).then(([baseFee, closedSurcharge, driftCoefficient, maxDriftSurcharge, maxClosedMoveTicks, skimBips]) => ({
    baseFee, closedSurcharge, driftCoefficient, maxDriftSurcharge, maxClosedMoveTicks: Number(maxClosedMoveTicks), skimBips,
  })).catch(() => null);

  const key = cfg.stock && cfg.usd ? poolKey(cfg) : null;
  const poolId = key ? computePoolId(key) : null;

  async function snapshot() {
    const open = await read("isMarketOpen");
    if (!key) return { open, key: null, poolId: null, params: await params };

    const [p, q0, q1, anchor, ref, word] = await Promise.all([
      params,
      read("quoteFee", [poolId, true]),
      read("quoteFee", [poolId, false]),
      read("anchorTick", [poolId]),
      read("anchors", [poolId]),
      client.readContract({
        address: getAddress(cfg.poolManager), abi: PM_ABI, functionName: "extsload", args: [poolStateSlot(poolId)],
      }),
    ]);
    const slot0 = decodeSlot0(word);
    return {
      open, key, poolId, params: p,
      fee0For1: Number(q0[0]), fee1For0: Number(q1[0]),
      anchorTick: Number(anchor), lastSwap: Number(ref[1]),
      initialized: slot0.sqrtPriceX96 !== 0n,
      tick: slot0.tick,
    };
  }

  return { snapshot, key, poolId, client };
}
