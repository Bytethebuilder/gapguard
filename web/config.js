// Gapguard demo page configuration. Fill in addresses after `forge script script/Deploy.s.sol`.
// `null` = not deployed yet; the live panel shows an "awaiting deployment" state.
// Pick the network with ?net=testnet (default: mainnet).

export const CONFIG = {
  chainId: 4663,
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  hook: "0x17DaD741593cEf7801c8C80c92Bb987766cA90C4",
  stock: "0x7991b23378788C45F57809805aEA1a9C560113AD", // demo: gSTOCK, "Gapguard Demo Stock"
  usd: "0xF5A9f3D0bE7F0f82528a242cEA4C4A1f04Cd0C85", // demo: gUSD, "Gapguard Demo Dollar"
  tickSpacing: 60,
};

export const TESTNET = {
  chainId: 46630,
  rpc: "https://rpc.testnet.chain.robinhood.com/rpc",
  explorer: "https://explorer.testnet.chain.robinhood.com",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951", // same address on testnet (verified: code present)
  hook: null,
  stock: null,
  usd: null,
  tickSpacing: 60,
};

export const LINKS = {
  repo: null, // e.g. "https://github.com/<you>/gapguard"
};
