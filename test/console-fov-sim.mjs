/* Console-camera FOV curve sim (NOT part of CI, no browser needed): mirrors
   the pure-math FOV pipeline in game/engine.ts (lensFov/povFov/consoleFov,
   POV_* and CONSOLE_* constants) to print the vertical+horizontal degrees the
   dashcam and console camera actually render across the FOV slider's range,
   proving the additive consoleFov() fix stays close to the dashcam instead of
   diverging from it at the top of the slider the way the old multiplicative
   one did.
     node test/console-fov-sim.mjs
*/
const POV_REF_ASPECT = 16 / 9;
const POV_V_CAP = 1.25;
const POV_V_FLOOR = 62;
const POV_H_CEIL = 118;
const POV_FOV_MAX = 100;
const FOV_SLIDER_REF = 67;
const CONSOLE_FOV_MAX = 130;
const CONSOLE_CAM_FOV = 78;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const halfTan = (deg) => Math.tan((deg * Math.PI) / 360);
const fullAng = (t) => (2 * Math.atan(t) * 180) / Math.PI;

function lensFov(base, aspect) {
  const h = fullAng(halfTan(base) * POV_REF_ASPECT);
  let v = fullAng(halfTan(h) / aspect);
  v = Math.min(v, base * POV_V_CAP);
  return Math.max(v, Math.min(POV_V_FLOOR, fullAng(halfTan(POV_H_CEIL) / aspect)));
}
const povFov = (fovBase, aspect) => lensFov(clamp(fovBase, 58, POV_FOV_MAX), aspect);

// the fix: additive instead of multiplicative
const consoleFovAdditive = (fovBase, aspect) =>
  lensFov(clamp(CONSOLE_CAM_FOV + (clamp(fovBase, 58, POV_FOV_MAX) - FOV_SLIDER_REF), 40, CONSOLE_FOV_MAX), aspect);
// the bug, kept here only to print the before/after contrast
const consoleFovMultiplicative = (fovBase, aspect) =>
  lensFov(clamp(CONSOLE_CAM_FOV * (clamp(fovBase, 58, POV_FOV_MAX) / FOV_SLIDER_REF), 40, CONSOLE_FOV_MAX), aspect);

const horizOf = (v, aspect) => fullAng(halfTan(v) * aspect);

const ASPECT = 16 / 9;
const sliders = [58, 67, 80, 100];

console.log("slider | dashcam V/H (deg)      | console V/H OLD (mult)   | console V/H NEW (add)");
console.log("-------|------------------------|--------------------------|-----------------------");
let worstGap = 0;
for (const s of sliders) {
  const dV = povFov(s, ASPECT), dH = horizOf(dV, ASPECT);
  const oV = consoleFovMultiplicative(s, ASPECT), oH = horizOf(oV, ASPECT);
  const nV = consoleFovAdditive(s, ASPECT), nH = horizOf(nV, ASPECT);
  worstGap = Math.max(worstGap, nV - dV);
  console.log(
    `${String(s).padStart(6)} | ${dV.toFixed(1).padStart(5)} / ${dH.toFixed(1).padStart(5)}` +
    `            | ${oV.toFixed(1).padStart(5)} / ${oH.toFixed(1).padStart(5)}` +
    `              | ${nV.toFixed(1).padStart(5)} / ${nH.toFixed(1).padStart(5)}`
  );
}
console.log("\nconsole camera's own baseline-at-default check: 78 at 67, 71 at 60, 91 at 80 (additive design note)");
for (const [s, want] of [[60, 71], [67, 78], [80, 91]]) {
  const base = clamp(CONSOLE_CAM_FOV + (clamp(s, 58, POV_FOV_MAX) - FOV_SLIDER_REF), 40, CONSOLE_FOV_MAX);
  const ok = Math.abs(base - want) < 0.01;
  console.log(`  slider ${s}: base=${base} (want ${want}) ${ok ? "OK" : "MISMATCH"}`);
  if (!ok) process.exitCode = 1;
}
console.log(`\nmax (console_new_vertical - dashcam_vertical) over slider range: ${worstGap.toFixed(1)} deg`);
if (worstGap > 15) {
  console.log("FAIL: console still diverges from the dashcam by more than a sane margin");
  process.exitCode = 1;
} else {
  console.log("ok");
}
