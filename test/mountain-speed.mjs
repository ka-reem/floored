/* How fast can the pass actually be driven, before and after?

   "Wide and easier to drive" is a feel, and the two numbers that usually
   stand in for it — width and minimum radius — are single points on a road
   with a hundred corners. This turns the WHOLE geometry into one number the
   owner can compare: the fastest clean run through the pass that its curvature
   allows.

   Method is the standard two-pass speed profile a racing line solver uses:
     1. cap each station at the speed its own curvature allows, v = √(µ·g·R),
        with the station's superelevation folded into µ;
     2. sweep forward limiting acceleration, then backward limiting braking,
        so every cap is actually reachable and stoppable;
     3. integrate ds/v for the time.

   What it is NOT: a lap time. It ignores the driver, the line (it drives the
   centreline, so a real player using 11 m of road is faster still), tyre load
   transfer and the engine's torque curve above the grip limit. It is a bound
   on the geometry, measured identically on both sides, which is exactly what
   a before/after needs — the same objection as the frame-time numbers on this
   box: the ratio transfers, the absolute does not.

   Usage: node test/mountain-speed.mjs [--mu 1.6]
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const MU = Number(arg("--mu", 1.6));      // lateral grip, arcade tune
const AX = Number(arg("--accel", 6.0));   // m/s², arcade 0–100 in 2.3 s
const BX = Number(arg("--brake", 11.0));  // m/s², arcade brakes ×4
const REF = arg("--git", "");
const G = 9.81;

const SRC = ["game/world/corridor.ts", "game/world/ramps.ts", "game/world/routegraph.ts",
  "game/world/const.ts"];
const work = mkdtempSync(path.join(tmpdir(), "mtnspeed-"));
let root = process.cwd();
if (REF) {
  root = path.join(work, "src");
  for (const f of SRC) {
    mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(root, f),
      execFileSync("git", ["show", `${REF}:${f}`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  }
}
const js = path.join(work, "js");
execFileSync("npx", ["tsc", ...SRC, "--outDir", js, "--rootDir", ".",
  "--module", "esnext", "--target", "es2020", "--moduleResolution", "bundler",
  "--skipLibCheck"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const dir = path.join(js, "game", "world");
for (const f of ["corridor.js", "ramps.js", "routegraph.js", "const.js"]) {
  const p = path.join(dir, f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w/]+)"/g, '"$1.js"'));
}
const { getRouteGraph, MTN } = await import(path.join(dir, "routegraph.js"));
const mt = getRouteGraph().mtn;
const st = mt.stations;

/* 1. curvature cap. Bank helps: a road leaning into the corner adds roughly
   µ + tan(θ) worth of lateral hold at these small angles. Straights are
   capped by the car's top speed, not by geometry. */
const VMAX = 295 / 3.6;
const v = new Float64Array(st.length).fill(VMAX);
let minR = 1e9;
for (let i = 1; i < st.length - 1; i++) {
  const a = st[i - 1], b = st[i + 1];
  let dh = Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz);
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const k = Math.abs(dh) / Math.max(0.01, b.s - a.s);
  if (k < 1e-6) continue;
  const R = 1 / k;
  minR = Math.min(minR, R);
  v[i] = Math.min(v[i], Math.sqrt((MU + Math.abs(st[i].bank)) * G * R));
}

/* 2. make every cap reachable (forward) and stoppable (backward) */
const ds = (i) => Math.max(0.01, st[i].s - st[i - 1].s);
for (let i = 1; i < st.length; i++)
  v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * AX * ds(i)));
for (let i = st.length - 2; i >= 0; i--)
  v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * BX * ds(i + 1)));

/* 3. time, and the shape of the run */
let t = 0;
for (let i = 1; i < st.length; i++) t += ds(i) / Math.max(1, (v[i] + v[i - 1]) / 2);
const kmh = [...v].map((x) => x * 3.6);
const slowest = Math.min(...kmh), mean = kmh.reduce((a, b) => a + b, 0) / kmh.length;
/* how much of the pass is spent below 80 km/h — the "crawling" fraction, which
   is what "too tight" actually feels like from the seat */
const crawl = kmh.filter((x) => x < 80).length / kmh.length;

console.log(`${REF || "working tree"}  (µ=${MU}, accel ${AX} m/s², brake ${BX} m/s²)`);
console.log(`  ${(2 * MTN.half).toFixed(2)} m wide, ${mt.len.toFixed(0)} m long, tightest ${minR.toFixed(1)} m`);
console.log(`  slowest corner ${slowest.toFixed(0)} km/h   mean ${mean.toFixed(0)} km/h` +
  `   below 80 km/h for ${(crawl * 100).toFixed(0)}% of the road`);
console.log(`  fastest clean run through the pass: ${t.toFixed(1)} s`);
