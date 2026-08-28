/* Speed FOV kick fade sim (NOT part of CI, no browser needed): mirrors the
   kickFade term added in game/engine.ts's camUpdate (the raw
   `fovBase + kick*kickM` assignment for CHASE/COCKPIT/HOOD, no lensFov, no
   cap) to confirm the total never runs past ~104 vertical at any fovBase in
   the slider's 58..100 range, for every camMode's kick multiplier.
     node test/speed-fov-kick-sim.mjs
*/
const POV_FOV_MAX = 100;
const FOV_SLIDER_REF = 67;
const KICK_MAX = 19; // clamp(|u| * 0.21, 0, 19) at its ceiling (high speed)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const kickFade = (fovBase) =>
  clamp((POV_FOV_MAX - fovBase) / (POV_FOV_MAX - FOV_SLIDER_REF), 0, 1);

const MODES = [
  { name: "COCKPIT", modeM: 1 },
  { name: "HOOD", modeM: 0.6 },
  { name: "CHASE (shake=1, live-only)", modeM: 0.18 },
];

console.log("fovBase | kickFade | " + MODES.map((m) => m.name.padEnd(26)).join("| "));
let worst = 0;
for (let fovBase = 58; fovBase <= 100; fovBase += 1) {
  const fade = kickFade(fovBase);
  const totals = MODES.map((m) => {
    const total = fovBase + KICK_MAX * m.modeM * fade;
    worst = Math.max(worst, total);
    return total;
  });
  if (fovBase === 58 || fovBase === 67 || fovBase === 80 || fovBase === 100) {
    console.log(
      `${String(fovBase).padStart(7)} | ${fade.toFixed(2).padStart(8)} | ` +
      totals.map((t) => t.toFixed(1).padStart(26)).join("| ")
    );
  }
}
console.log(`\nworst-case total vertical fov across all modes and fovBase 58..100: ${worst.toFixed(1)} deg`);
if (worst > 104) {
  console.log("FAIL: kick still pushes a mode past the ~104 deg target");
  process.exitCode = 1;
} else {
  console.log("ok");
}
