/* Is the toll plaza's lag spike a shader compile?

   The plaza draws LESS than open road — fewer calls, fewer triangles, lower
   median frame time — and still spikes. What it also does is link ~10 new
   shader programs the moment it comes into view, and linking a program is a
   synchronous stall.

   This measures that directly, and its whole design is the one cheap test
   that separates a compile stall from everything else: ARRIVE AT THE PLAZA
   TWICE. A compile stall happens on the first arrival and cannot happen on
   the second, because the programs are cached by then. Any cost that is
   really about drawing the plaza — lighting, overdraw, geometry — is there
   both times. So:

     first arrival much worse than second  -> compile stall
     both arrivals equally bad             -> a real draw cost, look elsewhere

   `programs` is the corroborating number: how many shader programs the
   renderer holds. A jump across the first arrival and none across the second
   is the same story told a second way.

   Run against a build with the pre-warm and one without, and the fix is
   working when the FIRST arrival stops being the outlier.

   Usage: node test/toll-hitch.mjs --url http://localhost:3000 --label main
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3000");
const LABEL = arg("--label", "run");
const OUT = arg("--out", `/tmp/toll-hitch-${LABEL}.json`);
const FRAMES = Number(arg("--frames", 40));

const AWAY = 400;   // open deck, nothing of the plaza in view
const PLAZA = 1420; // under the canopy

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 1280, height: 800 },
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
await sleep(12000); // async props and the HD fleet — they must be IN before we start
await page.evaluate(() => window.__neonx.setTime(22.0));
await sleep(2000);

const programs = () =>
  page.evaluate(() => window.__neonx.game.renderer?.info?.programs?.length ?? null);

/* Chunked sampling: a SwiftShader frame can take seconds, and one evaluate()
   spanning every frame blows puppeteer's protocolTimeout. */
async function sample(frames) {
  const dt = [];
  for (let got = 0; got < frames; got += 10) {
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
    }, Math.min(10, frames - got));
    dt.push(...part);
  }
  const s = dt.slice().sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { med: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
}

const go = (z) => page.evaluate((z) => {
  window.__neonx.toCorridor(z, 90, 1);
  window.__neonx.setInput({ th: 0.35 });
}, z);

const rows = [];
/* Sampling starts IMMEDIATELY after the teleport, with no settle — the stall
   is in the first frames or it is nowhere, and a settle would sleep straight
   through the thing being measured.

   Each pass measures the plaza AND a control sample of the same length on the
   open deck. The control exists because the first version of this test did
   not have one and produced a result I could not read: programs kept being
   created on the SECOND arrival too (+10, then +30), which looks like the
   compile story failing — but the game also upgrades its photo-scan textures
   on a timer after load, and every such upgrade relinks the materials it
   touches. Without a control, programs growing while at the plaza and
   programs growing simply because time passed are the same measurement. With one, the
   plaza's share is the DIFFERENCE. */
for (const pass of [1, 2]) {
  await go(AWAY);
  await sleep(4000);
  const ctlBefore = await programs();
  const away = await sample(FRAMES);
  const ctlAfter = await programs();

  const before = await programs();
  await go(PLAZA);
  const arrive = await sample(FRAMES);
  const after = await programs();

  rows.push({ pass, ...arrive, programsBefore: before, programsAfter: after,
              newPrograms: after - before,
              awayMed: away.med, awayP95: away.p95,
              awayPrograms: ctlAfter - ctlBefore });
  console.log(
    `pass ${pass}  open deck: p95 ${String(away.p95).padStart(8)}  +${ctlAfter - ctlBefore} programs`
  );
  console.log(
    `        plaza:     p95 ${String(arrive.p95).padStart(8)}  +${after - before} programs` +
    `   (med ${arrive.med}, max ${arrive.max})`
  );
}

const [a, b] = rows;
console.log(`\n${LABEL}`);
console.log(`  plaza p95, first vs second arrival: ${(a.p95 / b.p95).toFixed(2)}x`);
console.log(`  programs at the plaza:    +${a.newPrograms} then +${b.newPrograms}`);
console.log(`  programs on the open deck: +${a.awayPrograms} then +${b.awayPrograms}  <- the control`);
const plazaOnly = (a.newPrograms + b.newPrograms) - (a.awayPrograms + b.awayPrograms);
console.log(plazaOnly > 0
  ? `  => ${plazaOnly} programs are attributable to the plaza rather than to elapsed time.`
  : "  => the plaza links no more programs than sitting still does; the growth is time-based (the photo-scan upgrade), not the plaza.");

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ label: LABEL, url: URL, rows }, null, 2));
console.log("wrote", OUT);
await browser.close();
