/* ENDLESS MODE captures — the HUD panel, the crash reset, and the phone.

   One game frame per viewport, photographed with the mode off and on so the
   two can be judged against each other rather than across two drives:

     (a) OFF   free-roam, exactly as today — the panel is not on screen
     (b) ON    run score in metres, personal best, the bank
     (c) CRASH mid-settle: the score knocked out and coming back to 0

   The top strip is cropped FULL WIDTH on purpose: the question a reviewer
   has about a new HUD element is what it collides with, and the strip shows
   the panel, the centre clock and the pause gear in one line.

   Usage: node test/endless-shots.mjs --url http://localhost:3153 \
            --out /path/to/dir [--tier mobile-base] */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3153");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts"));
const TIER = arg("--tier", "");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1440x900", w: 1440, h: 900, touch: false },
  { name: "390x844", w: 390, h: 844, touch: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clickBtn = (page, label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(l));
    if (!b) throw new Error("no button " + l);
    b.click();
  }, label);

async function shoot(browser, vp) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  pageerror:", String(e.message || e)));
  await page.setViewport({
    width: vp.w, height: vp.h, deviceScaleFactor: 2,
    hasTouch: vp.touch, isMobile: vp.touch,
  });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.clear(); } catch {}
  });
  console.log(`-> ${vp.name}: loading`);
  await page.goto(debugUrl(URL, TIER ? { tier: TIER } : {}), {
    waitUntil: "domcontentloaded", timeout: 600000,
  });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
  await clickBtn(page, "DRIVE");
  await page.waitForFunction(() => window.__neonx?.game?.loaded, {
    timeout: 2400000, polling: 5000,
  });
  console.log(`   ${vp.name}: world loaded`);
  await sleep(2500);

  // a lit night frame with traffic ahead, at a speed worth reading
  await page.evaluate(() => {
    const nx = window.__neonx;
    nx.setTime(21.4);
    nx.setCam(3); // CAM_POV — the frame visual changes are judged in first
    nx.toCorridor(900, 148);
    nx.setInput({ th: 0.55 });
  });
  await sleep(3500);

  const shots = {};
  const grab = async (key, wait = 1400) => {
    await sleep(wait);
    shots[key] = await page.screenshot({ encoding: "base64" });
  };

  // (a) OFF — free-roam as it ships today
  await page.evaluate(() => window.__neonx.setEndless(false));
  await grab("off");

  // (b) ON — a run worth keeping, a best it has not beaten, a real bank
  await page.evaluate(() => {
    const nx = window.__neonx;
    nx.setEndless(true);
    nx.setCleanRun(4820);
    nx.game.ez.best = 11840;
    nx.setMoney(18430);
  });
  await grab("on");

  /* (c) THE CRASH, caught mid-settle. The reset animation is 1.8 s, which a
     screenshot on SwiftShader can easily outlast, so FOR THE SHOT ONLY it is
     stretched and started part-way in — the shipped keyframes are untouched
     and the style is pulled straight back off. */
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.id = "ezSlow";
    st.textContent =
      "#ezHud.ez-reset .ez-run{animation-duration:70s!important;animation-delay:-9s!important}";
    document.head.appendChild(st);
    window.__neonx.runReset();
  });
  await grab("crash");
  await page.evaluate(() => document.getElementById("ezSlow")?.remove());

  await page.close();
  return shots;
}

/* Compose with the browser itself — no image library, and the labels come out
   in the same face the game uses. */
async function compose(browser, vp, shots) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w + 40, height: 1400, deviceScaleFactor: 1 });
  await page.goto("about:blank");

  // full-width top strip: the panel, the clock and the gear in one line
  const crop = { x: 0, y: 0, w: vp.w, h: vp.touch ? 200 : 230 };
  const panels = [
    ["(a) OFF — free-roam, unchanged: no panel", shots.off],
    ["(b) ON — run metres · BEST · bank", shots.on],
    ["(c) CRASH — the score knocked out, settling back to 0 (bank untouched)", shots.crash],
  ];

  const html = `
<style>
  body { margin:0; background:#0b0e18; font-family: ui-monospace, Menlo, monospace; }
  .p { padding: 10px 14px 14px; }
  .lbl { color:#cfe0ff; font-size:13px; padding-bottom:6px; }
  .shot { width:${crop.w}px; height:${crop.h}px; overflow:hidden; position:relative;
          border:1px solid #26304a; }
  .shot img { position:absolute; left:${-crop.x}px; top:${-crop.y}px;
              width:${vp.w}px; height:${vp.h}px; }
  .hd { color:#8fa6d8; font-size:12px; padding:12px 14px 0; letter-spacing:0.08em; }
</style>
<div id="wrap">
  <div class="hd">FLOORED · ENDLESS MODE HUD · ${vp.name} · dashcam (CAM_POV)</div>
  ${panels
    .map(([lbl, b64]) => `<div class="p"><div class="lbl">${lbl}</div>
      <div class="shot"><img src="data:image/png;base64,${b64}"></div></div>`)
    .join("")}
</div>`;
  await page.setContent(html, { waitUntil: "load" });
  const el = await page.$("#wrap");
  const buf = await el.screenshot();
  writeFileSync(path.join(OUT, `endless-hud-${vp.name}.png`), buf);
  console.log("   wrote", `endless-hud-${vp.name}.png`);
  await page.close();
}

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 3000000,
});
for (const vp of VIEWPORTS) {
  const shots = await shoot(browser, vp);
  // whole frames too — a crop alone hides what the rest of the frame did
  for (const [k, b64] of Object.entries(shots)) {
    writeFileSync(path.join(OUT, `endless-${vp.name}-${k}.png`), Buffer.from(b64, "base64"));
  }
  await compose(browser, vp, shots);
}
await browser.close();
console.log("done ->", OUT);
