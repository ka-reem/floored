#!/usr/bin/env node
/* Headless check for the engine-speed signal — the number the tachometer
   draws and the engine audio pitches to (CarState.rpm, produced by
   stepEngineSpeed in game/physics.ts).

   This exists because that signal used to be raw driveline kinematics: road
   speed through the current gear, clamped to [IDLE_RPM, revLimit]. Two things
   fell out of that, and both were audible:

     - A gear change teleported it. 1st->2nd is a 3.54:2.13 ratio step, so a
       wide-open upshift moved the needle ~2900rpm between two consecutive
       physics steps, and the audio's pitch with it. Lifting off the throttle
       was worse: the upshift map read the raw pedal, so a lift collapsed the
       upshift threshold from revLimit*0.985 to revLimit*0.7 within one frame
       and could fire two upshifts inside a quarter second.
     - It could never leave idle with the car stationary, so flooring it from
       rest moved the engine's pitch not at all — only its level.

   So this asserts the properties that were broken, not an exact trace:
     1. rpm never moves more than MAX_STEP in one 1/120s physics step,
     2. it climbs off idle within half a second of full throttle from rest,
     3. it decays smoothly (no cliff) when the throttle is released,
     4. it stays inside [IDLE_RPM, revLimit] and is never NaN.

   Runs the real physics module — no browser, no dev server. TypeScript is
   compiled to a temp dir first because there is no bundler in the test path.

   Usage: node test/engine-rpm-check.mjs
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const IDLE_RPM = 850;
/* Ceiling on how far rpm may move in one 1/120s physics step. Derived, not
   picked: the widest ratio step in the roster is 1st->2nd (3.54:2.13), so a
   wide-open upshift sweeps ~2900rpm, and it does it over the 0.24s the
   gearbox schedules. stepEngineSpeed drives that on a smoothstep, whose slope
   peaks at 1.5x the mean, giving 1.5 * 2900 / 0.24 / 120 = ~151rpm at the
   steepest point of the steepest shift. 170 leaves a little headroom above
   that and still sits an order of magnitude below the ~2900rpm-in-a-single-
   step the old kinematic signal produced. Anything over this is a
   discontinuity rather than a sweep — which is exactly the bug. */
const MAX_STEP = 170;

/* CommonJS, not ESM: tsc emits extensionless relative imports ("./util"),
   which node's ESM loader refuses to resolve but require() handles fine.
   Compiling the whole game/ dir keeps physics.ts's imports satisfied without
   this test having to know what they are. */
const out = mkdtempSync(path.join(tmpdir(), "rpmcheck-"));
let physics, carspecs;
try {
  execFileSync(
    "npx",
    ["tsc", "game/physics.ts", "game/carspecs.ts", "--outDir", out,
     "--module", "commonjs", "--target", "es2022", "--skipLibCheck"],
    { stdio: "pipe" }
  );
  const require_ = createRequire(import.meta.url);
  physics = require_(path.join(out, "physics.js"));
  carspecs = require_(path.join(out, "carspecs.js"));
} catch (e) {
  console.error("could not compile game/physics.ts:", e.stdout?.toString() || e.message);
  process.exit(1);
}
const { stepPhysics, freshCarState } = physics;
const { CARS } = carspecs;

const DT = 1 / 120;
const OPTS = { mu: 1.26, tcEnabled: true, heightAt: () => 0 };

/** Drive one car through a throttle/brake script, returning the rpm trace.
    `u0` is the speed the CarState is created at — 0 for a standing start, and
    23 m/s for the spawn the game actually performs (engine.ts drops the player
    onto the corridor already rolling at 83km/h). */
function drive(spec, script, seconds, u0 = 0) {
  const car = freshCarState(0, 0, 0, 0, u0);
  const trace = [];
  for (let i = 0; i * DT < seconds; i++) {
    const t = i * DT;
    const { th = 0, br = 0 } = script(t, car);
    stepPhysics(car, { th, br, st: 0, hb: 0, horn: 0 }, spec, DT, OPTS);
    trace.push({ t, rpm: car.rpm, gear: car.gear, u: car.u, th });
  }
  return trace;
}

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

for (const car of CARS) {
  const id = car.id;
  const spec = car.phys;
  if (!spec || !spec.RATIOS) continue;

  // Full throttle from rest for 12s, then release and coast for 8s.
  const trace = drive(spec, (t) => ({ th: t < 12 ? 1 : 0 }), 20);

  let worst = 0, worstAt = 0;
  for (let i = 1; i < trace.length; i++) {
    const d = Math.abs(trace[i].rpm - trace[i - 1].rpm);
    if (d > worst) { worst = d; worstAt = trace[i].t; }
    if (!Number.isFinite(trace[i].rpm)) {
      fails.push(`${id}: rpm went non-finite at t=${trace[i].t.toFixed(2)}`);
      break;
    }
    check(
      trace[i].rpm >= IDLE_RPM - 0.5 && trace[i].rpm <= spec.revLimit + 0.5,
      `${id}: rpm ${trace[i].rpm.toFixed(0)} out of [${IDLE_RPM}, ${spec.revLimit}] at t=${trace[i].t.toFixed(2)}`
    );
  }
  check(
    worst <= MAX_STEP,
    `${id}: rpm jumped ${worst.toFixed(0)} in one step at t=${worstAt.toFixed(2)}s ` +
      `(max ${MAX_STEP}) — the needle is teleporting again`
  );

  // 2. It must leave idle promptly on a standing-start full-throttle launch,
  //    while the car is still barely moving. This is the converter-stall
  //    flare, and it is the difference between "the revs climb" and "the idle
  //    just gets louder".
  const half = trace.find((r) => r.t >= 0.5);
  check(
    half.rpm > IDLE_RPM + 900,
    `${id}: rpm only reached ${half.rpm.toFixed(0)} after 0.5s at full throttle ` +
      `(expected >${IDLE_RPM + 900}) — no launch flare, so pitch will not rise off the line`
  );

  // 3. Coming off the throttle must decay, not cliff. Look at the second
  //    after the lift and require every step in it to be gentle.
  const lift = trace.findIndex((r) => r.t >= 12);
  let worstLift = 0;
  for (let i = lift + 1; i < Math.min(trace.length, lift + 120); i++)
    worstLift = Math.max(worstLift, Math.abs(trace[i].rpm - trace[i - 1].rpm));
  check(
    worstLift <= MAX_STEP,
    `${id}: rpm dropped ${worstLift.toFixed(0)} in one step just after the lift ` +
      `— this is the "revs teleport when you come off the gas" bug`
  );

  /* 4. Spawning already rolling must not whoop. The game does not start the
        player from rest — it drops the car onto the corridor at 23 m/s
        (freshCarState(..., 23) in engine.ts). The flywheel therefore needs an
        initial condition, or it starts at the placeholder rpm and sweeps up
        to whatever the road speed implies: 1200 -> 8000rpm on tanuki inside a
        quarter second, a full rev-up and a needle sweep to the redline, at
        every spawn. Scripted as a coast so nothing but the initial condition
        can be moving the needle. */
  const spawn = drive(spec, () => ({}), 2, 23);
  let worstSpawn = 0, worstSpawnAt = 0;
  for (let i = 1; i < spawn.length; i++) {
    const d = Math.abs(spawn[i].rpm - spawn[i - 1].rpm);
    if (d > worstSpawn) { worstSpawn = d; worstSpawnAt = spawn[i].t; }
  }
  check(
    worstSpawn <= MAX_STEP,
    `${id}: rpm jumped ${worstSpawn.toFixed(0)} in one step at t=${worstSpawnAt.toFixed(2)}s ` +
      `after spawning at 23m/s (max ${MAX_STEP}) — the flywheel is starting from ` +
      `freshCarState's placeholder instead of from the driveline speed`
  );
  const spawnPeak = Math.max(...spawn.map((r) => r.rpm));
  check(
    spawnPeak <= spawn[0].rpm + 400,
    `${id}: rpm rose to ${spawnPeak.toFixed(0)} from ${spawn[0].rpm.toFixed(0)} while ` +
      `coasting away from a 23m/s spawn — the revs should not climb with the throttle shut`
  );

  const peak = Math.max(...trace.map((r) => r.rpm));
  console.log(
    `${id.padEnd(11)} peak ${peak.toFixed(0).padStart(4)}rpm  ` +
      `worst step ${worst.toFixed(0).padStart(3)}rpm  ` +
      `worst step after lift ${worstLift.toFixed(0).padStart(3)}rpm  ` +
      `rpm@0.5s ${half.rpm.toFixed(0)}  ` +
      `spawn@23m/s worst step ${worstSpawn.toFixed(0).padStart(3)}rpm`
  );
}

rmSync(out, { recursive: true, force: true });

if (fails.length) {
  console.error(`\n${fails.length} failure(s):`);
  for (const f of fails) console.error("  - " + f);
  process.exit(1);
}
console.log("\nengine-rpm-check: OK");
