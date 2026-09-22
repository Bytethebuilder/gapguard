// Hook revenue panel + permissionless "Collect fees" flow.
// Reads: ERC-6909 claims on the PoolManager, the hook's unassigned token balance, and what it owes each
// recipient. Writes (only when a wallet is present): collect → distribute → withdraw, each simulated first.
// Every call is permissionless and can only move funds to the hook or its two immutable recipients.
import { createWalletClient, custom, formatUnits, getAddress } from "./viem.js";

const ZERO = "0x0000000000000000000000000000000000000000";

// ------------------------------------------------------------------ wallet discovery
// With several extensions installed, whichever injected last owns window.ethereum (often not the one
// the user wants). EIP-6963 lets each wallet announce itself, so we can pick MetaMask explicitly.
const METAMASK_RDNS = ["io.metamask", "io.metamask.flask"];
const wallets = []; // { info: { uuid, name, rdns }, provider }
const walletListeners = new Set();
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e) => {
    const d = e.detail;
    if (!d?.provider || !d.info || wallets.some((w) => w.info.uuid === d.info.uuid)) return;
    wallets.push(d);
    walletListeners.forEach((f) => f());
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** All usable wallets, MetaMask first. Falls back to legacy window.ethereum when nothing announces. */
function walletOptions() {
  const list = [...wallets];
  if (!list.length && typeof window !== "undefined" && window.ethereum) {
    const legacy = window.ethereum.providers || [window.ethereum];
    legacy.forEach((p, i) => list.push({
      info: { uuid: "legacy-" + i, name: p.isMetaMask && !p.isTrust && !p.isTrustWallet ? "MetaMask" : "Browser wallet", rdns: p.isMetaMask && !p.isTrust && !p.isTrustWallet ? "io.metamask" : "" },
      provider: p,
    }));
  }
  return list.sort((a, b) => Number(METAMASK_RDNS.includes(b.info.rdns)) - Number(METAMASK_RDNS.includes(a.info.rdns)));
}
const DECIMALS = 18;

const HOOK_ABI = [
  { type: "function", name: "protocolRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "operatorRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "protocolShareBips", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "totalOwed", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "owed", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "collect", stateMutability: "nonpayable", inputs: [{ name: "currency", type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "distribute", stateMutability: "nonpayable", inputs: [{ name: "currency", type: "address" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ name: "currency", type: "address" }, { name: "recipient", type: "address" }], outputs: [{ type: "uint256" }],
  },
  { type: "error", name: "NothingToDistribute", inputs: [] },
  { type: "error", name: "NothingOwed", inputs: [] },
  { type: "error", name: "NotPoolManager", inputs: [] },
];
const PM_ABI = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }],
  },
];
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function fmt(v) {
  if (v === 0n) return "0";
  const s = formatUnits(v, DECIMALS);
  const [i, f = ""] = s.split(".");
  if (i !== "0") return `${Number(i).toLocaleString("en-US")}${f ? "." + f.slice(0, 4).replace(/0+$/, "") : ""}`.replace(/\.$/, "");
  const lead = f.match(/^0*/)[0].length; // keep 3 significant digits for small amounts
  return lead >= 12 ? "< 0.000000000001" : `0.${f.slice(0, lead + 3).replace(/0+$/, "")}`;
}

export function makeRevenue(cfg, client, $) {
  const hook = getAddress(cfg.hook);
  const pm = getAddress(cfg.poolManager);
  const tokens = [cfg.stock, cfg.usd].filter(Boolean).map((a) => ({ address: getAddress(a), symbol: null }));
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const txUrl = (h) => `${cfg.explorer}/tx/${h}`;
  const addrUrl = (a) => `${cfg.explorer}/address/${a}`;

  let meta = null; // recipients + split, immutable
  let state = null; // last read
  let busy = false;

  async function loadMeta() {
    if (meta) return meta;
    const [protocol, operator, bips] = await Promise.all([
      read(hook, HOOK_ABI, "protocolRecipient"),
      read(hook, HOOK_ABI, "operatorRecipient"),
      read(hook, HOOK_ABI, "protocolShareBips"),
      ...tokens.map(async (t) => { t.symbol = await read(t.address, ERC20_ABI, "symbol").catch(() => short(t.address)); }),
    ]);
    meta = { protocol: getAddress(protocol), operator: getAddress(operator), bips: Number(bips) };
    meta.same = meta.protocol === meta.operator;
    meta.recipients = meta.same ? [meta.protocol] : [meta.protocol, meta.operator];
    return meta;
  }

  async function readCurrency(c) {
    const isEth = c === ZERO;
    const [claims, bal, totalOwed, ...owed] = await Promise.all([
      read(pm, PM_ABI, "balanceOf", [hook, BigInt(c)]),
      isEth ? client.getBalance({ address: hook }) : read(c, ERC20_ABI, "balanceOf", [hook]),
      read(hook, HOOK_ABI, "totalOwed", [c]),
      ...meta.recipients.map((r) => read(hook, HOOK_ABI, "owed", [r, c])),
    ]);
    const unassigned = bal > totalOwed ? bal - totalOwed : 0n;
    const pending = claims > 0n || unassigned > 0n || owed.some((o) => o > 0n);
    return { currency: c, claims, unassigned, owed, pending };
  }

  async function readAll() {
    await loadMeta();
    const rows = await Promise.all(tokens.map(async (t) => ({ ...(await readCurrency(t.address)), symbol: t.symbol })));
    const eth = await readCurrency(ZERO);
    if (eth.pending) rows.push({ ...eth, symbol: "ETH" });
    return rows;
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!state || !meta) return;
    const pct = (b) => `${b / 100}%`;
    $("revRecipients").innerHTML =
      `<span>Protocol ${pct(meta.bips)} → <a href="${esc(addrUrl(meta.protocol))}" target="_blank" rel="noopener">${esc(short(meta.protocol))}</a></span>` +
      `<span>Operator ${pct(10000 - meta.bips)} → <a href="${esc(addrUrl(meta.operator))}" target="_blank" rel="noopener">${esc(short(meta.operator))}</a></span>` +
      (meta.same ? `<span class="rev-note">Both are the same address on this deployment, so one withdraw pays both shares.</span>` : "");

    const owedHead = meta.same ? `Owed to ${short(meta.protocol)}` : `Owed · protocol / operator`;
    let h = `<div class="rev-row rev-head" role="row"><span role="columnheader">Token</span><span role="columnheader">Claims not collected</span>` +
      `<span role="columnheader">Unassigned in hook</span><span role="columnheader">${esc(owedHead)}</span></div>`;
    for (const r of state) {
      const owed = r.owed.map(fmt).join(" / ");
      h += `<div class="rev-row${r.pending ? " pending" : ""}" role="row">` +
        `<span role="cell" class="rev-sym">${esc(r.symbol)}</span>` +
        `<span role="cell" data-k="Claims"><b>${fmt(r.claims)}</b></span>` +
        `<span role="cell" data-k="Unassigned"><b>${fmt(r.unassigned)}</b></span>` +
        `<span role="cell" data-k="Owed"><b>${esc(owed)}</b></span></div>`;
    }
    $("revTable").innerHTML = h;
    updateButton();
  }

  function updateButton() {
    const btn = $("revCollect");
    if (busy) { btn.disabled = true; btn.textContent = "Collecting…"; return; }
    if (!state) { btn.disabled = true; btn.textContent = "Checking…"; return; }
    const any = state.some((r) => r.pending);
    if (!any) { btn.disabled = true; btn.textContent = "Nothing to collect"; return; }
    const w = selectedWallet();
    if (!w) { btn.disabled = true; btn.textContent = "Install a wallet to collect"; return; }
    btn.disabled = false;
    btn.textContent = `Collect fees with ${w.info.name}`;
  }

  // Wallet picker: shown only when more than one wallet is installed; MetaMask is the default.
  let chosenUuid = null;
  function selectedWallet() {
    const opts = walletOptions();
    return opts.find((w) => w.info.uuid === chosenUuid) || opts[0] || null;
  }
  function renderWalletPicker() {
    const sel = $("revWallet");
    const opts = walletOptions();
    sel.hidden = opts.length < 2;
    const current = selectedWallet();
    sel.innerHTML = opts.map((w) =>
      `<option value="${esc(w.info.uuid)}"${w === current ? " selected" : ""}>${esc(w.info.name)}</option>`).join("");
    updateButton();
  }
  $("revWallet").addEventListener("change", (e) => { chosenUuid = e.target.value; updateButton(); });
  walletListeners.add(renderWalletPicker);

  async function refresh() {
    if (busy) return; // the collect flow re-reads on its own
    state = await readAll();
    render();
  }

  // ---------------------------------------------------------------- write flow
  const log = $("revLog");
  function step(label) {
    const li = document.createElement("li");
    li.dataset.s = "run";
    li.innerHTML = `<span class="st" aria-hidden="true"></span><span class="lb">${esc(label)}</span><span class="tx"></span>`;
    log.appendChild(li);
    return {
      set(s, extra = "") { li.dataset.s = s; li.querySelector(".tx").innerHTML = extra; },
    };
  }
  const hashLink = (h) => `<a href="${esc(txUrl(h))}" target="_blank" rel="noopener">${esc(short(h))} ↗</a>`;

  function errText(err) {
    const e = err || {};
    const rejected = e.code === 4001 || e.cause?.code === 4001 || /UserRejected|rejected|denied/i.test(e.name + " " + (e.shortMessage || e.message || ""));
    if (rejected) return { rejected: true, text: "Rejected in wallet" };
    return { rejected: false, text: (e.shortMessage || e.message || String(e)).split("\n")[0].slice(0, 160) };
  }

  const hexId = () => "0x" + Number(cfg.chainId).toString(16);
  async function ensureChain(provider) {
    const current = await provider.request({ method: "eth_chainId" });
    if (parseInt(current, 16) === Number(cfg.chainId)) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId() }] });
    } catch (err) {
      const code = err?.code ?? err?.data?.originalError?.code;
      if (code !== 4902 && code !== -32603) throw err;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId(),
          chainName: cfg.chainId === 4663 ? "Robinhood Chain" : "Robinhood Chain Testnet",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [cfg.rpc],
          blockExplorerUrls: [cfg.explorer],
        }],
      });
    }
    const now = await provider.request({ method: "eth_chainId" });
    if (parseInt(now, 16) !== Number(cfg.chainId)) throw new Error(`Wallet is on chain ${parseInt(now, 16)}, not ${cfg.chainId}`);
  }

  async function send(wallet, account, functionName, args, label) {
    const s = step(label);
    try {
      const { request } = await client.simulateContract({ account, address: hook, abi: HOOK_ABI, functionName, args });
      s.set("sign", "confirm in wallet…");
      const hash = await wallet.writeContract(request);
      s.set("wait", hashLink(hash));
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") { s.set("err", `${hashLink(hash)} reverted`); throw Object.assign(new Error("Transaction reverted"), { handled: true }); }
      s.set("ok", hashLink(hash));
    } catch (err) {
      if (!err.handled) { const e = errText(err); s.set("err", esc(e.text)); err.handled = true; err.rejected = e.rejected; }
      throw err;
    }
  }

  async function collectAll() {
    const provider = selectedWallet()?.provider;
    if (!provider || busy) return;
    busy = true;
    updateButton();
    log.innerHTML = "";
    $("revStatus").textContent = "";
    try {
      const conn = step("Connect wallet");
      let account;
      try {
        [account] = await provider.request({ method: "eth_requestAccounts" });
        if (!account) throw new Error("No account available");
        account = getAddress(account);
        conn.set("run", esc(short(account)));
        await ensureChain(provider);
        conn.set("ok", `${esc(short(account))} · chain ${cfg.chainId}`);
      } catch (err) {
        const e = errText(err); conn.set("err", esc(e.text)); err.handled = true; throw err;
      }
      const chain = {
        id: Number(cfg.chainId), name: "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [cfg.rpc] } },
      };
      const wallet = createWalletClient({ account, chain, transport: custom(provider) });

      const rows = await readAll();
      let sent = 0;
      for (const r of rows.filter((x) => x.pending)) {
        const c = r.currency;
        if ((await read(pm, PM_ABI, "balanceOf", [hook, BigInt(c)])) > 0n) {
          await send(wallet, account, "collect", [c], `Collect ${r.symbol} claims`); sent++;
        }
        const now = await readCurrency(c);
        if (now.unassigned > 0n) { await send(wallet, account, "distribute", [c], `Distribute ${r.symbol}`); sent++; }
        for (const rcpt of meta.recipients) {
          const owed = await read(hook, HOOK_ABI, "owed", [rcpt, c]);
          if (owed > 0n) {
            const who = meta.same ? "recipient" : rcpt === meta.protocol ? "protocol" : "operator";
            await send(wallet, account, "withdraw", [c, rcpt], `Withdraw ${fmt(owed)} ${r.symbol} to ${who} ${short(rcpt)}`); sent++;
          }
        }
      }
      $("revStatus").textContent = sent ? `Done: ${sent} transaction${sent > 1 ? "s" : ""} confirmed.` : "Nothing needed collecting.";
    } catch (err) {
      console.warn("[gapguard] collect flow stopped:", err?.shortMessage || err?.message || err);
      $("revStatus").textContent = err?.rejected ? "Stopped: you rejected a transaction. Nothing else was sent." : "Stopped on an error. Completed steps stay done; you can run it again.";
    } finally {
      busy = false;
      try { state = await readAll(); render(); } catch { updateButton(); }
    }
  }

  $("revCollect").addEventListener("click", collectAll);
  renderWalletPicker();
  return { refresh, updateButton };
}
