/* Tail-anchor evidence shots for ONE style, before/after, from one session.

   The owner's report: "rav4 tail lights need to be higher so its on the
   acutal red light lamps are. and the bus ltail ights are not bright enoguh
   theyre very idm or inside the bus". Both are the bake's blind fallback
   anchor (see TAIL_FIX in game/npcmodels.ts), so the honest evidence is the
   SAME frame with only that anchor changed.

   `traffic.lampsOf[style].tail` is what renderInstances/updateLights read
   every frame, so the A/B is a live console write: put the pre-fix fallback
   back for "before", the shipped value for "after". No rebuild, no second
   browser, identical car, gap, heading, clock and weather in both frames.

   Every capture is also cropped tight on the rear of the vehicle, projected
   from the car's own rear face through the live camera — a 1440x900 frame is
   far too small to judge where a lamp anchor sits.

   Usage: node test/tail-anchor-shots.mjs --url http://localhost:3414 \
            --type bus --out DIR [--gap 14] [--cams pov,chase]
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import sharp from "sharp";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3414");
const TYPE = arg("--type", "bus");
const GAP = Number(arg("--gap", 14));
const CAMS = arg("--cams", "pov,chase").split(",");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts", "tail-anchor"));
mkdirSync(OUT, { recursive: true });

/* Pre-fix values: tools/build-hifi-models.mjs's fallback anchor
   [±W*0.34, H*0.45, -L*0.47] exactly as it ships in the GLB extras — plus the
   fitted body height, which the crop needs and Npc does not carry. */
const STY = {
  suv: { before: [0.646, 0.8055, -2.2184], H: 1.79 },
  bus: { before: [0.7684, 1.35, -4.418], H: 3.0 },
};
if (!STY[TYPE]) {
  console.log(`no before-anchor recorded for "${TYPE}"`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  dumpio: !!process.env.DUMPIO,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("error", (e) => console.log("PAGE CRASHED:", String(e.message || e)));
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(9000); // HD fleet + props land

await page.evaluate(() => {
  const nx = window.__neonx;
  nx.setTime(22.0);
  nx.toCorridor(-1300, 100, 1);
  nx.setInput({ th: 0.4 });
});
await sleep(5000);

/* Pin the player GAP m behind an active car of this style, on its heading, at
   its speed. Any one anywhere on the route will do — the PLAYER is moved to
   it, so we never wait for a 2%-of-roster bus to turn up ahead. */
let picked = null;
for (let tries = 0; tries < 25 && !picked; tries++) {
  if (tries) await sleep(1200);
  picked = await page.evaluate((TYPE, GAP) => {
    const nx = window.__neonx, tr = nx.game.traffic;
    const cands = tr.npcs.filter(
      (n) => n.active && n.type === TYPE && !n.wreck && !n.rival && n.y > -100 && n.hw
    );
    if (!cands.length) return null;
    const n = cands[0];
    window.__pin = n;
    window.__gap = GAP;
    window.__shipped = tr.lampsOf[tr.styleOf[TYPE]].tail.map((t) => t.slice());
    /* brake pinned OFF: this is the RUNNING lamp, and a car tailgated by a
       teleporting player brakes on its own. */
    Object.defineProperty(n, "brake", { get: () => false, set() {}, configurable: true });
    const pin = () => {
      const h = n.hVis, g = window.__gap;
      nx.teleport(n.x - Math.sin(h) * g, n.z - Math.cos(h) * g, undefined, h, n.v);
    };
    window.__pinTimer = setInterval(pin, 40);
    pin();
    return { id: n.id, type: n.type, style: n.style, L: n.L, W: n.W, v: n.v, of: cands.length };
  }, TYPE, GAP);
}
if (!picked) {
  console.log(`no active ${TYPE} — aborting`);
  await browser.close();
  process.exit(2);
}
console.log("pinned behind", picked, "shipped anchor",
  await page.evaluate(() => window.__shipped));

const setAnchor = (v) => page.evaluate((TYPE, v) => {
  const tr = window.__neonx.game.traffic, si = tr.styleOf[TYPE];
  tr.lampsOf[si].tail = v
    ? [[-v[0], v[1], v[2]], [v[0], v[1], v[2]]]
    : window.__shipped.map((t) => t.slice());
  return tr.lampsOf[si].tail;
}, TYPE, v);

/* Screen rect of the pinned car's rear face and of its two tail anchors,
   projected through the live camera. */
const rearRect = (bodyH) => page.evaluate((TYPE, bodyH) => {
  const g = window.__neonx.game, n = window.__pin, tr = g.traffic;
  const cam = g.camera, dpr = window.devicePixelRatio || 1;
  const W = g.renderer.domElement.width / dpr, H = g.renderer.domElement.height / dpr;
  const h = n.hVis, fx = Math.sin(h), fz = Math.cos(h), rx = fz, rz = -fx;
  const V3 = Object.getPrototypeOf(cam.position).constructor;
  const toScreen = (lx, ly, lz) => {
    const v = new V3(n.x + fx * lz + rx * lx, n.y + ly, n.z + fz * lz + rz * lx);
    v.project(cam);
    return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H];
  };
  const hw = n.W / 2, zr = -n.L / 2;
  const pts = [];
  for (const sx of [-1, 1]) for (const y of [0, bodyH]) pts.push(toScreen(sx * hw, y, zr));
  const tail = tr.lampsOf[tr.styleOf[TYPE]].tail;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return {
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    anchors: tail.map((t) => toScreen(t[0], t[1], t[2])),
    frame: [W, H],
  };
}, TYPE, bodyH);

const CAMI = { chase: 0, cockpit: 1, hood: 2, pov: 3, console: 4 };
const shots = [];
for (const cam of CAMS) {
  await page.evaluate((c) => window.__neonx.setCam(c), CAMI[cam]);
  await sleep(1500);
  for (const [tag, v] of [["before", STY[TYPE].before], ["after", null]]) {
    await setAnchor(v);
    await sleep(1500);
    const f = path.join(OUT, `${TYPE}-${cam}-${tag}-full.png`);
    await page.screenshot({ path: f });
    const r = await rearRect(STY[TYPE].H);
    shots.push({ file: f, cam, tag, ...r });
    console.log(`saved ${f}  anchors@screen`,
      r.anchors.map((a) => a.map((q) => Math.round(q)).join(",")).join(" | "));
  }
}
await page.evaluate(() => clearInterval(window.__pinTimer));
await browser.close();

/* Crop: one size per camera (the largest rear box seen, padded), each frame
   centred on its OWN box, so the pair matches in size and framing. */
const PAD = 0.42; // of box size, so the lamps are never against the crop edge
for (const cam of CAMS) {
  const pair = shots.filter((s) => s.cam === cam);
  if (pair.length !== 2) continue;
  const w = Math.max(...pair.map((s) => s.box[2] - s.box[0]));
  const h = Math.max(...pair.map((s) => s.box[3] - s.box[1]));
  const cw = Math.round(Math.min(1440, w * (1 + PAD * 2)));
  const ch = Math.round(Math.min(900, h * (1 + PAD * 2)));
  for (const s of pair) {
    const cx = (s.box[0] + s.box[2]) / 2, cy = (s.box[1] + s.box[3]) / 2;
    const left = Math.round(Math.max(0, Math.min(1440 - cw, cx - cw / 2)));
    const top = Math.round(Math.max(0, Math.min(900 - ch, cy - ch / 2)));
    s.crop = path.join(OUT, `${TYPE}-${cam}-${s.tag}.png`);
    await sharp(s.file).extract({ left, top, width: cw, height: ch })
      .resize({ width: Math.min(900, cw * 2), kernel: "nearest" }).png().toFile(s.crop);
    console.log("cropped", s.crop, `${cw}x${ch} @ ${left},${top}`);
  }
}
console.log(JSON.stringify({ type: TYPE, gap: GAP, picked, shots }, null, 1));
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 300));
}
