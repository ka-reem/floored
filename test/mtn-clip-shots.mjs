/* Photographs of the mountain/highway interpenetration at both gores, from a
   free camera (the shipped cameras all ride the car, and the thing to show is
   20 m off to one side of it), plus a MESH-LEVEL clearance probe.

   The probe is the point: test/mountain-gap.mjs re-derives highway.ts's rock
   formulas in node, so it could be wrong about the geometry that actually
   ships. This walks the real vertices of the built rock/wall/pavement meshes,
   projects each into the corridor frame and reports the worst lateral
   clearance from the deck's east pavement edge — the same number, measured
   the other way round.

   Usage: node test/mtn-clip-shots.mjs --url http://localhost:3423 --tag before
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3000");
const TAG = arg("--tag", "shot");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts"));
mkdirSync(OUT, { recursive: true });
const VW = Number(process.env.SHOT_W || 1280), VH = Number(process.env.SHOT_H || 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: VW, height: VH },
  protocolTimeout: 2400000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  pageerror:", String(e.message || e).slice(0, 200)));
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 180000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* the staged loader takes ~3 min under SwiftShader on an idle box and has
   been seen to take three times that with other lanes' browsers running, so
   this waits long and says where it got to. */
for (let k = 0; ; k++) {
  const done = await page.evaluate(() => !!window.__neonx?.game?.loaded);
  if (done) break;
  if (k > 120) throw new Error("world never finished loading");
  if (k % 6 === 0) console.log(`  loading... ${k * 10}s`);
  await sleep(10000);
}
await sleep(4000);
console.log("loaded");

/* ---- park on the deck between the two gores so every chunk around both of
   them is resident, then never move again: the free camera does the work. */
await page.evaluate(() => {
  const nx = window.__neonx;
  nx.toCorridor(-1806, 0, 1);
  nx.setInput({ th: 0, br: 1, st: 0, hb: 0, horn: 0 });
});
await sleep(2500);

/* ---- mesh-level clearance probe ---------------------------------------- */
const probe = await page.evaluate(() => {
  const nx = window.__neonx, g = nx.game;
  const cor = g.world.routes.mtn.cor ?? g.cor;
  const mt = g.world.routes.mtn;
  const zLo = Math.min(-1968, -1644) - 60, zHi = Math.max(-1968, -1644) + 60;
  const out = {};
  const V = g.camera.position.constructor;
  const v = new V();
  g.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    if (pos.count > 400000) return;
    o.updateMatrixWorld(true);
    let worst = null;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.z < zLo || v.z > zHi) continue;
      // only the pieces that belong to the pass: within 40 m of its centreline
      const hit = mt.project(v.x, v.z, 40);
      if (!hit) continue;
      const zc = cor.zAt(v.x, v.z);
      if (zc < zLo || zc > zHi) continue;
      const gap = cor.latAt(v.x, v.z) - cor.halfWidth(zc);
      if (worst === null || gap < worst.gap)
        worst = { gap, x: v.x, y: v.y, z: v.z, zc, deckY: cor.centerY(zc) };
    }
    if (!worst) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const key = `${m.type}#${m.color ? m.color.getHexString() : "-"}` +
      `${m.vertexColors ? " vcol" : ""} n=${pos.count}`;
    if (!out[key] || worst.gap < out[key].gap) out[key] = worst;
  });
  return out;
});
console.log("\n  mesh-level worst clearance from the deck's east pavement edge");
console.log("  (negative = the mesh stands over the expressway)");
for (const [k, w] of Object.entries(probe).sort((a, b) => a[1].gap - b[1].gap))
  console.log(`   ${w.gap.toFixed(2).padStart(8)} m  dy ${(w.y - w.deckY).toFixed(2).padStart(7)}` +
    `  z ${w.z.toFixed(0).padStart(6)}   ${k}`);

/* ---- free-camera photographs -------------------------------------------
   The engine drives game.camera every frame and would re-render over any
   manual draw before the screenshot landed (the first attempt at this came
   back with the dashcam), so the frame loop is stopped first — rAF stubbed
   out — and the DOM HUD hidden. From here the canvas holds whatever was last
   drawn into it, which is the survey camera. */
await page.evaluate(() => {
  window.requestAnimationFrame = () => 0;
  for (const el of document.body.children)
    if (el.tagName !== "CANVAS") el.style.visibility = "hidden";
});
await sleep(6000);

const shot = async (name, cam) => {
  {
    await page.evaluate((c) => {
      const g = window.__neonx.game;
      const CamC = g.camera.constructor;
      const cam = new CamC(c.fov, innerWidth / innerHeight, 0.3, 4000);
      cam.position.set(c.px, c.py, c.pz);
      cam.up.set(0, 1, 0);
      cam.lookAt(c.tx, c.ty, c.tz);
      cam.updateMatrixWorld(true);
      /* This is a survey photograph, not a game frame: the pass is at night
         and 70 m out through the fog, where a dark rock face and a dark deck
         are the same black. Fog off and the ambient/hemisphere lights up for
         the exposure, restored straight after — the GEOMETRY in the frame is
         untouched, which is the only thing being judged. */
      const fog = g.scene.fog;
      const saved = [];
      g.scene.traverse((o) => {
        if (o.isAmbientLight || o.isHemisphereLight || o.isDirectionalLight) {
          saved.push([o, o.intensity]);
          o.intensity = o.isDirectionalLight ? 1.1 : 2.2;
        }
      });
      const expo = g.renderer.toneMappingExposure;
      g.scene.fog = null;
      g.renderer.toneMappingExposure = expo * 1.35;
      g.renderer.render(g.scene, cam);
      g.scene.fog = fog;
      g.renderer.toneMappingExposure = expo;
      for (const [o, i] of saved) o.intensity = i;
    }, cam);
    await page.screenshot({ path: path.join(OUT, `${name}-${TAG}.png`), type: "png" });
  }
  console.log("  shot", `${name}-${TAG}.png`);
};

/* Camera geometry, both gores. The deck runs roughly along +z at x ≈ 0-ish
   here; the pass leaves to the EAST (+x). Stand west of the deck, above it,
   and look across it at the rock — anything of the hillside that is on the
   near side of the road edge is the bug, and from here it is unmistakable. */
const cams = await page.evaluate(() => {
  const g = window.__neonx.game;
  const cor = g.cor ?? g.world.routes.mtn.cor;
  const mk = (zc, back, up, off) => {
    const p = cor.pose(zc), hw = cor.halfWidth(zc);
    const w = cor.worldOf(zc, 0);
    return {
      px: w.x - p.nx * off - p.tx * back, py: w.y + up, pz: w.z - p.nz * off - p.tz * back,
      tx: w.x + p.nx * hw * 0.6, ty: w.y + 1.5, tz: w.z + p.nz * hw * 0.6,
      fov: 42, hw,
    };
  };
  return {
    diverge: mk(-1932, 66, 16, 44),
    divergeLow: mk(-1908, 52, 3.0, -2),
    merge: mk(-1704, -66, 16, 44),
    mergeLow: mk(-1682, -52, 3.0, -2),
  };
});
for (const [k, c] of Object.entries(cams)) await shot(`mtnclip-${k}`, c);

await browser.close();
console.log("done");
