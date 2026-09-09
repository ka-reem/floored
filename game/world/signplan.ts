import { LOOP_LEN } from "./const";
import { getCorridor, signPlan, GUIDE_H, MTN, SIGN } from "./corridor";
import { DIVERGE_Z, MERGE_Z } from "./routegraph";

/* ============================================================================
   THE CANTILEVER BOARD PLAN — every overhead guide/warning panel on the lap,
   in one browser-free table.

   It exists for the same reason corridor.ts's placement contract does: the
   boards are BUILT by highway.ts (three.js, a browser) but they have to be
   CHECKABLE without one. test/sign-audit.mjs walks this table and asserts, per
   board, that the face points back down the road at the driver who must read
   it and that the mast stands on the same shoulder as the thing it announces.

   Which shoulder is which, since every judgement here depends on it and two
   comments elsewhere in the tree get it backwards:

     the corridor is ONE-WAY in +z (const.ts). Forward +z, up +y, and a
     right-handed basis puts the driver's LEFT at +x (the same derivation
     cockpit.ts spells out for the cabin). corridor.ts's lateral offset is
     measured toward +x, so

         lat < 0  →  west, the town side, the driver's RIGHT
         lat > 0  →  east, the river side, the driver's LEFT

   The main deck's own furniture follows from that: lane 0 (most negative) is
   the kerb lane, the auxiliary lanes and both town gores are on −lat, and so
   the default mast is a west post. The two junctions added later do NOT: the
   bypass MERGES from +lat and the mountain both diverges and merges on +lat
   ("the lap's first left exit", corridor.MTN). A board for those on the west
   post announces a left-hand feature from the right-hand shoulder, with its
   panel hanging over the one side of the road the feature does not concern —
   which is exactly the fault this table was added to make impossible to
   reintroduce silently.
   ==========================================================================*/

/** −1 = west shoulder / driver's right, +1 = east shoulder / driver's left. */
export type Side = -1 | 1;

/** What is drawn on the face. highway.ts turns this into a texture; nothing
    here may reach for a canvas, so the face is described, not rendered. */
export type BoardFace =
  | { t: "guide"; exitNo: number; jp: string; en: string; dist: number; only?: boolean }
  | { t: "merge"; dist: number }
  | { t: "warn"; l1: string; l2: string };

export interface BoardSpec {
  /** stable id, used by the audit table and by nothing else */
  id: string;
  /** canonical corridor z of the mast */
  z: number;
  /** panel size */
  w: number;
  h: number;
  /** the shoulder the mast stands on */
  side: Side;
  /** Which side of the road the feature this board announces is on — the ramp
      it points at, the stream that joins. 0 for a board that announces no
      side at all (the toll plaza is straight ahead across every lane).

      `side` must equal this wherever it is not 0. */
  serves: Side | 0;
  face: BoardFace;
}

/** Advance-warning distances for the bypass diverge. Not 1000/500/200 like the
    town exit: a board a kilometre back from z = 500 lands on the town exit's
    own gore, so the run starts at 800 instead. */
const BYPASS_BOARD_D = [800, 400, 200];

/** The mountain exit's boards, at canonical (wrapped) z — the approach to the
    diverge runs through the seam, so "400 m before the gore" lands back at the
    top of the band. The 10 m nudges keep each mast off the SOS-cabinet lattice
    (pitch 200, phase 30 ⇒ cabinets at 1630 and 1830, exactly where
    divergeZ − 400/200 would land). */
export function MTN_BOARD_Z(): number[] {
  const L = LOOP_LEN;
  const w = (z: number) => (z < -L / 2 ? z + L : z);
  return [
    w(MTN.divergeZ - 390), // "400 m" board
    w(MTN.divergeZ - 190), // "200 m" board
    w(MTN.divergeZ - 24), // gore board
    w(MTN.divergeZ - 96), // "one way" warning for the exit
    MTN.mergeZ - 90, // merge warning, mid-band already
  ];
}

const EXIT_NAMES = ["中野 Nakano", "本町 Honchō"];

/** Every cantilever board on the lap, ordered by z. */
export function boardPlan(): BoardSpec[] {
  const out: BoardSpec[] = [];

  /* ---- the main deck: EXIT 1, the entrance, the toll plaza ---- */
  for (const s of signPlan()) {
    const [jp, en] = (EXIT_NAMES[s.gore] || "出口 Exit").split(" ");
    const face: BoardFace =
      s.kind === "exit-count" ? { t: "guide", exitNo: s.gore + 1, jp, en: en || "", dist: s.dist }
        : s.kind === "exit-gore"
          ? { t: "guide", exitNo: s.gore + 1, jp, en: en || "", dist: 0, only: true }
          : s.kind === "merge" ? { t: "merge", dist: s.dist }
            : { t: "warn", l1: "料金所 " + s.dist + " m", l2: "TOLL" };
    /* Both town gores are on −lat (corridor.AUX_LANES), and the toll plaza
       spans every lane, so all of these are west posts. */
    out.push({
      id: `${s.kind}@${Math.round(s.z)}`,
      z: s.z, w: s.w, h: s.h, side: -1,
      serves: s.kind === "toll" ? 0 : -1,
      face,
    });
  }

  /* ---- the bypass: a west diverge and an EAST merge ---- */
  for (const d of BYPASS_BOARD_D)
    out.push({
      id: `bypass-count@${DIVERGE_Z - d}`,
      z: DIVERGE_Z - d, w: 9.4, h: GUIDE_H, side: -1, serves: -1,
      face: { t: "guide", exitNo: 3, jp: "湾岸", en: "Bypass", dist: d },
    });
  /* The gore panel keeps a narrower 7.4 m board — it hangs over the diverge
     wedge rather than the through lanes — so its height comes off the guide
     face's 2.848 aspect instead of GUIDE_H. Same artwork, 79% of the size,
     nothing stretched. */
  out.push({
    id: `bypass-gore@${DIVERGE_Z - 40}`,
    z: DIVERGE_Z - 40, w: 7.4, h: 7.4 / 2.848, side: -1, serves: -1,
    face: { t: "guide", exitNo: 3, jp: "湾岸", en: "Bypass", dist: 0, only: true },
  });
  /* MERGE_Z − 150 (the obvious spot) puts the mast under the toll canopy and
     its 1240 fallback is still inside the tunnel, so 80 m of notice from
     z = 1500 is what clears both. The bypass rejoins from the EAST, into the
     fast lane, so this is the lap's one east-post merge board. */
  out.push({
    id: `bypass-merge@${MERGE_Z - 80}`,
    z: MERGE_Z - 80, w: 6.6, h: 2.5, side: 1, serves: 1,
    face: { t: "merge", dist: 80 },
  });

  /* ---- the mountain: EXIT 4, a left exit and a left merge ----
     These hang from the MAIN deck's masts on the approach (MTN_BOARD_Z is
     corridor z, not mountain z), and they keep the narrower 7.4 m board: an
     east post with a 9.4 m panel reaching in would hang over the kerb lane,
     the one side of the road this exit does NOT concern. */
  const [b400, b200, bGore, bOneWay, bMerge] = MTN_BOARD_Z();
  const MB_W = 7.4, MB_H = MB_W / 2.848;
  for (const [z, dist] of [[b400, 400], [b200, 200]] as const)
    out.push({
      id: `mtn-count@${Math.round(z)}`,
      z, w: MB_W, h: MB_H, side: 1, serves: 1,
      face: { t: "guide", exitNo: 4, jp: "峠", en: "Tōge", dist },
    });
  out.push({
    id: `mtn-gore@${Math.round(bGore)}`,
    z: bGore, w: MB_W, h: MB_H, side: 1, serves: 1,
    face: { t: "guide", exitNo: 4, jp: "峠", en: "Tōge", dist: 0, only: true },
  });
  /* the pass is a single lane in one direction — say so before the gore, not
     after it, since the gore is the last place a driver can decline it */
  out.push({
    id: `mtn-oneway@${Math.round(bOneWay)}`,
    z: bOneWay, w: 6.6, h: 2.5, side: 1, serves: 1,
    face: { t: "warn", l1: "一方通行 一車線", l2: "ONE WAY · SINGLE LANE" },
  });
  out.push({
    id: `mtn-merge@${Math.round(bMerge)}`,
    z: bMerge, w: 6.6, h: 2.5, side: 1, serves: 1,
    face: { t: "warn", l1: "合流注意", l2: "MERGING TRAFFIC" },
  });

  return out.sort((a, b) => a.z - b.z);
}

/** Lateral offset of a cantilever mast's post on either shoulder: outboard of
    the parapet, so it is never standing in a lane or in mid-air. `side` −1 is
    corridor.signPostLat(); +1 is its mirror on the east edge. */
export function mastLat(z: number, side: Side) {
  const cor = getCorridor();
  return cor.edgeLat(z, side) + side * SIGN.POST_OUT;
}
