/* Is the first camera switch's hitch a shader compile?

   Owner: "the camera when i press camera to change camera mode it lags only
   on the first time tho."

   "Only the first time" is the signature of a one-off cost, and the cheapest
   way to prove which one is the same trick test/toll-hitch.mjs uses: DO IT
   TWICE. A program link can only stall the first time a mode is entered,
   because the program is cached afterwards. Anything that is really about
   drawing that camera's view — the dashcam's degrade chain, the cockpit
   interior, the extra passes — costs the same on both passes.

     first cycle much worse than second  -> compile stall
     both cycles equally bad             -> a real draw cost, look elsewhere

   `renderer.info.programs.length` is the corroborating number, and it needs a
   CONTROL: the game keeps relinking materials on a timer after load (the
   photo-scan texture upgrade), so "programs grew while I switched camera" and
   "programs grew because time passed" are the same measurement without one.
   Each mode therefore gets a control sample of the same length in the mode it
   is already in, immediately before the switch. The camera's share is the
   difference.

   Usage: node test/cam-hitch.mjs --url http://localhost:3703 --label before
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3703");
const LABEL = arg("--label", "run");
const OUT = arg("--out", `/tmp/cam-hitch-${LABEL}.json`);
const FRAMES = Number(arg("--frames", 8));

// cycle order from engine.ts CAM_CYCLE, and the names indexed by camMode
const CAM_CYCLE = [0, 1, 2, 4, 5, 3];
const CAM_NAMES = ["CHASE", "COCKPIT", "HOOD", "DASHCAM", "CONSOLE", "BACKSEAT"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 960, height: 600 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(12000); // async props and the HD fleet must be IN before we start
await page.evaluate(() => window.__neonx.setTime(22.0));
await sleep(2000);

const programs = () =>
  page.evaluate(() => window.__neonx.game.renderer?.info?.programs?.length ?? null);

/* Chunked sampling: one SwiftShader frame can take seconds, and a single
   evaluate() spanning every frame blows puppeteer's protocolTimeout. */
async function sample(frames) {
  const dt = [];
  for (let got = 0; got < frames; got += 4) {
    const part = await page.evaluate(async (n) => {
      const out = [];
      await new Promise((resolve) => {
        let last = -1, i = 0;
        const tick = (t) => {
          if (last >= 0) out.push(t - last);
          last = t;
          if (++i > n) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return out;
    }, Math.min(4, frames - got));
    dt.push(...part);
  }
  const s = dt.slice().sort((a, b) => a - b);
  return { med: +s[Math.floor(s.length / 2)].toFixed(1), max: +s[s.length - 1].toFixed(1) };
}

// a settled, repeatable spot: open deck, rolling
await page.evaluate(() => {
  window.__neonx.toCorridor(400, 90, 1);
  window.__neonx.setInput({ th: 0.3 });
  window.__neonx.setCam(3); // start where the game ships: the dashcam
});
await sleep(4000);

const rows = [];
for (const pass of [1, 2]) {
  for (const mode of CAM_CYCLE) {
    // control: the same number of frames, in the mode we are already in
    const cBefore = await programs();
    const ctl = await sample(FRAMES);
    const cAfter = await programs();

    // the switch, sampled IMMEDIATELY — no settle, the stall is in frame 1
    const before = await programs();
    await page.evaluate((m) => window.__neonx.setCam(m), mode);
    const sw = await sample(FRAMES);
    const after = await programs();

    rows.push({
      pass, mode, name: CAM_NAMES[mode],
      max: sw.max, med: sw.med, newPrograms: after - before,
      ctlMax: ctl.max, ctlMed: ctl.med, ctlPrograms: cAfter - cBefore,
    });
    console.log(
      `pass ${pass}  ${CAM_NAMES[mode].padEnd(8)} switch max ${String(sw.max).padStart(8)} ` +
      `(+${after - before} programs)   control max ${String(ctl.max).padStart(8)} ` +
      `(+${cAfter - cBefore})`
    );
  }
}

console.log(`\n${LABEL}`);
let firstProg = 0, secondProg = 0, firstCtl = 0, secondCtl = 0;
for (const r of rows) {
  if (r.pass === 1) { firstProg += r.newPrograms; firstCtl += r.ctlPrograms; }
  else { secondProg += r.newPrograms; secondCtl += r.ctlPrograms; }
}
const worst = (p) => Math.max(...rows.filter((r) => r.pass === p).map((r) => r.max));
const worstCtl = (p) => Math.max(...rows.filter((r) => r.pass === p).map((r) => r.ctlMax));
console.log(`  worst switch frame, cycle 1 vs 2:  ${worst(1)} ms vs ${worst(2)} ms  ` +
            `(${(worst(1) / worst(2)).toFixed(2)}x)`);
console.log(`  worst control frame, cycle 1 vs 2: ${worstCtl(1)} ms vs ${worstCtl(2)} ms  <- no switch`);
console.log(`  programs linked across switches:   +${firstProg} then +${secondProg}`);
console.log(`  programs linked across controls:   +${firstCtl} then +${secondCtl}  <- the control`);
const camOnly = (firstProg + secondProg) - (firstCtl + secondCtl);
console.log(camOnly > 0
  ? `  => ${camOnly} programs are attributable to switching camera rather than to elapsed time.`
  : "  => switching camera links no more programs than sitting still does.");

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ label: LABEL, url: URL, frames: FRAMES, rows }, null, 2));
console.log("wrote", OUT);
await browser.close();
