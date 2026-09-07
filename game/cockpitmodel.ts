import * as THREE from "three";
import { buildStamped } from "@/lib/build";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { Cockpit, SideGlassFit } from "./cockpit";

/* Swaps an imported interior in over the procedural one.

   The procedural cockpit (cockpit.ts) is always built and is always the
   fallback. This loads a donor cabin produced by tools/build-cockpit.mjs, and
   if it arrives intact it hides the procedural regions it replaces and
   re-anchors the live parts onto the donor's geometry. If the fetch fails, the
   model is missing a role, or the user is on a tier that does not want it,
   nothing happens and the procedural dash stays on screen. That fail-soft is
   the whole reason this is a separate module: a 7 MB asset that can 404 must
   never be able to leave the player without a dashboard.

   DONOR-AGNOSTIC BY CONSTRUCTION, and that is what let the shipped asset be
   swapped underneath it. Nothing here knows the file it is reading: roles come
   out of the manifest, placement comes out of the manifest's bounding boxes,
   and the steering rake comes out of its measured column axis. The interior
   that ships today (volvo-s90-full: whole donor nodes, decimated, never
   frustum-clipped) replaced a per-vertex frustum CUT of the same car without
   one line of this file changing shape — the cut is retired because it printed
   sliced edges at wide field of view, and the build tool freezes the `mirror`
   role to the cut's frustum precisely so the anchors below did not move when
   it went.

   Loading is async and deliberately not awaited anywhere. The game starts on
   the procedural dash and the donor pops in a beat later — the same pattern
   world/highway.ts uses for its roadside props.

   What is replaced vs kept:

   - REPLACED  whichever of cockpit.ts's merge regions the donor actually
               supplies. "dash" is the pad, binnacle, vents, stack, console and
               head-unit body; "cabin" is the door cards, pillars, roof and
               headliner. Checked per region rather than assumed: a
               dashboard-only donor brings no pillars, and hiding ours for it
               would open the cabin to the sky.
   - KEPT      seats, glass, mirrors, wipers, the droplet overlay and both
               light rigs — always. The light strips and window glass in
               particular are lighting features tuned against the night pass,
               and a donor's equivalents are inert geometry.
   - MOVED     the instrument cluster (dashboard.ts) and the head-unit canvas
               (carscreen.ts). These stay OURS — they are live, and a donor's
               are painted on — but they relocate onto the donor's binnacle and
               screen so they sit where that car actually puts them. */

/** Roles the build tool tags nodes with. Anything else in the file is ignored. */
interface Manifest {
  source: string;
  parts: Record<string, { name: string; tris: number; bbox: [number[], number[]] }[]>;
  /** Hub and axis of the steering column, measured from the donor's own wheel
      geometry (see build-cockpit.mjs). Absent if the donor has no wheel. */
  steering?: { hub: number[]; axis: number[] };
}

/** Which camera the rear-view mirror is being framed for.

    The two in-car cameras want opposite things out of the donor's mirror
    assembly, so this is a per-camera switch rather than a global preference —
    see the mirror block in wire() for what each state actually does. */
export type MirrorFraming = "dashcam" | "cabin";

export interface CockpitModelHandle {
  /** The donor's root, already parented into the cockpit. */
  group: THREE.Group;
  /** Put the procedural dash back. Cheap — nothing is disposed either way, so
      this is a visibility swap, not a teardown.

      NOTHING OUTSIDE THIS FILE CALLS IT any more. It existed for the J key,
      which A/B'd the donor cabin against the procedural one; the garage decides
      that now (a donor is only fetched for a car that names one, see player.ts
      COCKPIT_MODEL), so the handle lands active and stays active for the life
      of the rig. Kept because the swap it performs is the whole of what this
      module does and every hidden part below is described in terms of it — and
      because a future "show me the procedural cabin" needs no new machinery,
      only a caller. */
  setActive(on: boolean): void;
  /** Level of the donor's fill light, as a multiple of DONOR_FILL. This is the
      donor's half of the cabin light the I key switches — the procedural
      cabin's dome lamp is cockpit.setCabinLight, and engine.ts drives both off
      the one flag so the two interiors can never disagree about whether the
      light is on. Shipped at 0. */
  setFillLight(k: number): void;
  /** Frame the mirror for the DASHCAM (donor housing hidden, glass walked into
      the POV frame by MIRROR_NUDGE) or for the in-car views (donor housing on
      show, glass seated in its aperture where the OEM mirror actually hangs).
      Idempotent and cheap — a few vector copies — so engine.ts can call it on
      any edge it likes. Fail-soft on a donor with no `mirror` role: the glass
      simply stays where the procedural cockpit put it, in both states. */
  setMirrorFraming(mode: MirrorFraming): void;
}

/** The rim shrink the wheel-center pass measured, kept as its own factor so
    the owner's framing scale below multiplies it rather than replacing it. */
const RIM_SHRINK = 0.97;
/** Owner's framing call -- see the long note at the seat below. 1 is the real
    car's 379.5 mm rim; 1.60 is the 607 mm one he picked off the render. */
const WHEEL_SCALE = 1.60;

const BASE = "/models/cockpits/";
/** The two files a donor cabin needs: the part manifest, then the mesh.
    Exported so the menu-time prefetch (game/prefetch.ts, through player.ts's
    donorAssetUrls) names the same two URLs attachCockpitModel will — build
    stamp included, or the prefetched copy would be a different cache entry
    from the one the real request looks for. */
export const cockpitModelUrls = (name: string): string[] =>
  [buildStamped(`${BASE}${name}.json`), buildStamped(`${BASE}${name}.glb`)];

/** Full-on level of the donor's fill light — see the light itself for why it is
    shaped the way it is. Shipped OFF (engine.ts's I key is what turns it on),
    so this is the value the toggle restores rather than the value in the frame. */
const DONOR_FILL = 1.0;

/** Rotation taking +Z onto `axis`, which is how the donor's raked steering
    column is turned into something the engine's `wheelGroup.rotation.z` can
    drive without the rim wobbling. */
function alignZ(axis: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize());
}

/** True spin center + axis of the donor wheel, fitted to the RIM.

    The manifest's `steering.hub` is the wheel cloud's raw vertex CENTROID
    (build-cockpit.mjs), and a steering wheel's vertices are not spread evenly
    about its axle: spokes, thumb buttons and the airbag shroud all sit low, so
    the centroid lands below the axle — on the shipped Volvo by 19 mm, which
    swings the rim ~37 mm sideways at 180° of steer. The reported "wheel isn't
    turning at true center".

    A rim, unlike the cloud, is a genuine circle about the axle, so this fits
    THAT: take the outermost vertex per angular bin around a provisional
    center (72 bins — the outer contour, immune to everything inboard of the
    rim), drop bins off the median radius (spoke gaps, the flat of a grip),
    least-squares the surviving ring to a circle, and re-derive the axis as the
    smallest principal axis of only the vertices near that circle. Iterated a
    few times so center and axis converge together; seeded from the manifest so
    one pass is nearly converged already.

    Returns null when the fit cannot be trusted (degenerate geometry, or a
    result far from the seed), in which case the caller stays on the manifest
    values — misplaced spin beats no wheel. */
function fitWheelPivot(
  wheelParts: THREE.Object3D[],
  seedHub: THREE.Vector3,
  seedAxis: THREE.Vector3,
): { hub: THREE.Vector3; axis: THREE.Vector3 } | null {
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (const p of wheelParts) {
    const g = (p as THREE.Mesh).geometry;
    const a = g?.getAttribute("position");
    if (!a) continue;
    const step = Math.max(1, Math.floor(a.count / 6000));
    for (let i = 0; i < a.count; i += step)
      pts.push(v.fromBufferAttribute(a, i).applyMatrix4(p.matrix).clone());
  }
  if (pts.length < 300) return null;

  /** Smallest principal axis of a cloud — the disc normal. Same inverse power
      iteration as the build tool, on (trace·I − C). */
  const smallestAxis = (cloud: THREE.Vector3[], c: THREE.Vector3): THREE.Vector3 => {
    const C = [0, 0, 0, 0, 0, 0]; // xx, yy, zz, xy, xz, yz
    for (const p of cloud) {
      const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
      C[0] += dx * dx; C[1] += dy * dy; C[2] += dz * dz;
      C[3] += dx * dy; C[4] += dx * dz; C[5] += dy * dz;
    }
    const tr = C[0] + C[1] + C[2];
    const M = [tr - C[0], -C[3], -C[4], -C[3], tr - C[1], -C[5], -C[4], -C[5], tr - C[2]];
    let ax = 0.3, ay = 0.5, az = 0.81;
    for (let it = 0; it < 60; it++) {
      const wx = M[0] * ax + M[1] * ay + M[2] * az;
      const wy = M[3] * ax + M[4] * ay + M[5] * az;
      const wz = M[6] * ax + M[7] * ay + M[8] * az;
      const n = Math.hypot(wx, wy, wz) || 1;
      ax = wx / n; ay = wy / n; az = wz / n;
    }
    return new THREE.Vector3(ax, ay, az);
  };

  const center = seedHub.clone();
  const axis = seedAxis.clone().normalize();
  let R = 0;
  const d = new THREE.Vector3();
  for (let iter = 0; iter < 4; iter++) {
    // in-plane basis
    const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    const w = new THREE.Vector3().crossVectors(axis, u);
    // outer contour: max-radius vertex per angular bin
    const BINS = 72;
    const ring: { x: number; y: number; z: number; r: number }[] = [];
    for (const p of pts) {
      d.subVectors(p, center);
      const qx = d.dot(u), qy = d.dot(w), qz = d.dot(axis);
      const r = Math.hypot(qx, qy);
      const b = Math.floor(((Math.atan2(qy, qx) + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
      if (!ring[b] || r > ring[b].r) ring[b] = { x: qx, y: qy, z: qz, r };
    }
    let bins = ring.filter(Boolean);
    if (bins.length < 24) return null;
    const med = bins.map((c) => c.r).sort((a, b) => a - b)[bins.length >> 1];
    bins = bins.filter((c) => Math.abs(c.r - med) / med < 0.06);
    if (bins.length < 18) return null;
    // least-squares circle (Kåsa) in the plane
    let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0;
    const n = bins.length;
    for (const c of bins) {
      const z2 = c.x * c.x + c.y * c.y;
      Sx += c.x; Sy += c.y; Sxx += c.x * c.x; Syy += c.y * c.y; Sxy += c.x * c.y;
      Sxz += c.x * z2; Syz += c.y * z2; Sz += z2;
    }
    const A00 = 2 * (Sxx - (Sx * Sx) / n), A01 = 2 * (Sxy - (Sx * Sy) / n), A11 = 2 * (Syy - (Sy * Sy) / n);
    const B0 = Sxz - (Sx * Sz) / n, B1 = Syz - (Sy * Sz) / n;
    const det = A00 * A11 - A01 * A01;
    if (Math.abs(det) < 1e-12) return null;
    const cx = (B0 * A11 - B1 * A01) / det, cy = (A00 * B1 - A01 * B0) / det;
    R = Math.sqrt((Sz - 2 * (cx * Sx + cy * Sy)) / n + cx * cx + cy * cy);
    const zMean = bins.reduce((s, c) => s + c.z, 0) / n;
    center.addScaledVector(u, cx).addScaledVector(w, cy).addScaledVector(axis, zMean);
    // axis from the rim band only — the part of the cloud that IS a circle
    const band = pts.filter((p) => {
      d.subVectors(p, center);
      const along = d.dot(axis);
      const rad = Math.sqrt(Math.max(0, d.lengthSq() - along * along));
      return Math.abs(rad - R) / R < 0.12;
    });
    if (band.length > 200) {
      const bc = band.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(band.length);
      const na = smallestAxis(band, bc);
      if (na.dot(axis) < 0) na.negate(); // keep pointing back toward the driver
      axis.copy(na);
    }
  }
  // trust gates: a real car's rim radius, near the seed, near the seed's rake
  if (R < 0.1 || R > 0.35) return null;
  if (center.distanceTo(seedHub) > 0.15) return null;
  if (axis.angleTo(seedAxis) > 0.2) return null;
  return { hub: center, axis };
}

export function attachCockpitModel(
  cockpit: Cockpit,
  name: string,
  onDone?: (h: CockpitModelHandle | null) => void,
): void {
  const fail = (why: string, err?: unknown) => {
    console.warn(`[cockpitmodel] ${name}: ${why} — keeping the procedural dash`, err ?? "");
    onDone?.(null);
  };

  /* BOTH AT ONCE. The GLB load used to be started from the manifest fetch's
     .then, which put a whole round trip in front of the biggest download the
     game makes — 5.7 MB that could not begin until a 12 KB sibling had landed.
     Measured on Slow 4G, the manifest was requested 10.4 s after the DRIVE
     press and the mesh 8.6 s after THAT; the loading stage that waits on this
     spends its entire 8 s budget and gives up either way.

     Nothing in the GLB request depends on the manifest's CONTENT — it only
     ever decided whether to bother — so they are two independent fetches of
     two static siblings and the only thing serialising them buys is the 5.7 MB
     not being spent when the 12 KB 404s. That is a trade worth reversing: the
     manifest is deployed with the mesh and fails essentially only when the
     mesh does.

     EXT_meshopt_compression is REQUIRED by the shipped interior, so a loader
     without this decoder does not degrade — it rejects the file and the player
     gets the procedural dash. Meshopt rather than Draco because the decoder is
     a plain ES module that bundles with the app, where Draco needs wasm files
     served out of public/. */
  const [manifestUrl, meshUrl] = cockpitModelUrls(name);
  const manifestP = fetch(manifestUrl)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest HTTP ${r.status}`))));
  const meshP = new Promise<THREE.Group>((res, rej) => {
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load(
      meshUrl,
      (gltf) => res(gltf.scene),
      undefined,
      rej,
    );
  });
  /* Both rejections are attached before either is awaited, so whichever loses
     the race cannot surface as an unhandled rejection while the other is still
     in flight. */
  let failed = false;
  const note = (why: string) => (e: unknown) => {
    if (!failed) { failed = true; fail(why, e); }
    return null;
  };
  void Promise.all([
    manifestP.catch(note("manifest failed to load")),
    meshP.catch(note("model failed to load")),
  ]).then(([m, scene]) => {
    if (failed || !m || !scene) return;
    try { onDone?.(wire(cockpit, scene, m as Manifest)); } catch (e) { fail("wiring failed", e); }
  });
}

/* ---------------------------------------------------------- door mirrors -- */

/** What makes a `sideMirror` part the mirror PLATE rather than the housing
    around it: flat to within this (metres, along its own normal)... */
const PLATE_MAX_THICK = 0.004;
/** ...and at least this wide in both in-plane directions. Rules out the
    signal lens strips (14 cm x 1.5 cm) and the little sensor squares (1 cm)
    while a real mirror glass (this donor's is 17 x 11 cm) clears it easily. */
const PLATE_MIN_SPAN = 0.06;
/** Two outline points closer than this are one point: the plate's front and
    back faces both contribute a boundary loop, and they sit ~1.5 mm apart. */
const PLATE_DEDUPE = 0.0015;

/** Fit for one side's door-mirror glass, measured off the donor's own mirror
    plate — or null when no part of the role reads as a plate on that side.

    The plate is identified by geometry, never by name: among the role's parts,
    the vertices on side `s` of a part that lie in one plane (thinnest axis
    under PLATE_MAX_THICK) and span a mirror's worth of that plane. Its
    boundary loop — every edge with a single triangle on it — is the outline
    the glass takes, and the plane's normal is the glass's aim. The Volvo's
    "chrome bezel" is exactly this: not a ring but a filled plate with one
    boundary loop, which is what made the old inscribed rectangle wrong.

    Everything is in cockpit-local metres: `m.matrix` is already cockpit-local
    (see wire()) and `scale` is the donor scene's counter-scale. */
function platePlane(m: THREE.Mesh, s: 1 | -1, scale: THREE.Vector3): { fit: SideGlassFit; area: number } | null {
  const geo = m.geometry as THREE.BufferGeometry;
  const idx = geo.index;
  const pos = geo.getAttribute("position");
  if (!idx || !pos) return null;
  const P: THREE.Vector3[] = [];
  const on: boolean[] = [];
  const c = new THREE.Vector3();
  let n0 = 0;
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrix).multiply(scale);
    P.push(v);
    const ok = Math.sign(v.x) === s;
    on.push(ok);
    if (ok) { c.add(v); n0++; }
  }
  if (n0 < 8) return null;
  c.divideScalar(n0);
  /* covariance, and its smallest-eigenvalue direction by power iteration on
     (trace*I - C): the same numbers a PCA would give, without a solver */
  const C = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  const d = new THREE.Vector3();
  for (let i = 0; i < P.length; i++) {
    if (!on[i]) continue;
    d.copy(P[i]).sub(c);
    C[0] += d.x * d.x; C[1] += d.x * d.y; C[2] += d.x * d.z;
    C[3] += d.y * d.y; C[4] += d.y * d.z; C[5] += d.z * d.z;
  }
  const tr = C[0] + C[3] + C[5];
  const M = [tr - C[0], -C[1], -C[2], -C[1], tr - C[3], -C[4], -C[2], -C[4], tr - C[5]];
  const n = new THREE.Vector3(0.3, 0.1, 0.9);
  for (let k = 0; k < 60; k++) {
    n.set(M[0] * n.x + M[1] * n.y + M[2] * n.z, M[3] * n.x + M[4] * n.y + M[5] * n.z, M[6] * n.x + M[7] * n.y + M[8] * n.z);
    if (n.lengthSq() < 1e-30) return null;
    n.normalize();
  }
  if (n.z < 0) n.negate(); // forward, the convention placeSideGlass wants
  const u = new THREE.Vector3(n.z, 0, -n.x).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  let du0 = Infinity, du1 = -Infinity, dv0 = Infinity, dv1 = -Infinity, dn0 = Infinity, dn1 = -Infinity;
  for (let i = 0; i < P.length; i++) {
    if (!on[i]) continue;
    d.copy(P[i]).sub(c);
    const a = d.dot(u), b = d.dot(v), e = d.dot(n);
    du0 = Math.min(du0, a); du1 = Math.max(du1, a);
    dv0 = Math.min(dv0, b); dv1 = Math.max(dv1, b);
    dn0 = Math.min(dn0, e); dn1 = Math.max(dn1, e);
  }
  if (dn1 - dn0 > PLATE_MAX_THICK || du1 - du0 < PLATE_MIN_SPAN || dv1 - dv0 < PLATE_MIN_SPAN) return null;

  /* boundary loop: edges used by exactly one triangle, on this side only */
  const count = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * 1048576 + b : b * 1048576 + a);
  for (let i = 0; i + 2 < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), e = idx.getX(i + 2);
    if (!on[a] || !on[b] || !on[e]) continue;
    for (const k of [key(a, b), key(b, e), key(e, a)]) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const rim = new Set<number>();
  for (const [k, cnt] of count) if (cnt === 1) { rim.add(Math.floor(k / 1048576)); rim.add(k % 1048576); }
  if (rim.size < 6) return null;
  /* outline in the plate frame about the rim's bbox centre (the same centre
     convention cockpit.ts's measured default uses), walked by angle — the
     plate is star-shaped about its centre, so that IS its boundary order —
     with the back face's twin of each point dropped */
  const pts: [number, number][] = [];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const i of rim) {
    d.copy(P[i]).sub(c);
    const a = d.dot(u), b = d.dot(v);
    pts.push([a, b]);
    u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
  }
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  const ang = pts.map(([a, b]) => ({ a: a - uc, b: b - vc, t: Math.atan2(b - vc, a - uc) })).sort((p, q) => p.t - q.t);
  const outline: [number, number][] = [];
  for (const q of ang) {
    const last = outline[outline.length - 1];
    if (last && Math.hypot(last[0] - q.a, last[1] - q.b) < PLATE_DEDUPE) continue;
    outline.push([q.a, q.b]);
  }
  if (outline.length < 6) return null;
  /* the glass covers the face NEAREST the driver (least depth along n) */
  const centre = c.clone().addScaledVector(u, uc).addScaledVector(v, vc).addScaledVector(n, dn0);
  return { fit: { centre, normal: n, outline }, area: (u1 - u0) * (v1 - v0) };
}

/** Re-fit both door glasses to the donor's mirror plates — see platePlane.
    Largest plate wins a side; a side with none keeps cockpit.ts's default. */
function fitDoorMirrors(cockpit: Cockpit, parts: THREE.Object3D[], scale: THREE.Vector3) {
  for (const s of [1, -1] as const) {
    let best: { fit: SideGlassFit; area: number } | null = null;
    for (const o of parts) {
      const m = o as THREE.Mesh;
      if (!m.isMesh) continue;
      const r = platePlane(m, s, scale);
      if (r && (!best || r.area > best.area)) best = r;
    }
    if (best) cockpit.fitSideMirror(s, best.fit);
    else console.warn(`[cockpitmodel] no door-mirror plate found on side ${s > 0 ? "L" : "R"}; keeping the built-in glass`);
  }
}

function wire(cockpit: Cockpit, scene: THREE.Group, man: Manifest): CockpitModelHandle {
  /* Look parts up by role, not by node name: node names are the donor's, and
     every donor spells them differently. The manifest is the only place a
     donor-specific string is allowed to appear. */
  const byRole = (role: string): THREE.Object3D[] =>
    (man.parts[role] ?? [])
      .map((p) => scene.getObjectByName(p.name))
      .filter((o): o is THREE.Object3D => !!o);

  /* Which procedural regions this donor is entitled to replace. Derived from
     what it actually brought, not assumed: a dashboard-only donor has no
     "cabin" parts, and hiding our pillars for it would open the cabin to the
     sky. Roles map to cockpit.ts's merge regions. */
  const supplies = new Set<string>();
  if ((man.parts.shell ?? []).length) supplies.add("dash");
  if ((man.parts.cabin ?? []).length) supplies.add("cabin");
  if ((man.parts.mirror ?? []).length) supplies.add("mirror");

  const cluster = byRole("cluster")[0];
  const screen = byRole("screen")[0];
  if (!cluster || !screen) {
    /* Name the roles AND what did arrive: the failure this guards against is a
       lookup miss, and "which names does the scene actually have" is the only
       thing that tells you whether the build tool or the loader dropped it. */
    throw new Error(
      `missing role(s): ${[!cluster && "cluster", !screen && "screen"].filter(Boolean).join(", ")}; ` +
      `scene has [${scene.children.map((c) => c.name).join(", ")}]`,
    );
  }

  /* EVERY transform below is computed in cockpit-group-local space, and that
     is load-bearing rather than stylistic.

     The donor scene is attached to cockpit.group at the END of this function.
     Until then its nodes' `matrixWorld` is relative to a detached root — while
     `cockpit.wheelGroup.matrixWorld` is a real world matrix carrying
     cockpit.group's offset and scale, bodyG, and carGroup's world position AND
     heading rotation. Mixing the two yields a transform wrong by wherever the
     car happens to be standing and whichever way it is pointing, which puts
     the rim somewhere near the roof.

     Local space avoids the whole question: build-cockpit.mjs bakes each donor
     node's world matrix into its LOCAL matrix and parents every node straight
     to the scene root, so a donor node's `matrix` already IS its cockpit-local
     matrix. No world matrices are needed here at all. */
  scene.updateMatrixWorld(true);
  for (const c of scene.children) c.updateMatrix();

  /* cockpit.group carries a non-uniform x-scale so the procedural trim can be
     fitted to each car's width. A donor dash is a real object at real
     proportions and cannot absorb that: at the kei car's 1.48/1.84 it would be
     squeezed 20% along one axis only. Counter-scaling y and z to match turns
     the parent's (sx,1,1) into a uniform (sx,sx,sx) — the dash then shrinks
     evenly to suit a smaller car instead of being flattened. */
  const sx = cockpit.group.scale.x;
  scene.scale.set(1, sx, sx);

  /* --- the donor's own screens ------------------------------------------- */

  /* Its cluster is a painted-on picture of gauges, so it goes: ours is live
     and has real needles. Its centre screen stays and takes our nav canvas —
     that one IS just a lit rectangle, which is exactly what a texture is for. */
  cluster.visible = false;
  /* Its cover glass goes with it. The pane is a near-black blended shell
     (baseColor ~0.007, alpha ~0.68, double-sided) sitting between the eye and
     our relocated gauges, and the scan is dense enough that a POV ray crosses
     it several times — each layer multiplies through, dimming the cluster
     roughly 25x. Fail-soft: byRole returns [] for donors without the role. */
  for (const g of byRole("clusterGlass")) g.visible = false;
  /* Centre of the donor binnacle in cockpit-local space: the mesh's own
     geometry bounds pushed through its (already cockpit-local) matrix. */
  const clusterMesh = cluster as THREE.Mesh;
  clusterMesh.geometry.computeBoundingBox();
  const clusterAt = clusterMesh.geometry.boundingBox!
    .getCenter(new THREE.Vector3())
    .applyMatrix4(clusterMesh.matrix)
    .multiply(scene.scale);

  for (const m of screen.type === "Mesh" ? [screen as THREE.Mesh] : []) {
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
    mat.map = cockpit.screenTexture;
    /* Same reasoning as the procedural head unit: an LCD is a light source,
       and tone-mapped down it reads as a dead black slab at night. */
    mat.emissiveMap = cockpit.screenTexture;
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveIntensity = 1.15;
    mat.toneMapped = false;
    mat.needsUpdate = true;
    /* Hand the mesh over so post.ts can shield THIS panel from the dashcam
       degrade once the donor is on show — the map is only worth reading if it
       stays sharp, and after the swap the procedural tablet it was projecting
       is hidden inside the dash. */
    cockpit.donorScreen = m;
  }

  /* --- our live parts, relocated ----------------------------------------- */

  /* The cluster keeps its own orientation (it is built facing the driver) and
     only moves: the donor binnacle's centre is a far better anchor than the
     procedural POD constant, which was fitted to different geometry. */
  const clusterHome = cockpit.clusterGroup.position.clone();
  cockpit.clusterGroup.position.copy(clusterAt);

  /* --- rear-view mirror --------------------------------------------------- */

  /* Take the donor's housing, keep our glass. A donor mirror is a painted
     rectangle; ours is fed by a render target, UV-cropped to its own slice of
     the rear camera, and registered with post.ts so the dashcam degrade does
     not chew it. So the procedural SHELL hides (region "mirror") and the glass
     moves into the donor's.

     This also fixes the framing for free. The procedural mirror hangs at
     EYE.y + 0.085 (y 1.435), which was fitted to a lens 12 cm higher than the
     imported dash uses — from the lower mount it rides the very top edge of
     the frame and shows housing underside rather than glass. The Volvo hangs
     its mirror at y ~1.31, so following the donor drops it ~12 cm and puts the
     glass back in shot. */
  /* Nudge applied to the donor's whole mirror assembly, housing and glass
     together. The Volvo hangs its mirror at z 0.44 — only 12.7 cm ahead of the
     POV lens at z 0.31 — and that proximity, not its height, is what puts it
     out of shot: the visible half-height at 12.7 cm is 0.07, while the glass
     centre sits 0.14 above the lens axis. Dropping it alone would have to go
     absurdly low to win. Moving it FORWARD instead buys frame cheaply, and it
     is where the mirror belongs anyway: the donor's windscreen passes through
     z ~0.58 at this height, so +0.10 parks the housing against the glass it
     would really be stuck to, instead of floating 14 cm behind it. The small
     drop then settles it just inside the top edge.

     THE Y TERM TRACKS THE LENS, and is the one number here that is not free.
     The mirror hangs ABOVE the lens, so its height in frame is set by the gap
     between the two and by nothing else: at the tuned placement the glass
     centre projects to 86% of the way up the frame at the default field of
     view, which is just inside the top edge, and it takes only ~2.5 cm of
     extra gap to push it off the top entirely. engine.ts dropped
     POV_MOUNT_DY_IMPORTED by 25 mm (-0.15 -> -0.175) for the seating position,
     so this dropped by exactly 25 mm too (-0.04 -> -0.065) and the gap — and
     therefore the framing — is unchanged. If that constant moves again, move
     this by the same amount in the same direction.

     The x and z terms are framing choices rather than physical ones. The Volvo
     hangs its mirror on the car's centreline (x ~0.01) while the POV lens sits
     inboard of the driver at x 0.28, so a centred mirror lands right of frame
     centre — true to where a real mirror is, but it crowds that side. +x is
     screen-LEFT here (car-local +x maps to screen-left through the POV
     camera's heading), so this walks the whole assembly back toward the middle
     of the frame. Those two are cosmetic; move them freely. */
  const MIRROR_NUDGE = new THREE.Vector3(0.08, -0.04, 0.10);

  const mirrorParts = byRole("mirror");
  const glass = cockpit.mirrorGlass;
  const frame = cockpit.mirrorFrame;
  const glassHome = {
    position: glass.position.clone(),
    quaternion: glass.quaternion.clone(),
    scale: glass.scale.clone(),
  };
  /* The frame travels with the glass. It lives outside the "mirror" merge
     region precisely so it survives this donor taking that region over — see
     cockpit.ts — but surviving is only half of it: parked at its procedural
     home while the glass moved to the donor's mounting point, it would frame
     empty air a hand's width from the mirror. */
  const frameHome = {
    position: frame.position.clone(),
    quaternion: frame.quaternion.clone(),
    scale: frame.scale.clone(),
  };
  /* TWO placements, one per in-car camera, because the mirror the DASHCAM
     needs and the mirror the COCKPIT needs are not the same object.

     - "dashcam": the donor housing is HIDDEN and the glass is walked forward
       and down by MIRROR_NUDGE. Byte-for-byte what this file has always done;
       the reasoning is in the MIRROR_NUDGE block above and in the housing note
       below, and none of it is negotiable — it is the shipping view.
     - "cabin": the donor housing is SHOWN, unmoved, and the glass is seated in
       its aperture. From an eye 0.5 m back the housing reads as what it is —
       the car's own mirror — instead of the unlit lump it becomes 12 cm from a
       105-degree lens, and there is no framing problem to nudge away from: the
       glass is nowhere near the edge of that frame.

     Only the position and the housing's visibility differ. The SCALE is shared
     (the aperture is the aperture), and so is the glass itself — one
     render-target-fed plane, registered once with post.ts, moved between two
     mounting points. */
  let glassAt: THREE.Vector3 | null = null;
  let glassCabin: THREE.Vector3 | null = null;
  let glassScale = 1;
  /* Where the donor hung its mirror before MIRROR_NUDGE touched it. The nudge
     used to be baked into `p.position` once, at wire time; it is applied and
     removed per framing now, so the untouched positions have to be kept. */
  const mirrorHome = mirrorParts.map((p) => p.position.clone());
  let framing: MirrorFraming = "dashcam";

  if (mirrorParts.length) {
    const box = new THREE.Box3();
    for (const p of mirrorParts) {
      const m = p as THREE.Mesh;
      if (!m.geometry) continue;
      m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrix));
    }
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    /* Sit on the housing's cabin-facing face (min z — the driver looks toward
       +z), a hair proud so the glass never z-fights the shell it sits in. */
    glassAt = new THREE.Vector3(mid.x, mid.y, box.min.z - 0.004)
      .add(MIRROR_NUDGE)
      .multiply(scene.scale);
    /* Cabin framing: the same face, 8 mm proud instead of 4, and no nudge —
       the housing is on show here, so the glass has to sit where the housing
       says rather than where the POV frame wants it. The extra 4 mm is
       clearance, not taste: mirrorFrame's shell is 7 mm deep and sits BEHIND
       the glass plane (cockpit.ts), which at 4 mm buries its back millimetre
       inside the housing's front face and invites a z-fight along the rim. */
    glassCabin = new THREE.Vector3(mid.x, mid.y, box.min.z - 0.008).multiply(scene.scale);
    /* Fit the glass to the housing's aperture rather than assuming a size:
       ours is 0.30 m wide and the Volvo's body is 0.21, so at native size it
       would hang out either side of its own frame. Inset slightly so a bezel
       still reads around it. */
    glassScale = Math.min(1, (size.x * 0.88) / 0.30) * sx;

    /* The donor's mirror BODY is hidden IN THE DASHCAM, and only its glass
       survives there.

       Two reasons. The read one: the Volvo's housing is a moulded shell that
       was authored to be seen from outside the car in a showroom render, and
       from 12 cm in front of a 105-degree dashcam lens it fills a chunk of
       the frame as an unlit plastic lump behind the mirror — the reported
       "plastic mirror holder, it's glitched". The geometric one: it was
       modelled around ITS OWN glass, and ours is a different size and gets
       rescaled to fit the aperture, so the shell and the glass it frames no
       longer agree.

       NEITHER reason survives the move to the cockpit view, which is why that
       one shows it: at half a metre the shell is scenery rather than a wall,
       and mirrorFrame — our own thin bezel, which travels with the glass — is
       what covers the size disagreement, sitting inside the housing's outline
       on every edge (0.19 x 0.062 against 0.215 x 0.076 at the shipped fit).

       The parts stay in the scene graph rather than being removed in either
       state, because the bbox above is what positions the glass — deleting
       them would take the anchor with them. */
  }

  /* --- steering ----------------------------------------------------------- */

  /* engine.ts drives `wheelGroup.rotation.z` and knows nothing about donors,
     so the donor rim is hung inside that same group and an OUTER group carries
     the hub position and the column rake. Putting the rake on wheelGroup
     itself would not survive: the engine assigns rotation.z every frame, which
     rewrites the whole Euler and would flatten the rake back out. */
  const wheelParts = byRole("wheel");
  const proceduralWheel = [...cockpit.wheelGroup.children];
  let axisG: THREE.Group | null = null;
  /* Where wheelGroup sat before the donor took it over. setActive has to put
     it back exactly: it is moved INTO the donor scene below, and hiding that
     scene would otherwise take the procedural rim down with it and leave the
     A/B toggle showing a car with no steering wheel at all. */
  const wheelHome = {
    parent: cockpit.wheelGroup.parent,
    position: cockpit.wheelGroup.position.clone(),
    quaternion: cockpit.wheelGroup.quaternion.clone(),
    scale: cockpit.wheelGroup.scale.clone(),
  };

  if (wheelParts.length && man.steering) {
    const { hub, axis } = man.steering;
    /* The manifest hub is a centroid and the centroid of THIS wheel sits ~19 mm
       below the axle (see fitWheelPivot) — spin about it and the rim orbits
       instead of turning in place. Re-fit the pivot to the rim circle of the
       geometry actually loaded; the manifest stays the seed and the fallback. */
    const fitted = fitWheelPivot(
      wheelParts,
      new THREE.Vector3(hub[0], hub[1], hub[2]),
      new THREE.Vector3(axis[0], axis[1], axis[2]),
    );
    axisG = new THREE.Group();
    axisG.name = "donorSteeringAxis";
    if (fitted) {
      axisG.position.copy(fitted.hub);
      axisG.quaternion.copy(alignZ(fitted.axis));
    } else {
      axisG.position.set(hub[0], hub[1], hub[2]);
      axisG.quaternion.copy(alignZ(new THREE.Vector3(axis[0], axis[1], axis[2])));
    }
    /* Hung inside the donor scene, not beside it, so the hub and the rim share
       one space and the width fitting above applies to both. It also keeps the
       rotation clear of shear: cockpit.group's (sx,1,1) and the scene's
       (1,sx,sx) both sit ABOVE this rotation and multiply out to a plain
       isotropic sx, whereas a rotation placed between them would skew the rim
       into an ellipse. */
    scene.add(axisG);
    axisG.updateMatrix();

    /* Re-parent rather than reposition: the engine's handle has to stay the
       same object or every call site would need to learn about donors. */
    cockpit.wheelGroup.position.set(0, 0, 0);
    cockpit.wheelGroup.rotation.set(0, 0, 0);
    cockpit.wheelGroup.scale.setScalar(1);
    axisG.add(cockpit.wheelGroup);

    /* wheelGroup sits at identity inside axisG, so "local to axisG" and "local
       to wheelGroup" are the same thing — one inverse, no world matrices. */
    const inv = axisG.matrix.clone().invert();
    for (const p of wheelParts) {
      p.updateMatrix();
      const local = inv.clone().multiply(p.matrix);
      p.parent?.remove(p);
      local.decompose(p.position, p.quaternion, p.scale);
      cockpit.wheelGroup.add(p);
    }
    // the donor's own rim replaces ours; the moulded hands go with it
    for (const c of proceduralWheel) c.visible = false;

    /* Seat the wheel a column-adjustment lower than the donor authored it.
       From the dashcam the rim's upper arc crossed the cluster mid-face: it
       buried the gear digit and the digital speed at center, and the spokes
       swept over the tacho needle at half lock ("the wheel covers the dash").
       Geometry of the sightline: the lens sits ~0.29 m behind the rim and
       ~0.54 m ahead of the cluster face, so the arc's shadow on the cluster
       moves ~1.86x any wheel move — 28 mm down here walks the arc ~52 mm down
       the 154 mm cluster face, from mid-dial to below the dial numbers. The
       3% shrink (a 37 cm rim instead of 38) buys the last ~6 mm. Both are
       within a real car's column/trim spread, and the hub stays below the
       frame edge in POV, so nothing reads as floating.

       28 -> 56 mm BECAUSE THE DASHCAM IS THE ONLY VIEW THAT NUMBER WAS FITTED
       IN, and it is not the view the wheel covers. Same sightline, different
       eye: CAM_COCKPIT sits 310 mm further BACK (cockpit-local z 0.0 against
       the dashcam lens at 0.31), so its eye-to-cluster over eye-to-rim ratio
       is 1.42 rather than 1.86 and the rim's arc lands 65% up the cluster
       face instead of 32% — straight across the digital speed. Measured
       rather than eyeballed (test/wheel-cluster-measure.mjs; the whole table
       is in docs/handoff/reports/wheel-cluster.md): of the speed readout's
       own pixels, 79% were behind the rim in COCKPIT and 12% in CONSOLE, at
       every steering angle, parked and at 120 km/h, on desktop and phone
       frames alike. Another 28 mm takes those to 4% and 0%, and the dashcam —
       judged first, and not allowed to go backwards — improves as well:
       cluster face 17.3% -> 4.0% hidden, gear digit 63% -> 0%, which closes
       the item the wheel-center pass left open.

       The bound on this is the COLUMN, not the rim: the donor's `column`
       shroud and its stalks are separate roles and do NOT move with axisG, so
       every millimetre here is a millimetre of gap between the wheel boss and
       the shroud behind it. At 56 mm the boss still covers it in all three
       in-car views (CONSOLE sees the most of it); much past that and the
       wheel starts floating off its own column. WHEEL_SCALE is the owner's call and
       deliberately not realistic. He sent a photograph of a BMW's
       driver's-eye view and asked for the cluster to sit inside the wheel's
       opening the way it does there. The sweep that answered it
       (test/wheel-scale-shots.mjs, cameras untouched) found the rim's top arc
       starts 0.199 diameters BELOW the cluster's top edge and climbs as the
       wheel grows, crossing zero only at about 1.44 -- so every step short of
       that walks the arc UP ACROSS the dials and looks worse than shipping.
       1.30 matches the reference's binnacle proportion exactly (0.729 against
       0.73) and is the worst frame in the set. 1.60 is the first that reads
       like the photograph, and he picked it off the render. It is a 607 mm
       rim against a real S90's 370: a deliberate cheat, because the camera
       cannot come forward far enough to make an honest one without reopening
       the settled mirror framing. Set WHEEL_SCALE to 1 for the real car's
       proportions; the near plane is never at risk either way, the closest
       rim point being 0.630 m against a 0.08 m near plane.

       Applied AFTER the re-parenting above, deliberately: the locals were
       taken against the un-nudged axisG matrix, so the rim sits exactly on
       the fitted pivot and the whole assembly -- pivot and rim together --
       drops and scales as one. Nudging before that inverse would bake the
       offset into the locals and move nothing while un-centering the spin. */
    axisG.position.y -= 0.056;
    axisG.scale.setScalar(RIM_SHRINK * WHEEL_SCALE);
  }

  /* --- fill light --------------------------------------------------------- */

  /* Replaces the reach of the ambient strips this donor displaces. Those were
     pinned to the procedural door card and left with it, and cockpit.ts is
     blunt about what they were for: without an interior source "the vents,
     glovebox and console reduce to a black mass however well they are
     modelled". That is exactly what a donor dash inherits.

     Shaped to WIDEN rather than brighten, which is the thing that actually
     survives the POV chain. That chain crushes everything under 0.06 to pure
     black and then takes up to 55% more off at the frame edge, so a small hot
     spot buys one bright patch and leaves the rest below the floor — while a
     broad, gentle wash lifts the whole pad over it. Hence:

     - decay 1, not the physical 2. 1/r instead of 1/r^2 spreads an even carpet
       across a 1.5 m dash instead of blowing out whatever is nearest and
       dropping the corners through the floor. Same reasoning as the low beam
       in engine.ts.
     - distance 4.0 against a dash barely 1.3 m away. `distance` is a HARD clip
       in three, not a falloff, so it has to land far past anything visible or
       it prints its own edge on the trim.
     - 0xffb070 rather than a paler warm. The manual ACES pass desaturates as
       luma climbs, so a source has to sit further toward yellow than the
       colour you actually want; a pale tint arrives white and reads as a
       flashlight rather than cabin ambience.

     Parented to the donor scene so it lives and dies with it — the procedural
     dash keeps its own strips and must not be lit twice. */
  const fill = new THREE.PointLight(0xffb070, DONOR_FILL, 4.0, 1.0);
  fill.position.set(0.05, 1.22, 0.42);
  /* All of which is still true — and is exactly why it ships OFF now. Everything
     above is a recipe for a wash that covers the WHOLE pad evenly, and an evenly
     covered pad is a lit interior. At night it should be a black mass: the
     reference frame this look is tuned against reads its dash from a grazing
     highlight along the crest and from nothing else, and the wash is what was
     standing where that highlight should be. The light stays built and stays
     tuned, because the I key is a comparison tool and the ON state has to be
     the good version of ON.

     Intensity rather than `visible`, same reason as the procedural dome lamp:
     dropping a light out of the list re-hashes every lit program in the cabin. */
  fill.intensity = 0;
  scene.add(fill);

  const setFillLight = (k: number) => { fill.intensity = DONOR_FILL * k; };

  /* --- door mirrors ------------------------------------------------------ */

  /* Our RT-fed door glasses take the shape and plane of the donor's own
     mirror plates. The `sideMirror` role is a bag of parts (this donor brings
     seven: cap, base, signal lenses, sensors, a chrome plate) and the plate is
     found by what it is, not what it is called — see platePlane. The glass
     was an inscribed rectangle that neither fit the plate's trapezoid nor
     covered it, which is the "squares that don't fit inside the mirrors"
     report; see SIDE_GLASS_OUTLINE in cockpit.ts. The parts stay visible:
     the plate is what the glass is drawn over, 1 mm proud. Fail-soft — a
     side with no plate keeps cockpit.ts's default, which is the PROCEDURAL
     cabin's placement (a good 10 cm above this donor's plate, over its own
     belt rail), so the warning below is worth acting on. */
  fitDoorMirrors(cockpit, byRole("sideMirror"), scene.scale);

  /* --- attach ------------------------------------------------------------- */

  cockpit.group.add(scene);

  const setActive = (on: boolean) => {
    scene.visible = on;
    for (const [name, gp] of Object.entries(cockpit.regionGroups)) {
      // regions this donor did not supply stay visible in both states
      gp.visible = on ? !supplies.has(name) : true;
    }
    cockpit.screenMesh.visible = !on;
    /* The procedural window panes go with the procedural cabin. They are
       hand-placed against ITS openings and live outside every merge region, so
       nothing else here hides them — under a donor they float as pale squares
       in the middle of that car's glazing. The donor brings its own. */
    for (const w of cockpit.windowGlass) w.visible = !on;
    for (const c of proceduralWheel) c.visible = !on;
    for (const p of wheelParts) p.visible = on;
    /* wheelGroup is the engine's handle and has to keep steering either way,
       so it moves between the donor's raked axis and its original mount rather
       than being hidden with whichever dash is off. */
    if (axisG) {
      if (on) {
        axisG.add(cockpit.wheelGroup);
        cockpit.wheelGroup.position.set(0, 0, 0);
        cockpit.wheelGroup.quaternion.identity();
        cockpit.wheelGroup.scale.setScalar(1);
      } else {
        wheelHome.parent?.add(cockpit.wheelGroup);
        cockpit.wheelGroup.position.copy(wheelHome.position);
        cockpit.wheelGroup.quaternion.copy(wheelHome.quaternion);
        cockpit.wheelGroup.scale.copy(wheelHome.scale);
      }
    }
    cockpit.clusterGroup.position.copy(on ? clusterAt : clusterHome);

    placeMirror(on);
  };

  /* Both halves of the mirror swap in one place, because both have to agree:
     the housing's position, the housing's visibility and the glass's mounting
     point are one decision made three times. Called from setActive (the donor
     going away takes the mirror home with it) and from setMirrorFraming. */
  function placeMirror(on: boolean) {
    if (glassAt && glassCabin && on) {
      const cabin = framing === "cabin";
      const at = cabin ? glassCabin : glassAt;
      /* The housing follows the glass, or the two come apart — and it only
         follows in the dashcam framing, where the glass was moved. */
      for (let i = 0; i < mirrorParts.length; i++) {
        const p = mirrorParts[i];
        p.position.copy(mirrorHome[i]);
        if (!cabin) p.position.add(MIRROR_NUDGE);
        p.visible = cabin;
      }
      /* scale.x stays negative: cockpit.ts flips the glass so the rear camera's
         backward view reads as a mirror rather than a shoulder-check. Losing
         that sign would silently un-mirror the reflection. */
      glass.position.copy(at);
      glass.scale.set(-glassScale, glassScale, glassScale);
      /* Same place and the same scale, but NOT the negative x: the flip exists
         to un-mirror the rear camera's image and the frame has no image to
         un-mirror. Negating it too would turn the shell inside out — its faces
         would wind backwards and it would render as the far side of itself.
         The glass sits at frame z +0.002 in cockpit.ts — in the plane of the
         lip, not in front of it — so the frame origin is 2 mm BEHIND the
         glass, and the sign matters: +0.004 here used to push the rim further
         back still and leave the pane standing proud of it. */
      frame.position.set(at.x, at.y, at.z - 0.002 * glassScale);
      frame.quaternion.copy(glass.quaternion);
      frame.scale.setScalar(glassScale);
    } else {
      glass.position.copy(glassHome.position);
      glass.quaternion.copy(glassHome.quaternion);
      glass.scale.copy(glassHome.scale);
      frame.position.copy(frameHome.position);
      frame.quaternion.copy(frameHome.quaternion);
      frame.scale.copy(frameHome.scale);
    }
  }

  const setMirrorFraming = (mode: MirrorFraming) => {
    if (mode === framing) return;
    framing = mode;
    /* scene.visible IS the imported/procedural state (setActive sets nothing
       else on the root), so this stays a no-op while the procedural dash is
       up and the framing is picked up whenever the donor comes back. */
    placeMirror(scene.visible);
  };
  setActive(true);

  return { group: scene, setActive, setFillLight, setMirrorFraming };
}
