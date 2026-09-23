// Same-origin read proxy for the demo page. The Robinhood Chain RPC intermittently sends a duplicated
// CORS header, which browsers reject; proxying through the site's own origin sidesteps CORS entirely.
// Read-only and allow-listed, so it can't be used as a general-purpose RPC.
const UPSTREAM = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com/rpc",
};
const ALLOWED = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode", "eth_getStorageAt",
  "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBalance", "eth_estimateGas"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 20 || calls.some((c) => !c || !ALLOWED.has(c.method))) {
    return res.status(400).json({ error: "method not allowed" });
  }
  const upstream = UPSTREAM[req.query.net === "testnet" ? "testnet" : "mainnet"];
  const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  res.status(r.status).setHeader("content-type", "application/json").setHeader("cache-control", "no-store");
  return res.send(await r.text());
}
