/* World layout constants. The elevated expressway runs north–south on the
   east side; the procedural town fills the west; a mirrored frontage strip
   sits east of the deck. */

export const HX = 500; // expressway centerline x
export const DECKY = 9; // deck surface height
export const HZ = 1100; // deck half-length
export const RW = 27.6; // deck width (6 lanes)
export const CONNECT_Z = [-260, 0, 260]; // exit/on-ramp z positions
export const RAMP_W = 10.5;
export const RAMP_X1 = HX - RW / 2 - 0.6; // ramp top (west side)
export const RAMP_X0 = RAMP_X1 - 56; // ramp foot (west side)
export const FRONT_X = RAMP_X0 - 2; // west frontage road centerline
export const EFRONT_X = 2 * HX - FRONT_X; // east frontage road centerline

export const TOWN = { x0: -420, x1: 360, z0: -420, z1: 420 };

export const ROAD_W = 9.6; // town street width
export const FRONT_W = 11; // frontage road width
export const SIDEWALK_W = 2.2;
export const LANE_LAT = 1.95; // NPC lane offset from centerline

export const LANE_OFF = [3.2, 6.9, 10.6]; // deck lane centers from median
export const CHUNK = 96; // town chunk size
