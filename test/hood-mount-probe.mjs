/* Where is the Volvo's bonnet, ACTUALLY?

   The first attempt at the hood camera sized its mount off carshape.ts's
   procedural profile — P.belt, P.hood, and glassShape()'s windscreen base.
   The shipping player car does not wear that shape: it wears the imported
   donor exterior, whose glass starts further forward, so a mount computed to
   clear the procedural windscreen by 14 cm sat behind the donor's and the
   frame came back full of cabin.

   So measure the car that ships. Every vertex of the exterior, transformed
   into the same bodyG space the camera mount uses, bucketed into 5 cm slices
   of z near the centreline, max y per slice. That profile says where the
   bonnet surface is, where it stops and the glass starts, and therefore where
   a lens can sit. Then shoot a ladder of candidate mounts from one frozen
   frame so the choice is made by looking, not by arithmetic.

   Usage: node test/hood-mount-probe.mjs --url http://localhost:3702 --out DIR
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3702");
const OUT = arg("--out", process.cwd());
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPOT = -1300, KMH = 92, LANE = 1, FPS = 30;

const browser = await puppeteer.launch({
  headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
         "--disable-dev-shm-usage", "--mute-audio"],
  protocolTimeout: 3600000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.goto(debugUrl(URL, { tier: "desktop" }), { waitUntil: "domcontentloaded", timeout: 900000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
await page.evaluate(() =>
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE")).click());
console.log("world build...");
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 3000000, polling: 5000 });
await sleep(8000);
await page.evaluate(({ z, kmh, lane }) => {
  window.__neonx.toCorridor(z, kmh, lane);
  window.__neonx.setInput({ th: 0.34 });
}, { z: SPOT, kmh: KMH, lane: LANE });
await sleep(8000);
const step = () => page.evaluate(() => window.__neonx.step());
await page.evaluate((dt) => window.__neonx.setFixedDt(dt), 1 / FPS);
for (let i = 0; i < 40; i++) await step();

/* ---- the real body profile, in bodyG metres ---------------------------- */
const profile = await page.evaluate(() => {
  const g = window.__neonx.game, rig = g.rig;
  const body = rig.bodyG, ext = rig.exteriorG;
  /* THREE is not on window, so borrow the classes off objects that exist.
     Matrix4 and Vector3 are all this needs. */
  const V3 = g.camera.position.constructor;
  const M4 = g.camera.matrixWorld.constructor;
  body.updateMatrixWorld(true);
  ext.updateMatrixWorld(true);
  const inv = new M4().copy(body.matrixWorld).invert();
  const bins = new Map(); // z bin (5 cm) -> {maxY, n}
  const v = new V3();
  const m = new M4();
  let meshes = 0, verts = 0;
  ext.traverse((o) => {
    const geo = o.geometry;
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    if (o.visible === false) return;
    meshes++;
    m.multiplyMatrices(inv, o.matrixWorld);
    const pos = geo.attributes.position;
    // every 3rd vertex is plenty for a surface profile and keeps this instant
    for (let i = 0; i < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (Math.abs(v.x) > 0.35) continue; // centreline strip only
      verts++;
      const k = Math.round(v.z / 0.05);
      const b = bins.get(k);
      if (!b) bins.set(k, { maxY: v.y, n: 1 });
      else { if (v.y > b.maxY) b.maxY = v.y; b.n++; }
    }
  });
  const rows = [...bins.entries()]
    .map(([k, b]) => ({ z: +(k * 0.05).toFixed(2), topY: +b.maxY.toFixed(3), n: b.n }))
    .sort((a, b) => b.z - a.z);
  const P = g.spec.shell;
  return {
    shell: { L: P.L, belt: P.belt, hood: P.hood, nose: P.nose, roof: P.roof },
    proceduralCowlZ: +(P.L / 2 - P.hood).toFixed(2),
    proceduralGlassBaseZ: +(P.L / 2 - P.hood + 0.08).toFixed(2),
    meshes, verts,
    rows,
  };
});
writeFileSync(path.join(OUT, "profile.json"), JSON.stringify(profile, null, 1));
console.log("shell", JSON.stringify(profile.shell), "meshes", profile.meshes, "verts", profile.verts);
console.log("z\ttopY");
for (const r of profile.rows) if (r.z > 0.2 && r.z < 2.6) console.log(`${r.z}\t${r.topY}\t${r.n}`);

/* ---- a ladder of candidate mounts, one frozen frame -------------------- */
await page.evaluate(() => window.__neonx.setCam(2));
await step();
await page.evaluate((dt) => window.__neonx.setFixedDt(dt), 1e-6);
await step();
const LADDER = JSON.parse(arg("--ladder", "null") || "null") || [
  { dy: 0.03, dz: 0.22 },  // what shipped in b114857
  { dy: 0.03, dz: 0.55 },
  { dy: 0.03, dz: 0.85 },
  { dy: 0.10, dz: 0.85 },
  { dy: 0.03, dz: 1.10 },
  { dy: 0.10, dz: 1.10 },
];
for (const k of LADDER) {
  await page.evaluate((k) => { window.__hoodCam = { dy: k.dy, dz: k.dz, tilt: 0 }; }, k);
  await step();
  const name = `ladder-dy${String(k.dy).replace(".", "")}-dz${String(k.dz).replace(".", "")}.png`;
  await page.screenshot({ path: path.join(OUT, name) });
  console.log("saved", name);
}
console.log("errors:", errors.length, errors.slice(0, 5));
await browser.close();
