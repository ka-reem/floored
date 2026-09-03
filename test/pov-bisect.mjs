/* Lane M occluder bisect (NOT part of CI): boots the game, parks on the open
   highway, then captures the DASHCAM POV with named cockpit merge buckets
   hidden one at a time, so the mesh painting a black mass over the tablet can
   be identified empirically instead of guessed at.
     node test/pov-bisect.mjs --url http://localhost:3142 --out /abs/dir
   Buckets are the `merged:<material>` meshes buildCockpit's flush() names. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3142");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts"));
mkdirSync(OUT, { recursive: true });

const VW = 1280, VH = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: VW, height: VH },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* The world is built by the staged loader after this click, not by the
   constructor, so __neonx existing no longer means there is a world to
   drive in — wait for the load to finish before touching it. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(2500);
await page.evaluate(() => {
  const nx = window.__neonx;
  nx.toCorridor(-1300, 100, 1);
  nx.setInput({ th: 0.5 });
  nx.setCam(3); // CAM_POV dashcam
});
await sleep(2200);

const names = await page.evaluate(() => {
  const out = [];
  window.__neonx.game.rig.cockpit.group.traverse((o) => {
    if (o.isMesh && o.name) out.push(o.name);
  });
  return out;
});
console.log("named meshes:", names.join(", "));

const setVis = (name, v) =>
  page.evaluate((n, vis) => {
    window.__neonx.game.rig.cockpit.group.traverse((o) => {
      if (o.name === n) o.visible = vis;
    });
  }, name, v);

for (const n of [...new Set(names)]) {
  await setVis(n, false);
  await sleep(300);
  const tag = n.replace(/[^a-z0-9]+/gi, "-");
  await page.screenshot({ path: path.join(OUT, `hide-${tag}.png`) });
  console.log("saved", `hide-${tag}.png`);
  await setVis(n, true);
}
await browser.close();
console.log("ok");
