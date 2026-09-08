/* WHAT links shader programs mid-drive, and where.

   Three probes have now blamed three different places for the same symptom —
   a stutter a few seconds into driving, with a burst of new shader programs
   beside it — and the attribution has been an inference every time. This
   stops inferring. three keeps `renderer.info.programs`, and every entry
   carries the `cacheKey` it was built from: the shader name and the full
   define list. Diff that list across a drive and the new programs NAME
   THEMSELVES.

   It drives the whole lap in steps rather than sitting still, because the
   thing being hunted is content that links when it first comes into view, and
   sitting still is exactly what hides it.

   Usage: node test/program-source.mjs --url http://localhost:3101
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3000");
const LABEL = arg("--label", "run");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts", `program-source-${LABEL}.json`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 1024, height: 576 },
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

const snap = () => page.evaluate(() => {
  const r = window.__neonx.game.renderer;
  return (r.info.programs ?? []).map((p) => p.cacheKey || p.name || "?");
});

let prev = await snap();
console.log(`at load: ${prev.length} programs`);
const rows = [];
/* Named stops around the lap, plus a camera cycle at the end: each is a place
   the earlier probes reported a spike. */
const STOPS = [
  ["settle (no move)", null], ["open deck", 400], ["tunnel", 1090],
  ["toll approach", 1330], ["toll plaza", 1420], ["past toll", 1520],
  ["town", 2400], ["mountain gore", -1990],
];
for (const [name, z] of STOPS) {
  if (z !== null) await page.evaluate((z) => {
    window.__neonx.toCorridor(z, 90, 1);
    window.__neonx.setInput({ th: 0.3 });
  }, z);
  await sleep(16000);
  const now = await snap();
  const set = new Set(prev);
  const added = now.filter((k) => !set.has(k));
  rows.push({ place: name, total: now.length, added: added.length, keys: added.slice(0, 6) });
  console.log(`${name.padEnd(18)} total ${String(now.length).padStart(4)}  +${added.length}`);
  /* A cacheKey is the shader name followed by every define; the leading token
     is the part a human can read, so print that and keep the rest in the json */
  for (const k of added.slice(0, 6)) console.log("      ", String(k).slice(0, 110));
  prev = now;
}
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ label: LABEL, rows }, null, 2));
console.log("wrote", OUT);
await browser.close();
