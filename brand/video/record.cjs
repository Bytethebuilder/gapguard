// Records the Gapguard demo video: title card → guided tour of the live site with captions → end card.
//   node brand/video/record.cjs   (then ffmpeg → demo.mp4, see make.sh)
const path = require("path");
const fs = require("fs");
const { chromium } = require(process.env.HOME + "/Documents/ByteBox LLC/playwright/node_modules/playwright");

const SITE = "https://gapguard-one.vercel.app";
const W = 1920, H = 1080;
const OUT = path.join(__dirname, "raw");
const logo = "data:image/svg+xml;base64," + fs.readFileSync(path.join(__dirname, "..", "logo.svg")).toString("base64");
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=IBM+Plex+Mono:wght@400;500&family=Newsreader:ital,wght@1,400&display=swap" rel="stylesheet">`;

const card = (inner) => `<!doctype html><html><head>${FONTS}<style>
  html,body{margin:0;height:100%;background:#0e0c09;color:#f1e8d6}
  .c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;text-align:center}
  .t{font:900 150px/0.9 "Big Shoulders Display",sans-serif;letter-spacing:.01em;text-transform:uppercase}
  .s{font:italic 400 48px "Newsreader",serif;color:#e9a23b}
  .m{font:400 26px "IBM Plex Mono",monospace;color:#b9ae98;letter-spacing:.04em}
  img{width:220px;height:220px}
  .fade{animation:f .9s ease both}@keyframes f{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
</style></head><body><div class="c fade">${inner}</div></body></html>`;

const CAPTION_CSS = `
  #gg-cap{position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:99999;max-width:1400px;
    background:rgba(14,12,9,.92);border:1px solid #332d23;border-left:6px solid #e9a23b;padding:22px 34px;
    font:500 34px/1.35 "IBM Plex Mono",monospace;color:#f1e8d6;box-shadow:0 20px 60px rgba(0,0,0,.6);
    transition:opacity .35s ease, transform .35s ease}
  #gg-cap.hide{opacity:0;transform:translate(-50%,12px)}
  #gg-cap b{color:#e9a23b;font-weight:500}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } } });
  // Headless has no wallet extension: announce a placeholder MetaMask (EIP-6963) so the collect button
  // renders as it does for a real user. It is never clicked.
  await ctx.addInitScript(() => {
    const provider = { request: async () => { throw new Error("demo placeholder"); }, on() {}, removeListener() {} };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info: { uuid: "demo-mm", name: "MetaMask", rdns: "io.metamask", icon: "" }, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
  });
  const page = await ctx.newPage();

  // 1 — title card
  await page.setContent(card(`<img src="${logo}" alt=""><div class="t">Gapguard</div><div class="s">The market closes at four. The pool never does.</div><div class="m">A Uniswap v4 hook for tokenized stocks · Robinhood Chain</div>`), { waitUntil: "networkidle" });
  await sleep(4500);

  // 2 — the site
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: CAPTION_CSS + " html{scroll-behavior:auto!important}" });
  await page.evaluate(() => { const d = document.createElement("div"); d.id = "gg-cap"; d.className = "hide"; document.body.appendChild(d); });
  const caption = async (html) => {
    await page.evaluate((h) => { const c = document.getElementById("gg-cap"); c.classList.add("hide"); setTimeout(() => { c.innerHTML = h; c.classList.remove("hide"); }, 350); }, html);
    await sleep(400);
  };
  const glide = async (selector, offset = 90, ms = 1400) => {
    await page.evaluate(async ([sel, off, dur]) => {
      const el = document.querySelector(sel); if (!el) return;
      const start = scrollY, end = el.getBoundingClientRect().top + scrollY - off, t0 = performance.now();
      await new Promise((res) => { const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; scrollTo(0, start + (end - start) * e); k < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); });
    }, [selector, offset, ms]);
    await sleep(300);
  };
  const slide = async (selector, from, to, ms) => {
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      await page.evaluate(([sel, v]) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, [selector, Math.round(from + (to - from) * i / steps)]);
      await sleep(ms / steps);
    }
  };

  await sleep(1200);
  await caption("Tokenized stocks trade <b>24/7</b>. The real stock market closes at <b>4pm</b>.");
  await sleep(5200);

  await glide(".story", 60);
  await caption("Aug 29–31, 2026: the HIMS wrapper hit <b>$61.15</b> vs a <b>$28.84</b> close — and no pool priced the closed market.");
  await sleep(6800);

  await glide("#live", 40);
  await caption("Live on <b>Robinhood Chain mainnet</b> — every number here is read from the hook.");
  await sleep(6500);

  await glide("#rev", 260);
  await caption("The hook keeps <b>15%</b> of the surcharge. One button collects it — to fixed recipients only.");
  await sleep(6000);

  await glide("#how", 40);
  await caption("Base fee while NYSE is open. While it's closed, swaps pay for the <b>gap risk</b> they create.");
  await sleep(6500);

  await glide("#drift", 380);
  await caption("Pushing price <b>away</b> from the last close costs more the further it goes. Restoring the peg stays cheap.");
  await slide("#drift", 0, 2400, 5000);
  await sleep(1500);

  await glide("#replay", 40);
  await caption("Same weekend, replayed on-chain: LPs earn <b>12.7×</b> more for carrying the gap.");
  await slide("#scrub", 1, 30, 5000);
  await sleep(2000);

  await glide("#safety", 40);
  await caption("No owner. No admin. No upgrade. Reviewed adversarially <b>three times</b>, 39 tests.");
  await sleep(6000);

  // 3 — end card
  await page.setContent(card(`<img src="${logo}" alt=""><div class="t">Gapguard</div><div class="m">gapguard-one.vercel.app</div><div class="m">github.com/Bytethebuilder/gapguard</div><div class="m">Hook · 0x17DaD741593cEf7801c8C80c92Bb987766cA90C4</div>`), { waitUntil: "networkidle" });
  await sleep(5500);

  const video = page.video();
  await ctx.close();
  await browser.close();
  console.log(await video.path());
})().catch((e) => { console.error(e); process.exit(1); });
