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

/* Programs are only one of the three things that stall a frame the first time
   a place is drawn. A TEXTURE uploads on first use, and a big one is a
   synchronous copy across the bus that no program count will ever show; a
   GEOMETRY uploads its buffers the same way. The first version of this probe
   counted only programs, found the toll plaza links none, and would have
   closed the case on a stutter that was never about shaders. */
const snap = () => page.evaluate(() => {
  const r = window.__neonx.game.renderer;
  return {
    keys: (r.info.programs ?? []).map((p) => p.cacheKey || p.name || "?"),
    textures: r.info.memory?.textures ?? 0,
    geometries: r.info.memory?.geometries ?? 0,
  };
});

/* A short frame-time sample, so a place that uploads something expensive is
   visible as a slow frame and not only as a counter moving. */
const frames = (n = 8) => page.evaluate(async (n) => {
  const dt = [];
  await new Promise((resolve) => {
    let last = -1, i = 0;
    const tick = (t) => {
      if (last >= 0) dt.push(t - last);
      last = t;
      if (++i > n) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  dt.sort((a, b) => a - b);
  return { med: +dt[dt.length >> 1].toFixed(0), max: +dt[dt.length - 1].toFixed(0) };
}, n);

let prev = await snap();
console.log(`at load: ${prev.keys.length} programs, ${prev.textures} textures, ${prev.geometries} geometries`);
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
  const ft = await frames();
  const set = new Set(prev.keys);
  const added = now.keys.filter((k) => !set.has(k));
  const dTex = now.textures - prev.textures, dGeo = now.geometries - prev.geometries;
  rows.push({ place: name, total: now.keys.length, added: added.length,
              textures: now.textures, dTex, geometries: now.geometries, dGeo,
              med: ft.med, max: ft.max, keys: added.slice(0, 6) });
  console.log(
    `${name.padEnd(18)} progs ${String(now.keys.length).padStart(4)} (+${added.length})` +
    `  tex ${String(now.textures).padStart(4)} (${dTex >= 0 ? "+" : ""}${dTex})` +
    `  geo ${String(now.geometries).padStart(5)} (${dGeo >= 0 ? "+" : ""}${dGeo})` +
    `  frame med ${String(ft.med).padStart(6)} max ${String(ft.max).padStart(6)} ms`);
  /* A cacheKey is the shader name followed by every define; the leading token
     is the part a human can read, so print that and keep the rest in the json */
  for (const k of added.slice(0, 6)) console.log("      ", String(k).slice(0, 110));
  prev = now;
}
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ label: LABEL, rows }, null, 2));
console.log("wrote", OUT);
await browser.close();
