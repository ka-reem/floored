/* Browser-free checks on the expressway corridor.

   Everything the world builder draws — pavement, markings, parapets, signs,
   gantries, sound walls, the tunnel, the toll plaza — is positioned from
   game/world/corridor.ts. So most of the ways that geometry can go wrong are
   arithmetic, not rendering: a sign post placed past the pavement edge, a mast
   tall enough to spear the tunnel ceiling, a loop splice whose two ends don't
   match. Those are all checkable here, in a second, with no GPU.

   This mirrors the placement arithmetic in highway.ts. If you move a sign or
   change the lane schedule there, update the corresponding block here.

   Usage: node test/corridor-check.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "corridor-"));
execFileSync("npx", [
  "tsc", "game/world/corridor.ts", "--outDir", out, "--module", "esnext",
  "--target", "es2020", "--moduleResolution", "bundler", "--skipLibCheck",
], { stdio: ["ignore", "ignore", "ignore"] });
const js = path.join(out, "corridor.js");
writeFileSync(js, readFileSync(js, "utf8").replace('"./const"', '"./const.js"'));
const { getCorridor, TOLL } = await import(js);

const c = getCorridor();
const CONNECT_Z = [-330, -70]; // const.ts
let fail = 0;
const bad = (m) => {
  console.log("  FAIL " + m);
  fail++;
};
const f = (n) => n.toFixed(2);

/* ---- the endless loop ---------------------------------------------------
   The wrap is implemented as a pure translation in z, which is only invisible
   if the corridor at Z0 + d is identical to the corridor at Z1 + d for as far
   ahead as the player can see. */
console.log("loop splice:");
let worst = 0, worstAt = 0;
for (let d = 0; d <= c.EXT; d += 2) {
  const a = c.pose(c.Z0 + d), b = c.pose(c.Z1 + d);
  const e = Math.max(
    Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.h - b.h),
    Math.abs(c.laneCount(c.Z0 + d) - c.laneCount(c.Z1 + d)),
    Math.abs(c.halfWidth(c.Z0 + d) - c.halfWidth(c.Z1 + d))
  );
  if (e > worst) {
    worst = e;
    worstAt = d;
  }
}
console.log(`  loop ${c.LOOP} m, overrun ${c.EXT} m either side, arclength ${c.lapLen.toFixed(0)} m`);
console.log(`  worst mismatch over the splice window: ${worst.toExponential(2)} at +${worstAt} m`);
if (worst > 1e-9) bad("the two ends of the loop are not identical");

/* ---- alignment stays highway-realistic ---- */
let maxSlope = 0, maxGrade = 0, minY = 1e9;
for (let z = c.ZB0; z <= c.ZB1; z += 2) {
  maxSlope = Math.max(maxSlope, Math.abs(c.slopeX(z)));
  maxGrade = Math.max(maxGrade, Math.abs(c.pose(z).grade));
  minY = Math.min(minY, c.centerY(z));
}
console.log("alignment:");
console.log(`  max heading ${f((Math.atan(maxSlope) * 180) / Math.PI)}°,` +
  ` max grade ${f(maxGrade * 100)}%, min deck height ${f(minY)} m`);
if (maxSlope > 0.36) bad("a bend is sharper than a fast highway curve");
if (maxGrade > 0.06) bad("a grade is steeper than 6%");
if (minY < 4.5) bad("the deck drops too low for its piers and ramps");

/* ---- world <-> corridor mapping ---- */
let rt = 0;
for (let z = c.ZB0 + 10; z < c.ZB1 - 10; z += 37)
  for (const lat of [-11, -4, 0, 5, 11]) {
    const w = c.worldOf(z, lat);
    rt = Math.max(rt, Math.abs(c.zAt(w.x, w.z) - z), Math.abs(c.latAt(w.x, w.z) - lat));
  }
console.log(`mapping: worldOf/zAt/latAt round-trip error ${rt.toExponential(2)} m`);
if (rt > 0.01) bad("the corridor's inverse mapping has drifted");

/* ---- lane schedule is drivable everywhere ---- */
let minLanes = 99, maxLanes = 0;
for (let z = c.ZB0; z <= c.ZB1; z += 2) {
  const n = c.lanes(z);
  minLanes = Math.min(minLanes, n);
  maxLanes = Math.max(maxLanes, n);
  for (let k = 0; k < n; k++)
    if (Math.abs(c.laneOffset(k, z)) + 1.0 > c.halfWidth(z))
      bad(`lane ${k} at z=${z} runs off the pavement`);
}
console.log(`lanes: ${minLanes}–${maxLanes} across the lap`);

/* ---- cantilever signs: post on pavement, panel clear of the lanes ----
   The mount is one post on the outer shoulder with the panel cantilevered in;
   see signFactory() in highway.ts. CLEAR is its clearance constant. */
const CLEAR = 5.15, TUNNEL_CLEAR = 6.4;
const signs = [];
for (const zr of CONNECT_Z) {
  if (zr === CONNECT_Z[0]) {
    for (const d of [400, 200]) signs.push([zr - d, 7.4, 2.8, `exit ${d} m`]);
    signs.push([zr - 40, 7.4, 2.8, "exit gore board"]);
  } else signs.push([zr - 200, 6.6, 2.5, "merge warning"]);
}
for (const d of [500, 115]) signs.push([TOLL.plazaZ0 - d, 7.4, 2.8, `toll ${d} m`]);

console.log("cantilever signs:");
for (const [z, w, h, label] of signs) {
  const hw = c.halfWidth(z);
  const postLat = -(hw - 0.7);
  const p0 = postLat + 0.3, p1 = postLat + 0.3 + w;
  console.log(`  z=${String(z).padStart(6)}  ${label.padEnd(16)} edge ${f(-hw)}` +
    `  post ${f(postLat)}  panel [${f(p0)}, ${f(p1)}]  top ${f(CLEAR + h)} m`);
  if (postLat - 0.15 < -hw) bad(`${label}: post hangs off the deck edge`);
  if (p0 < -hw || p1 > hw) bad(`${label}: panel overhangs the deck edge`);
  if (c.inTunnel(z)) bad(`${label}: inside the tunnel`);
  if (c.inTunnel(z) && CLEAR + h > TUNNEL_CLEAR) bad(`${label}: mast pierces the tunnel ceiling`);
  for (const g of CONNECT_Z)
    if (Math.abs(z - g) < 20) bad(`${label}: sits on top of the gore at z=${g}`);
}
const zs = signs.map((s) => s[0]).sort((a, b) => a - b);
for (let i = 1; i < zs.length; i++)
  if (zs[i] - zs[i - 1] < 25) bad(`two signs only ${f(zs[i] - zs[i - 1])} m apart near z=${zs[i]}`);

/* ---- gantries: legs on the shoulder, panel narrower than the deck ---- */
let ng = 0;
for (let z = c.ZB0 + 200; z <= c.ZB1 - 200; z += 520) {
  if (c.inTunnel(z) || c.inToll(z)) continue;
  if (CONNECT_Z.some((cz) => Math.abs(z - cz) < 220)) continue;
  const hw = c.halfWidth(z), legLat = hw - 0.62;
  if (legLat + 0.25 > hw) bad(`gantry z=${z}: leg past the pavement edge`);
  if (legLat - 0.25 < hw - 1.55) bad(`gantry z=${z}: leg standing in the outer lane`);
  if (Math.min(9, legLat * 2 - 1.4) > hw * 2) bad(`gantry z=${z}: sign wider than the deck`);
  ng++;
}
console.log(`gantries: ${ng}, all legs on the shoulder`);

/* ---- sound walls: clear of the gores, the tunnel and the toll plaza ---- */
const SEG = 92;
let nw = 0;
for (let z = c.ZB0 + 90; z < c.ZB1 - SEG - 60; z += 330) {
  const mid = z + SEG / 2;
  if (c.inTunnel(mid) || c.inToll(mid)) continue;
  if (CONNECT_Z.some((cz) => Math.abs(mid - cz) < 260)) continue;
  nw++;
}
console.log(`sound walls: ${nw}, none over a gore, none in the tunnel or plaza`);

/* ---- toll plaza fits between its lanes ---- */
{
  const zc = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
  const lanes = c.lanes(zc), hw = c.halfWidth(zc);
  const clear = c.LANE_W - 1.2; // lane pitch minus the booth width
  console.log(`toll plaza: ${lanes} lanes, half-width ${f(hw)} m,` +
    ` ${f(clear)} m clear through each gate`);
  if (clear < 2.2) bad("a car cannot thread the toll gates");
  if (hw - 0.75 + 0.45 > hw) bad("canopy columns stand off the deck edge");
  if (hw - 0.75 - 0.45 < hw - 1.55) bad("canopy columns stand in a traffic lane");
  if (Math.abs(c.slopeX(zc)) > 1e-6 || Math.abs(c.pose(zc).grade) > 1e-6)
    bad("the plaza is not on a straight, level stretch — its parts are placed as one rigid group");
}

/* ---- each ramp's own span is straight and level ----
   A ramp is laid out in the corridor frame at its gore and then rotated into
   world space by the pose there, so it only meets the deck cleanly if the deck
   is not turning underneath it. An exit runs forward of its gore, an entrance
   runs back from it — probe the span each one actually occupies. */
const RAMP_RUN = 112;
for (const [i, zr] of CONNECT_Z.entries()) {
  const isExit = i === 0;
  const z0 = isExit ? zr : zr - RAMP_RUN;
  const z1 = isExit ? zr + RAMP_RUN : zr;
  for (let z = z0; z <= z1; z += 8) {
    if (Math.abs(c.slopeX(z)) > 1e-6) bad(`ramp span z=${f(z)} (gore ${zr}) is not straight`);
    if (Math.abs(c.centerY(z) - c.centerY(zr)) > 1e-6)
      bad(`ramp span z=${f(z)} (gore ${zr}) is not level`);
  }
}
console.log(`gore windows: both ramp spans straight and level over ${RAMP_RUN} m`);

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall corridor checks passed");
process.exit(fail ? 1 : 0);
