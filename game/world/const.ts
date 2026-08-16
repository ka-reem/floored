/* World layout constants. The expressway is a single one-way corridor running
   south→north (increasing z) on the east side of the map; the procedural town
   fills the west; a mirrored frontage strip sits east of the deck.

   The corridor's *shape* is not described here — see corridor.ts. This file
   only holds the scalars other systems need before the corridor is built. */

export const HX = 500; // corridor reference x (centreline at zero lateral offset)
export const DECKY = 10; // deck surface height at zero grade
/** half-length of the canonical corridor; it spans z ∈ [-HZ, HZ] */
export const HZ = 2000;
/** loop length: crossing z = +HZ teleports the player back by this much */
export const LOOP_LEN = 2 * HZ;
/** extra deck built past each end so the splice is never visible */
export const DECK_EXT = 380;

export const LANE_W = 3.7;
/** paved shoulder outside the outermost lane centres */
export const SHOULDER = 1.55;
export const MAX_LANES = 6;
/** widest the pavement ever gets (toll plaza) */
export const RW = MAX_LANES * LANE_W + 2 * SHOULDER;

export const RAMP_W = 10.5;
/** How far a ramp runs along the corridor while it curves away from it. The
    deck is 10 m up, so this is really a grade budget: at 112 m the descent
    peaked at 17%, which is a cliff, not a ramp. This is as long as the two
    ramps can be without overlapping inside the corridor's straight window. */
export const RAMP_RUN = 190;
/** length of the gore taper where the ramp pavement opens out of the deck edge */
export const RAMP_NOSE = 13;

export const FRONT_X = 435; // west frontage road centerline (ramp feet land here)
export const EFRONT_X = 2 * HX - FRONT_X; // east frontage road centerline

export const TOWN = { x0: -420, x1: 340, z0: -420, z1: 420 };

export const ROAD_W = 9.6; // town street width
export const FRONT_W = 11; // frontage road width
export const SIDEWALK_W = 2.2;
export const LANE_LAT = 1.95; // NPC lane offset from a street centerline

/** z of each gore on the corridor. Both sit in the corridor's straight,
    zero-offset window beside the town (z ∈ [-520, 40]), the only stretch
    where a ramp can reach the frontage road. [0] is the exit, [1] the
    entrance. They sit at the two ends of that window because each ramp needs
    RAMP_RUN of it — the exit runs forward from its gore, the entrance back
    from its own, and they must not cross. */
export const CONNECT_Z = [-500, 20];

/** @deprecated the corridor's lane count varies — use `corridor.laneOffset()`.
    Kept as a 3-lane fallback so legacy call sites still compile and land on
    the pavement. */
export const LANE_OFF = [-LANE_W, 0, LANE_W];
export const CHUNK = 96; // town chunk size
