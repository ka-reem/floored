#!/usr/bin/env node
/* Headless assertions on the car roster — game/carspecs.ts.

   The roster has three lookups that mean three different things, and the
   difference between them is load-bearing rather than stylistic:

     PLAYABLE_CARS   what the garage may select and what DEFAULT_CAR derives
                     from — so the ORDER of CARS decides the default car
     getCar(id)      the DRIVEABLE lookup. A locked or unknown id falls back,
                     because the engine must never boot into a car the garage
                     refuses to select
     carById(id)     the RAW lookup, lock ignored, so a COMING SOON card can
                     draw itself as itself rather than as the fallback

   All three are derived, none is hardcoded, and that is exactly why they want
   a test: nothing in the file states "the Volvo is the default" or "there are
   two playable cars" — those are consequences of an array's contents and
   order, and a car added in the wrong place changes both silently.

   Also checked here, because it is the whole of the user's ask and is likewise
   nowhere asserted in the source: the two playable cars DRIVE IDENTICALLY.
   That is expressed as shared object identity on `phys`, not as matching
   literals, so this checks identity — matching numbers would pass a test that
   copied the table, and a copy is precisely the failure mode (a retune of one
   car silently desyncing the pair).

   Compiles the real module rather than reimplementing it — same tsc-to-tmpdir
   trick as test/steer-response-sim.mjs. No browser, no dev server.

   Usage: node test/roster-check.mjs     (exit 0 = pass, 1 = fail) */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "roster-"));
let carspecs;
try {
  execFileSync(
    "npx",
    ["tsc", "game/carspecs.ts", "--outDir", out,
     "--module", "commonjs", "--target", "es2022", "--skipLibCheck"],
    { stdio: "pipe" }
  );
  carspecs = createRequire(import.meta.url)(path.join(out, "carspecs.js"));
} catch (e) {
  console.error("could not compile game/carspecs.ts:", e.stdout?.toString() || e.message);
  process.exit(1);
}
const { CARS, PLAYABLE_CARS, DEFAULT_CAR_ID, carById, getCar, isPlayableCar } = carspecs;

let failed = 0;
const ok = (cond, what, got) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${cond ? "" : `  — got ${got}`}`);
  if (!cond) failed++;
};

console.log("roster");
const playable = PLAYABLE_CARS.map((c) => c.id);
ok(
  playable.length === 2 && playable[0] === "volvo" && playable[1] === "kaze",
  "PLAYABLE_CARS is [volvo, kaze], in that order",
  JSON.stringify(playable)
);
ok(DEFAULT_CAR_ID === "volvo", "DEFAULT_CAR_ID is the Volvo", DEFAULT_CAR_ID);
ok(
  CARS[0].id === DEFAULT_CAR_ID,
  "the default is derived from roster ORDER, not stated separately",
  CARS[0].id
);

console.log("locks");
const locked = CARS.filter((c) => c.comingSoon).map((c) => c.id);
ok(
  locked.length === 3 &&
    ["shirayuki", "tanuki", "okami"].every((id) => locked.includes(id)),
  "shirayuki / tanuki / okami are still COMING SOON",
  JSON.stringify(locked)
);
for (const id of locked)
  ok(getCar(id).id === DEFAULT_CAR_ID, `getCar("${id}") falls back to the default`, getCar(id).id);
ok(getCar("nonsense").id === DEFAULT_CAR_ID, 'getCar("nonsense") falls back too', getCar("nonsense").id);
for (const id of locked)
  ok(!isPlayableCar(id), `isPlayableCar("${id}") is false`, String(isPlayableCar(id)));

console.log("card art (the raw lookup must IGNORE the lock)");
ok(carById("tanuki")?.name === "TANUKI KEI", 'carById("tanuki") is TANUKI KEI', carById("tanuki")?.name);
ok(carById("okami")?.name === "OKAMI TOURER", 'carById("okami") is OKAMI TOURER', carById("okami")?.name);
ok(carById("nonsense") === undefined, 'carById("nonsense") is undefined', String(carById("nonsense")));
for (const c of CARS)
  ok(!!c.shell && c.shell.L > 0, `${c.id} keeps whole shell params for its card`, JSON.stringify(c.shell));

console.log("the two cars drive identically");
const [volvo, kaze] = PLAYABLE_CARS;
ok(volvo.phys === kaze.phys, "one PhysicsSpec object, shared — not two copies", "two distinct objects");
ok(volvo.stats === kaze.stats, "one stats object, shared — the bars cannot disagree", "two distinct objects");

console.log("the two cars LOOK different");
ok(volvo.shell.L !== kaze.shell.L, "different lengths", `${volvo.shell.L} vs ${kaze.shell.L}`);
ok(
  !volvo.shell.spoiler && kaze.shell.spoiler === "wing",
  "saloon has no spoiler, kaze keeps its wing",
  `${volvo.shell.spoiler} vs ${kaze.shell.spoiler}`
);
const accents = CARS.map((c) => c.cockpitAccent);
ok(
  new Set(accents).size === accents.length,
  "every cockpitAccent is unique (cockpit.ts trimFor() infers trim from it)",
  JSON.stringify(accents.map((a) => "0x" + a.toString(16)))
);

rmSync(out, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
