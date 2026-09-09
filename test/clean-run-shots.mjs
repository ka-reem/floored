/* HUD treatment shots for the clean-run readout.

   Renders ONE game frame and photographs the bottom-left HUD corner three
   times off it — once per treatment (corner / speed / ghost, see RUN_HUD in
   game/engine.ts) — plus a BEFORE frame carrying the retired No Hesi score,
   reconstructed in the DOM so the "not in your face" change can be judged on
   the same frame rather than across two drives.

   Output (per viewport): three cropped, labelled HUD panels stacked into one
   image, and a before/after pair of the whole frame.

   Usage: node test/clean-run-shots.mjs --url http://localhost:3153 \
            --out /path/to/dir [--vp 1440x900] */

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
/* Render tier. Empty = let the page decide (desktop here), which is the frame
   the owner actually judges; --tier mobile-base is the escape hatch when the
   box is too loaded to build the full world. */
const TIER = arg("--tier", "");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1440x900", w: 1440, h: 900, touch: false },
  { name: "390x844", w: 390, h: 844, touch: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clickBtn = (page, label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      x.textContent.includes(l)
    );
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
  /* Fresh profile without a second navigation — the app boot is the whole
     cost on a loaded box, and a clear-then-reload pays it twice. */
  await page.evaluateOnNewDocument(() => {
    try { localStorage.clear(); } catch {}
  });
  console.log(`-> ${vp.name}: loading`);
  await page.goto(debugUrl(URL, TIER ? { tier: TIER } : {}), {
    waitUntil: "domcontentloaded", timeout: 600000,
  });
  console.log(`   ${vp.name}: page served`);
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
    nx.setCam(3); // CAM_POV — the default and the frame to judge in
    nx.toCorridor(900, 148);
    nx.setInput({ th: 0.55 });
    nx.setCleanRun(11840); // 7.4 mi / 11.8 km — a run worth keeping
  });
  await sleep(3500);

  const shots = {};
  const grab = async (key) => {
    await sleep(1400);
    shots[key] = await page.screenshot({ encoding: "base64" });
  };

  for (const t of ["corner", "speed"]) {
    await page.evaluate((m) => window.__neonx.setRunHud(m), t);
    await grab(t);
  }

  /* GHOST, twice: at rest (an empty corner — which is the whole point of the
     treatment) and while it is on screen. The blip is a 2.6 s fade, shorter
     than SwiftShader can reliably be caught inside, so FOR THE SHOT ONLY it
     is stretched to 8 s and the figure is then changed; the style is pulled
     straight back off. Nothing about the shipped animation changes. */
  await page.evaluate(() => window.__neonx.setRunHud("ghost"));
  await grab("ghostRest");
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.id = "ghostSlow";
    /* Stretch the fade AND start it 8 s in, so the readout is already at its
       plateau opacity the moment the style lands and stays there for half a
       minute — a headless screenshot on SwiftShader can take several seconds
       to come back, which is longer than the real 2.6 s blip. */
    st.textContent =
      '#hud[data-run="ghost"] .runDist.run-blip{' +
      "animation-duration:60s!important;animation-delay:-8s!important}";
    document.head.appendChild(st);
    window.__neonx.setCleanRun(11840 + 170);
  });
  await grab("ghost");
  await page.evaluate(() => document.getElementById("ghostSlow")?.remove());

  // the reset moment, on the recommended treatment
  await page.evaluate(() => {
    window.__neonx.setRunHud("corner");
    window.__neonx.setCleanRun(11840);
  });
  await sleep(900);
  await page.evaluate(() => window.__neonx.runReset());
  /* mid-settle: the figure is at its dimmest early in runReset and back to
     its resting opacity at the end, so this catches it on the way back up,
     reading 0.0 and still visibly quieter than normal. */
  await sleep(1150);
  shots.reset = await page.screenshot({ encoding: "base64" });

  // AFTER = the recommended treatment, whole frame
  await page.evaluate(() => {
    window.__neonx.setRunHud("corner");
    window.__neonx.setCleanRun(11840);
  });
  await grab("after");

  /* BEFORE = today's No Hesi readout, rebuilt in the DOM on this same frame:
     the old element sat in the same corner, on the display face at 14px and
     full --ink-dim, and carried the running points total and the ×N combo. */
  await page.evaluate(() => {
    const hud = document.getElementById("hud");
    document.getElementById("runDist").style.display = "none";
    const el = document.createElement("div");
    el.id = "oldNoHesi";
    el.textContent = "184320 ×4.6";
    el.style.cssText =
      "order:4;font-family:var(--font-display);font-size:14px;" +
      "font-variant-numeric:tabular-nums;color:var(--accent-2);" +
      "text-shadow:0 0 12px var(--accent-glow);margin-top:4px;letter-spacing:0.04em";
    hud.appendChild(el);
  });
  await grab("before");

  await page.close();
  return shots;
}

/* Compose the panels with the browser itself: one page, data: URIs, canvas —
   no image library, and the labels come out in the same face the game uses. */
async function compose(browser, vp, shots) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1200, deviceScaleFactor: 1 });
  await page.goto("about:blank");

  /* HUD crop, in CSS pixels of the shot: the bottom-left corner, generously
     sized so the whole stack (speed + gear + readout) is legible. */
  const crop = vp.touch
    ? { x: 0, y: vp.h - 320, w: 300, h: 300 }
    : { x: 0, y: vp.h - 250, w: 520, h: 240 };

  const panels = [
    ["(a) CORNER — small dim figure under the gear   [RECOMMENDED / default]", shots.corner],
    ["(b) SPEED BLOCK — second line under the speedo", shots.speed],
    ["(c) GHOST — at rest: nothing there at all", shots.ghostRest],
    ["(c) GHOST — and the moment it appears (the figure changed)", shots.ghost],
    ["    a run ending on (a): the figure dims and settles back to 0.0", shots.reset],
  ];

  const html = `
<style>
  body { margin:0; background:#0b0e18; font-family: ui-monospace, Menlo, monospace; }
  .wrap { width: ${Math.max(crop.w * 2, 700)}px; }
  .p { padding: 10px 14px 14px; }
  .lbl { color:#cfe0ff; font-size:13px; letter-spacing:0.02em; padding-bottom:6px; }
  .shot { width:${crop.w * 2}px; height:${crop.h * 2}px; overflow:hidden; position:relative;
          border:1px solid #26304a; }
  .shot img { position:absolute; left:${-crop.x * 2}px; top:${-crop.y * 2}px; }
  .hd { color:#8fa6d8; font-size:12px; padding:12px 14px 0; letter-spacing:0.08em; }
</style>
<div class="wrap" id="wrap">
  <div class="hd">FLOORED · CLEAN-RUN HUD TREATMENTS · ${vp.name} · dashcam (CAM_POV)</div>
  ${panels
    .map(
      ([lbl, b64]) => `<div class="p"><div class="lbl">${lbl}</div>
        <div class="shot"><img src="data:image/png;base64,${b64}"></div></div>`
    )
    .join("")}
</div>`;
  await page.setContent(html, { waitUntil: "load" });
  const wrap = await page.$("#wrap");
  const buf = await wrap.screenshot();
  writeFileSync(path.join(OUT, `hud-treatments-${vp.name}.png`), buf);

  // before / after, whole frame, stacked
  const html2 = `
<style>
  body { margin:0; background:#0b0e18; font-family: ui-monospace, Menlo, monospace; }
  .wrap { width:${vp.w}px; }
  .lbl { color:#cfe0ff; font-size:13px; padding:10px 14px 6px; letter-spacing:0.02em; }
  img { width:${vp.w}px; display:block; }
</style>
<div class="wrap" id="wrap">
  <div class="lbl">BEFORE — No Hesi score: points + ×combo, accent-lit, ${vp.name}</div>
  <img src="data:image/png;base64,${shots.before}">
  <div class="lbl">AFTER — clean run: 7.4 mi, 11px, half opacity, no glow</div>
  <img src="data:image/png;base64,${shots.after}">
</div>`;
  await page.setContent(html2, { waitUntil: "load" });
  const wrap2 = await page.$("#wrap");
  writeFileSync(
    path.join(OUT, `hud-before-after-${vp.name}.png`),
    await wrap2.screenshot()
  );
  await page.close();
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    ],
    protocolTimeout: 3000000,
  });
  const only = arg("--vp", null);
  for (const vp of VIEWPORTS) {
    if (only && vp.name !== only) continue;
    const shots = await shoot(browser, vp);
    await compose(browser, vp, shots);
    console.log(`   wrote hud-treatments-${vp.name}.png + hud-before-after-${vp.name}.png`);
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
