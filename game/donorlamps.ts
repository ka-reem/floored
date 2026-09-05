import * as THREE from "three";

/* ------------------------------------------------------------- donor lamps

   Driving the imported body's OWN lamp geometry, instead of the procedural
   emissive boxes it hides.

   The boxes in player.ts are children of exteriorG, and bodymodel.ts hides
   every exteriorG child that is not on its keep list the moment the donor
   lands. The keep list was the wheels and the headlight/plate glow sprites.
   So on the shipping car — the Volvo, the default, the only one with a donor
   body — the tail lamps, the brake lamps, the rear LED bar, all four
   indicators and the side markers had not been on screen since the body
   landed. What the chase camera saw at night was the donor's own
   `Translucent_Glass` and `GlassRunninglight`, which the donor authors with
   emissiveFactor [1,1,1]: two white bars across the tail, on at all times,
   identical at rest and under full braking. Photographed before this change
   at 21:31 in CHASE, at rest and at 84 mph on the brakes — the two frames are
   the same frame.

   The donor's lamp geometry is dense and correctly placed (the tail cluster
   alone is 39k triangles of chrome frame plus 8.4k of shaped reflector, and
   it is the part of the body the chase-bias build spends most on), so the
   right answer is to light the real lens rather than to un-hide a box behind
   it. This module finds the lamp materials by name, re-authors them as lens
   plastic, and hands back one `set()` the engine drives per frame.

   The procedural boxes are NOT retired: they are the lamps of the procedural
   shell, which is what kaze, the kei car and the other two wear, what the
   garage card renders first, and what the player sees if this GLB ever fails
   to fetch. They simply stop being the Volvo's lamps.

   Nothing here throws. A donor whose material names change silently drives
   whatever it still recognises, and the car keeps the lamps it has. */

/** What the engine knows about the lamps in a given frame. */
export interface LampState {
  /** side/tail lights on — the same `car.lightsOn` the headlights follow */
  running: boolean;
  /** the brake step */
  brake: boolean;
  /** reverse gear selected AND actually going backwards */
  reverse: boolean;
  /** already blink-gated by the caller */
  sigL: boolean;
  sigR: boolean;
  /** high beam */
  high: boolean;
  /** 0 at night, 1 in full daylight — fades the running lights out of a
      daylit frame rather than switching them */
  day: number;
}

export interface DonorLampHandle {
  set(s: LampState): void;
  /** Car-local centre of each rear lamp cluster, left then right, so the
      caller can seat its halo sprites on the real lens instead of on where
      the procedural box used to be. Empty if no tail lens was found. */
  tailAnchors: THREE.Vector3[];
  /** What was recognised — for the handoff report and for a check to assert
      against if the donor is ever rebuilt. */
  found: Record<string, number>;
}

/* Which donor material plays which lamp. Keys are glTF material names as they
   arrive from GLTFLoader; the `.001` suffix is the donor's own, not three's.
   A name not in this table is not touched. */
type Role =
  | "tailCore"    // the shaped reflector behind the lens: the bright element
  | "tailDiffuse" // the translucent diffusers over it, and the tailgate strip
  | "reverse"
  | "sigRear"
  | "sigFront"
  | "drl"
  | "head";

const ROLE: Record<string, Role> = {
  emission: "tailCore",                 // MainReflectors Taillight, 8.4k tris
  "Translucent_Glass.001": "tailDiffuse", // Diffusers Taillight, 8.8k
  Translucent_Glass: "tailDiffuse",     // Diffuser TrunkTaillight (the strip)
  Glass_wavey: "reverse",               // Diffuser ReverseLight
  Turn_signaltaillight: "sigRear",      // Diffuser 3 Taillight
  turnsignal: "sigFront",               // Glass Turnsignal
  heaxagon_glass: "sigFront",           // its outer hexagon lens
  GlassRunninglight: "drl",
  Headlight_Insides: "head",            // the reflector bowls behind the glass
};

/** Roles that light one side at a time, so their mesh has to be cut in two. */
const SIDED = new Set<Role>(["sigRear", "sigFront"]);

/* Lens plastic, unlit. Every driven material is re-authored to these before
   anything is added to it: the donor's diffusers are white with a full white
   emissive, which is why the tail read as chrome bars in daylight and as white
   bars at night. A lamp that is off has to look like coloured plastic. */
const LENS: Record<Role, { color: number; emissive: number; rough: number; metal: number }> = {
  tailCore:    { color: 0x2b0409, emissive: 0xff1a22, rough: 0.30, metal: 0.15 },
  tailDiffuse: { color: 0x40060c, emissive: 0xff2a2c, rough: 0.42, metal: 0 },
  reverse:     { color: 0x181a1f, emissive: 0xfff0d8, rough: 0.34, metal: 0 },
  sigRear:     { color: 0x2c1704, emissive: 0xff8a12, rough: 0.38, metal: 0 },
  sigFront:    { color: 0x2c1704, emissive: 0xff8a12, rough: 0.38, metal: 0 },
  drl:         { color: 0x191b20, emissive: 0xdfe9ff, rough: 0.36, metal: 0 },
  head:        { color: 0x2a2d34, emissive: 0xe6eeff, rough: 0.55, metal: 0.4 },
};

/* Emissive intensities, in the units the procedural lamps already use — see
   player.ts tailMat (running 0.95, brake 3.6) and headMat (2.4 / 4.2).

   The grade is the reason these are what they are. The composite runs a manual
   ACES pass with a vibrance term that fades out above ~0.8 output luma
   (post.ts), so a lamp above that ceiling loses its hue and reads white: peak
   level is a HUE budget. Red survives tone-mapping better than anything else,
   so the tail core can sit at 3.9 under braking and still come through ACES at
   ~0.93 red with its green and blue an order of magnitude down — saturated,
   not bleached — while the same number in white would be a hole in the frame.
   The reverse and DRL lenses, which ARE white, are held two to three times
   lower for exactly that reason.

   The running-to-brake ratio is 1.35 -> 3.9 on the core and 0.8 -> 2.3 on the
   diffusers, i.e. the whole cluster steps together by about 2.9x. On the ACES
   curve that is a clear step without either end clipping: the running lamp
   still has somewhere to go, and the brake lamp still has hue. */
const LVL = {
  tailOff: 0.10, tailRun: 1.35, tailBrake: 3.90,
  difOff: 0.06, difRun: 0.80, difBrake: 2.30,
  reverse: 2.60,
  sig: 3.20,
  drlDay: 0.55, drlRun: 1.90, drlHigh: 2.60,
  headOff: 0.05, headRun: 1.40, headHigh: 2.50,
};

/** Mesh-local -> CAR-local transform.
 *
 *  Deliberately NOT `matrixWorld`. The donor is parented under `carGroup`,
 *  which carries the car's world position and its heading, so a world-space x
 *  sign is the sign of the car's LEFT only while the car happens to point up
 *  +z — and the indicator split below is a test on that sign. Walking up to
 *  (and including) the donor root, whose parent is `exteriorG`, gives car-local
 *  metres wherever on the map the car is and whichever way it is facing. */
function carLocalMatrix(root: THREE.Object3D, o: THREE.Object3D) {
  const m = new THREE.Matrix4();
  const stop = root.parent;
  for (let cur: THREE.Object3D | null = o; cur && cur !== stop; cur = cur.parent) {
    cur.updateMatrix();
    m.premultiply(cur.matrix);
  }
  return m;
}

/** Split one mesh's triangles into a car-left group and a car-right group and
 *  give it a two-material array, so an indicator can blink on one side.
 *
 *  Same instrument as splitDonorGlazing in player.ts, and simpler because
 *  there is nothing to find: a lamp pair straddles x = 0 with nothing on it,
 *  so the sign of the triangle centroid IS the cut. Returns null (and leaves
 *  the mesh exactly as it was) if either side comes out empty, which is what
 *  a single-sided lamp mesh would do. */
function splitBySide(
  mesh: THREE.Mesh, mat: THREE.Material, m: THREE.Matrix4,
): { left: THREE.Material; right: THREE.Material } | null {
  const geo = mesh.geometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  if (!pos) return null;
  const idx = geo.index;
  const triN = idx ? idx.count / 3 : pos.count / 3;
  if (triN < 2) return null;
  const v = new THREE.Vector3();
  const cx = (t: number) => {
    let s = 0;
    for (let k = 0; k < 3; k++) {
      const i = idx ? idx.getX(t * 3 + k) : t * 3 + k;
      s += v.fromBufferAttribute(pos, i).applyMatrix4(m).x;
    }
    return s / 3;
  };
  const left: number[] = [], right: number[] = [];
  for (let t = 0; t < triN; t++) (cx(t) >= 0 ? left : right).push(t);
  if (!left.length || !right.length) return null;

  const src = idx
    ? Array.from({ length: idx.count }, (_, i) => idx.getX(i))
    : Array.from({ length: pos.count }, (_, i) => i);
  const out = new Uint32Array(triN * 3);
  let w = 0;
  for (const t of [...left, ...right])
    for (let k = 0; k < 3; k++) out[w++] = src[t * 3 + k];
  geo.setIndex(new THREE.BufferAttribute(out, 1));
  geo.clearGroups();
  geo.addGroup(0, left.length * 3, 0);
  geo.addGroup(left.length * 3, right.length * 3, 1);
  const l = mat, r = mat.clone();
  mesh.material = [l, r];
  return { left: l, right: r };
}

/** Re-author one donor lamp material as unlit lens plastic.
 *
 *  A material that ships a baseColor MAP keeps its albedo and its PBR: the
 *  donor spends three of its nine textures on the lamp clusters and one on the
 *  front indicator, and a flat colour would throw that detail away. Only the
 *  emissive is taken over there. The untextured ones — every diffuser and
 *  reflector in the tail — are re-coloured, because their authored albedo is
 *  white with a full white emissiveFactor, which is the bug. */
function asLens(m: THREE.MeshStandardMaterial, role: Role) {
  const k = LENS[role];
  m.emissive.setHex(k.emissive);
  m.emissiveIntensity = 0;
  if (!m.map) {
    m.color.setHex(k.color);
    m.roughness = k.rough;
    m.metalness = k.metal;
  }
  /* The diffusers ship transparent with depthWrite off, which sorts them into
     the transparent pass BEHIND the outer lens cover and lets the tarmac show
     through a lit lamp. They are solid plastic; make them solid. The outer
     covers (Glass_Taillight, Glass_headlights) are not in the table and keep
     the transmission they were authored with, so the cluster still reads as
     something under glass. */
  m.transparent = false;
  m.opacity = 1;
  m.depthWrite = true;
  m.needsUpdate = true;
}

export function wireDonorLamps(root: THREE.Object3D): DonorLampHandle {
  const byRole: Record<string, THREE.MeshStandardMaterial[]> = {};
  const sideMats: {
    l: THREE.MeshStandardMaterial[];
    r: THREE.MeshStandardMaterial[];
    both: THREE.MeshStandardMaterial[];
  } = { l: [], r: [], both: [] };
  const found: Record<string, number> = {};
  /* Halo anchors are accumulated as a per-side vertex CENTROID of the lit
     elements, not as half of a bounding box: the cluster is a wide C with a
     strip across the tailgate, so the box's centre lands in the middle of the
     boot lid where there is no lamp. */
  const acc = {
    l: { p: new THREE.Vector3(), n: 0 },
    r: { p: new THREE.Vector3(), n: 0 },
  };
  const seen = new Set<THREE.Material>();

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const raw of mats) {
      const m = raw as THREE.MeshStandardMaterial;
      const role = ROLE[m.name];
      if (!role || seen.has(m) || m.emissive === undefined) continue;
      seen.add(m);
      found[role] = (found[role] ?? 0) + 1;
      asLens(m, role);
      if (SIDED.has(role)) {
        const cut = Array.isArray(mesh.material)
          ? null
          : splitBySide(mesh, m, carLocalMatrix(root, mesh));
        if (cut) {
          sideMats.l.push(cut.left as THREE.MeshStandardMaterial);
          sideMats.r.push(cut.right as THREE.MeshStandardMaterial);
        } else {
          /* Not splittable — drive it as one, so a rebuilt donor that merges
             its indicators still blinks (both sides together) rather than
             going dark. */
          sideMats.both.push(m);
        }
        continue;
      }
      (byRole[role] ??= []).push(m);
      if (role === "tailCore") {
        const mw = carLocalMatrix(root, mesh);
        const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
        const v = new THREE.Vector3();
        // every 7th vertex: 8.4k triangles is far more precision than a
        // sprite position needs, and this runs on the load path
        for (let i = 0; i < pos.count; i += 7) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mw);
          const a = v.x >= 0 ? acc.l : acc.r;
          a.p.add(v);
          a.n++;
        }
      }
    }
  });

  const tailAnchors: THREE.Vector3[] = [];
  for (const a of [acc.l, acc.r]) if (a.n > 0) tailAnchors.push(a.p.divideScalar(a.n));

  const drive = (role: string, v: number) => {
    const list = byRole[role];
    if (!list) return;
    for (const m of list) m.emissiveIntensity = v;
  };

  return {
    tailAnchors,
    found,
    set(s: LampState) {
      /* Running lights fade out of a daylit frame rather than switching off:
         `day` is the same 0..1 the headlight glow already rides, so a lamp
         goes on at dusk over the same minutes the sky does. The brake step
         does NOT fade — a brake lamp has to read at noon, which is what the
         daylight floor below is. */
      const run = s.running ? 1 - s.day * 0.55 : 0;
      const brakeDay = 1 - s.day * 0.12;
      drive("tailCore", s.brake ? LVL.tailBrake * brakeDay
        : LVL.tailOff + (LVL.tailRun - LVL.tailOff) * run);
      drive("tailDiffuse", s.brake ? LVL.difBrake * brakeDay
        : LVL.difOff + (LVL.difRun - LVL.difOff) * run);
      drive("reverse", s.reverse ? LVL.reverse * brakeDay : 0);
      drive("drl", s.high ? LVL.drlHigh : s.running ? LVL.drlRun : LVL.drlDay);
      drive("head", s.high ? LVL.headHigh : s.running ? LVL.headRun : LVL.headOff);
      const sv = LVL.sig * brakeDay;
      for (const m of sideMats.l) m.emissiveIntensity = s.sigL ? sv : 0;
      for (const m of sideMats.r) m.emissiveIntensity = s.sigR ? sv : 0;
      for (const m of sideMats.both) m.emissiveIntensity = s.sigL || s.sigR ? sv : 0;
    },
  };
}
