// Demo v2: the deployed Gapguard hook in action on a local fork of Robinhood Chain mainnet.
// Needs: anvil fork on FORK (see make-live.sh), a local copy of web/ served on SITE pointed at the fork.
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const { chromium } = require(process.env.HOME + "/Documents/ByteBox LLC/playwright/node_modules/playwright");

const SITE = process.env.SITE || "http://localhost:4898";
const FORK = process.env.FORK || "http://127.0.0.1:8547";
const ME = "0xc8Ef9472bB630d1Eb31CBeE25DE8d12d07710e0B";
const HOOK = "0x17DaD741593cEf7801c8C80c92Bb987766cA90C4";
const ROUTER = "0xe3047eab651c07333ec03beff9a4d191441c107a";
const KEY = "(0x7991b23378788C45F57809805aEA1a9C560113AD,0xF5A9f3D0bE7F0f82528a242cEA4C4A1f04Cd0C85,8388608,60,0x17DaD741593cEf7801c8C80c92Bb987766cA90C4)";
const POOL_ID = "0x1b0e290ef3fc17405aa3127b536ed4dd052b8c8406aa4ef135c18fe10291429c";
const W = 1920, H = 1080;
const OUT = path.join(__dirname, "raw");
const logo = "data:image/svg+xml;base64," + fs.readFileSync(path.join(__dirname, "..", "logo.svg")).toString("base64");
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=IBM+Plex+Mono:wght@400;500&family=Newsreader:ital,wght@1,400&display=swap" rel="stylesheet">`;

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function sqrtAt(t) { return BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, t)) * 2 ** 48)) * (2n ** 48n); }
function poolTick() {
  const slot = sh(`cast index bytes32 ${POOL_ID} 6`);
  const word = BigInt(sh(`cast storage 0x8366a39CC670B4001A1121B8F6A443A643e40951 ${slot} --rpc-url ${FORK}`));
  let t = Number((word >> 160n) & 0xffffffn); if (t >= 0x800000) t -= 0x1000000; return t;
}
function quote(zeroForOne) {
  const out = sh(`cast call ${HOOK} "quoteFee(bytes32,bool)(uint24,uint24)" ${POOL_ID} ${zeroForOne} --rpc-url ${FORK}`).split("\n")[0];
  return (Number(out.split(" ")[0]) / 10000).toFixed(2) + "%";
}
/** Swap through the demo router from ME (impersonated). Returns { ok, fee, hash|err }. */
function swap(zeroForOne, amount, limitTick) {
  const fee = quote(zeroForOne);
  const limit = limitTick === undefined ? (zeroForOne ? "4295128740" : "1461446703485210103287273052203988822378723970341") : sqrtAt(limitTick).toString();
  try {
    const out = sh(`cast send ${ROUTER} "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)" "${KEY}" "(${zeroForOne},-${amount},${limit})" "(false,false)" 0x --from ${ME} --unlocked --rpc-url ${FORK} --json`);
    const j = JSON.parse(out); return { ok: j.status === "0x1", fee, hash: j.transactionHash };
  } catch (e) {
    const m = String(e.stderr || e.message); return { ok: false, fee, err: /ClosedMarketMoveTooLarge|0x7a7ff9d1|WrappedError/.test(m) ? "ClosedMarketMoveTooLarge" : m.split("\n")[0].slice(0, 80) };
  }
}

const card = (inner) => `<!doctype html><html><head>${FONTS}<style>
  html,body{margin:0;height:100%;background:#0e0c09;color:#f1e8d6}
  .c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;text-align:center}
  .t{font:900 150px/0.9 "Big Shoulders Display",sans-serif;text-transform:uppercase}
  .s{font:italic 400 48px "Newsreader",serif;color:#e9a23b}
  .m{font:400 26px "IBM Plex Mono",monospace;color:#b9ae98;letter-spacing:.04em}
  img{width:220px;height:220px}
  .fade{animation:f .9s ease both}@keyframes f{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
</style></head><body><div class="c fade">${inner}</div></body></html>`;

const OVERLAY_CSS = `
  #gg-cap{position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:99999;max-width:1400px;background:rgba(14,12,9,.93);
    border:1px solid #332d23;border-left:6px solid #e9a23b;padding:22px 34px;font:500 34px/1.35 "IBM Plex Mono",monospace;color:#f1e8d6;
    box-shadow:0 20px 60px rgba(0,0,0,.6);transition:opacity .35s ease,transform .35s ease}
  #gg-cap.hide{opacity:0;transform:translate(-50%,12px)} #gg-cap b{color:#e9a23b;font-weight:500}
  #gg-tx{position:fixed;right:40px;top:110px;z-index:99998;width:560px;background:rgba(14,12,9,.95);border:1px solid #332d23;
    font:400 20px/1.5 "IBM Plex Mono",monospace;color:#b9ae98;box-shadow:0 20px 60px rgba(0,0,0,.6);transition:opacity .4s}
  #gg-tx.hide{opacity:0}
  #gg-tx h4{margin:0;padding:14px 20px;border-bottom:1px solid #332d23;font:500 16px "IBM Plex Mono",monospace;letter-spacing:.14em;color:#e9a23b;text-transform:uppercase}
  #gg-tx ol{list-style:none;margin:0;padding:8px 20px 14px}
  #gg-tx li{display:grid;grid-template-columns:1fr auto;gap:12px;padding:6px 0;border-bottom:1px dashed #1f1b15;animation:in .35s ease both}
  #gg-tx .ok{color:#7ee2a8} #gg-tx .bad{color:#ff6a45} #gg-tx .who{color:#f1e8d6}
  @keyframes in{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } } });
  // An EIP-6963 "MetaMask" that forwards to the anvil fork as the impersonated fee recipient.
  await ctx.addInitScript(([fork, me]) => {
    let id = 0;
    const rpc = async (method, params) => {
      const r = await fetch(fork, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params || [] }) });
      const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result;
    };
    const provider = {
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [me];
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        await new Promise((r) => setTimeout(r, 600)); // feel like a wallet confirm
        return rpc(method, params);
      },
      on() {}, removeListener() {},
    };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info: { uuid: "demo-mm", name: "MetaMask", rdns: "io.metamask", icon: "" }, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
  }, [FORK, ME]);
  const page = await ctx.newPage();

  // ---- title
  await page.setContent(card(`<img src="${logo}" alt=""><div class="t">Gapguard</div><div class="s">The market closes at four. The pool never does.</div><div class="m">Uniswap v4 hook · tokenized stocks · Robinhood Chain</div>`), { waitUntil: "networkidle" });
  await sleep(4000);

  // ---- site
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: OVERLAY_CSS + " html{scroll-behavior:auto!important}" });
  await page.evaluate(() => {
    const c = document.createElement("div"); c.id = "gg-cap"; c.className = "hide"; document.body.appendChild(c);
    const t = document.createElement("div"); t.id = "gg-tx"; t.className = "hide"; t.innerHTML = "<h4>Swaps · Robinhood Chain fork · market closed</h4><ol></ol>"; document.body.appendChild(t);
  });
  const caption = async (html) => { await page.evaluate((h) => { const c = document.getElementById("gg-cap"); c.classList.add("hide"); setTimeout(() => { c.innerHTML = h; c.classList.remove("hide"); }, 350); }, html); await sleep(400); };
  const hideCaption = () => page.evaluate(() => document.getElementById("gg-cap").classList.add("hide"));
  const txPanel = (show) => page.evaluate((s) => document.getElementById("gg-tx").classList.toggle("hide", !s), show);
  const txLog = (who, result, cls) => page.evaluate(([w, r, c]) => { const li = document.createElement("li"); li.innerHTML = `<span class="who">${w}</span><span class="${c}">${r}</span>`; document.querySelector("#gg-tx ol").appendChild(li); }, [who, result, cls]);
  const glide = async (selector, offset = 90, ms = 1400) => {
    await page.evaluate(async ([sel, off, dur]) => {
      const el = document.querySelector(sel); if (!el) return;
      const start = scrollY, end = el.getBoundingClientRect().top + scrollY - off, t0 = performance.now();
      await new Promise((res) => { const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; scrollTo(0, start + (end - start) * e); k < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); });
    }, [selector, offset, ms]);
    await sleep(300);
  };
  const slide = async (selector, from, to, ms) => { for (let i = 0; i <= 40; i++) { await page.evaluate(([sel, v]) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, [selector, Math.round(from + (to - from) * i / 40)]); await sleep(ms / 40); } };

  await sleep(1000);
  await caption("Tokenized stocks trade <b>24/7</b>. The real market closes at <b>4pm</b> — and nothing prices the gap.");
  await sleep(4500);
  await glide(".story", 60);
  await caption("Aug 2026: the HIMS wrapper hit <b>$61.15</b> vs a <b>$28.84</b> close. LPs carried it for free.");
  await sleep(5000);

  // ---- the hook in action
  await glide("#live", 30);
  await caption("Watch the deployed hook work — a fork of <b>Robinhood Chain mainnet</b>, on a Saturday.");
  await txPanel(true);
  await sleep(3500);
  await caption("Each buy pushes the price <b>away</b> from Friday's close — so each one pays more.");
  let t = poolTick();
  for (let i = 1; i <= 4; i++) {
    const r = swap(false, "80000000000000000000", t + 95);
    await txLog(`buy #${i} · 80 gUSD`, r.ok ? `fee ${r.fee} ✓` : r.err, r.ok ? "ok" : "bad");
    t = poolTick();
    await sleep(2600);
  }
  await caption("Try to reprice in one big swap? <b>Reverted</b> — one swap can move at most ~1% while closed.");
  const big = swap(false, "600000000000000000000");
  await txLog("buy · 600 gUSD (≈6%)", big.ok ? `fee ${big.fee}` : "reverted: move > 1%", big.ok ? "ok" : "bad");
  await sleep(4200);
  await caption("Selling back <b>toward</b> the close restores the peg — so it stays cheap.");
  const sell = swap(true, "30000000000000000000");
  await txLog("sell · 30 gSTOCK", sell.ok ? `fee ${sell.fee} ✓` : sell.err, sell.ok ? "ok" : "bad");
  await sleep(4500);

  // ---- revenue + collect
  await txPanel(false);
  await glide("#rev", 260);
  await caption("The hook keeps <b>15%</b> of the surcharge. One button collects it — to fixed recipients only.");
  await sleep(3500);
  await page.click("#revCollect");
  await page.waitForFunction(() => /Nothing to collect/i.test(document.getElementById("revCollect").textContent) || document.querySelector("#revLog [data-s=err]"), null, { timeout: 60000 }).catch(() => {});
  await sleep(3500);

  // ---- mechanics + proof
  await hideCaption();
  await glide("#drift", 380);
  await caption("The drift fee grows with distance from the last close, up to a cap.");
  await slide("#drift", 0, 2400, 4500);
  await sleep(1200);
  await glide("#replay", 40);
  await caption("Replaying the HIMS weekend on-chain: LPs earn <b>12.7×</b> more.");
  await slide("#scrub", 1, 30, 4500);
  await sleep(1800);
  await glide("#safety", 40);
  await caption("Live on mainnet. No owner, no admin, no upgrade. Three security reviews, 39 tests.");
  await sleep(5000);

  // ---- end
  await page.setContent(card(`<img src="${logo}" alt=""><div class="t">Gapguard</div><div class="m">gapguard-one.vercel.app</div><div class="m">github.com/Bytethebuilder/gapguard</div><div class="m">Hook · 0x17DaD741593cEf7801c8C80c92Bb987766cA90C4</div>`), { waitUntil: "networkidle" });
  await sleep(5000);

  const video = page.video();
  await ctx.close(); await browser.close();
  console.log(await video.path());
})().catch((e) => { console.error(e); process.exit(1); });
