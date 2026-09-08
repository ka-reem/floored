/* Where does N put you?

   N (resetCar in game/engine.ts) is the only way out of a stuck car, and the
   owner asked for it to mean ONE thing everywhere: "pressing n should reset
   you on the nearest highway. so if im on the city road i can press n and
   itll reset me to highway not keep me in the city."

   It used to have two answers — snap to the corridor from up on the deck, but
   look up the nearest STREET in the road net from down in the town. That
   second answer is why a player who missed the on-ramp could press N all day
   and be handed another town street.

   This asserts the geometry the town branch now relies on: project the car's
   world position onto the alignment with zAt(), respawn there, and land ON
   the deck — right height, inside the road. Browser-free, because it is pure
   corridor arithmetic; what it cannot check is the key binding itself.

   The interesting spots are the ramp feet: they are exactly where a player
   who cannot get up the ramp will be standing when they reach for N.

   Usage: node test/reset-target-check.mjs */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "resetn-"));
execFileSync("npx", ["tsc", "game/world/corridor.ts", "--outDir", out, "--rootDir", ".",
  "--module", "esnext", "--target", "es2020", "--moduleResolution", "bundler",
  "--skipLibCheck"], { stdio: ["ignore", "ignore", "inherit"] });
const js = path.join(out, "game", "world", "corridor.js");
writeFileSync(js, readFileSync(js, "utf8").replace(/"(\.\.?\/[\w/]+)"/g, '"$1.js"'));
const { getCorridor } = await import(js);
const c = getCorridor();

/* The frontage road runs at x ~435 with the two ramp feet on it; the town
   streets spread east of that. One deck spot for the other branch. */
const SPOTS = [
  ["ramp foot (exit)", 435, -310],
  ["ramp foot (entry)", 435, -170],
  ["frontage mid", 435, -240],
  ["town street A", 500, -260],
  ["town street B", 560, -120],
  ["town far east", 640, -400],
  ["town north", 470, 40],
  ["on the deck already", 0, 400],
];

let bad = 0;
const f = (n) => n.toFixed(2);
for (const [name, x, z] of SPOTS) {
  const cz = c.zAt(x, z);
  const r = c.respawn(cz);
  const lat = c.latAt(r.x, r.z);
  const hw = c.halfWidth(cz);
  const dy = Math.abs(r.y - c.centerY(cz));
  const onDeck = dy < 0.5 && Math.abs(lat) <= hw + 0.01;
  if (!onDeck) {
    bad++;
    console.log(`  FAIL ${name}: y is ${f(dy)} m off the deck, lat ${f(lat)} of ±${f(hw)}`);
  }
  console.log(`  ${name.padEnd(20)} -> z ${cz.toFixed(0).padStart(6)}` +
    `  (${f(r.x)}, ${f(r.y)}, ${f(r.z)})  lat ${f(lat)}/±${f(hw)}` +
    `  ${onDeck ? "on the deck" : "OFF"}`);
}

/* And the property that actually matters: N must never leave the car down in
   the town. Measured in 3D on purpose — part of the town runs directly UNDER
   the deck (the street at x 500 shares its x with the alignment there), so a
   reset that lifts the car 10 m onto the viaduct without moving it sideways
   is the correct answer and a 2D distance would score it as "did not move".
   The lift is the point; the deck is 10 m up. */
for (const [name, x, z] of SPOTS.slice(0, 7)) {
  const r = c.respawn(c.zAt(x, z));
  const townY = 1.0; // town streets sit near ground level
  const moved = Math.hypot(r.x - x, r.y - townY, r.z - z);
  if (moved < 1) {
    bad++;
    console.log(`  FAIL ${name}: the reset left the car in the town (moved ${f(moved)} m)`);
  }
}

console.log(bad
  ? `\n${bad} reset-target check(s) FAILED`
  : "\nall reset targets land on the expressway deck, and none stay in the town");
process.exit(bad ? 1 : 0);
