import { clamp, lerp } from "./util";
import { pollGamepad, type PadEdge } from "./gamepad";
import type { DriverInput } from "./physics";
const input: DriverInput = { th: 0, br: 0, st: 0, hb: 0, horn: 0 };
const padEdge: PadEdge = { cam: () => {}, lights: () => {} };
const u = 10, dt = 0.016;
if (pollGamepad(input, dt, lerp(3.4, 1.7, clamp(Math.abs(u) / 40, 0, 1)), padEdge)) {
  // early return path
}
