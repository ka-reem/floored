import { HX, HZ, RW, RAMP_X0, CONNECT_Z } from "./world/const";
import type { WorldData } from "./world/data";
import type { CarState } from "./physics";
import type { Npc } from "./traffic";

/* Rotating-free top-down minimap: real road-graph polylines, expressway,
   ramps + numbered exits, traffic dots, player arrow. */

export function drawMiniMap(
  cv: HTMLCanvasElement,
  world: WorldData,
  car: CarState,
  npcs: Npc[],
  now: number
) {
  const g = cv.getContext("2d");
  if (!g) return;
  const Wp = cv.width, sc = 0.4;
  const tx = (x: number) => Wp / 2 + (x - car.x) * sc;
  const tz = (z: number) => Wp / 2 - (z - car.z) * sc;
  g.clearRect(0, 0, Wp, Wp);
  g.fillStyle = "rgba(8,10,18,.8)";
  g.fillRect(0, 0, Wp, Wp);

  // town roads from the graph
  g.strokeStyle = "rgba(110,130,170,.55)";
  g.lineWidth = 2.5;
  const R = Wp / (2 * sc) + 40;
  for (const e of world.net.edges) {
    const n = e.ss.length - 1;
    const mx = e.pts[Math.floor(n / 2) * 3], mz = e.pts[Math.floor(n / 2) * 3 + 2];
    if (Math.abs(mx - car.x) > R + e.len / 2 || Math.abs(mz - car.z) > R + e.len / 2) continue;
    g.beginPath();
    let started = false;
    for (let i = 0; i <= n; i += 2) {
      const X = tx(e.pts[i * 3]), Z = tz(e.pts[i * 3 + 2]);
      if (X < -20 || X > Wp + 20 || Z < -20 || Z > Wp + 20) {
        started = false;
        continue;
      }
      if (!started) {
        g.moveTo(X, Z);
        started = true;
      } else g.lineTo(X, Z);
    }
    g.stroke();
  }

  // expressway
  const DX = tx(HX);
  if (DX > -10 && DX < Wp + 10) {
    g.strokeStyle = "rgba(120,200,255,.9)";
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(DX, tz(Math.min(HZ, car.z + Wp / (2 * sc))));
    g.lineTo(DX, tz(Math.max(-HZ, car.z - Wp / (2 * sc))));
    g.stroke();
  }
  // ramps + exits
  g.lineWidth = 3;
  CONNECT_Z.forEach((cz, gi) => {
    const Z = tz(cz);
    if (Z < -8 || Z > Wp + 8) return;
    g.strokeStyle = "rgba(120,255,190,.85)";
    g.beginPath();
    g.moveTo(tx(RAMP_X0 - 8), Z);
    g.lineTo(tx(HX - RW / 2), Z);
    g.stroke();
    g.beginPath();
    g.moveTo(tx(HX + RW / 2), Z);
    g.lineTo(tx(2 * HX - RAMP_X0 + 8), Z);
    g.stroke();
    const ex = tx(HX - RW / 2 - 12);
    if (ex > 8 && ex < Wp - 8) {
      g.fillStyle = "rgba(120,255,190,.95)";
      g.font = "700 9px sans-serif";
      g.textAlign = "center";
      g.fillText(String(gi + 1), ex, Z - 4);
    }
  });
  // U-turn loops
  g.strokeStyle = "rgba(120,200,255,.9)";
  g.lineWidth = 6;
  for (const e of [1, -1]) {
    const Z = tz(e * HZ), X = tx(HX);
    if (Z > -60 && Z < Wp + 60) {
      g.beginPath();
      g.arc(X, Z, ((RW / 2) * sc) * 0.9, e > 0 ? Math.PI : 0, e > 0 ? 2 * Math.PI : Math.PI, false);
      g.stroke();
    }
  }
  // traffic
  for (const n of npcs) {
    if (!n.active) continue;
    const X = tx(n.x), Z = tz(n.z);
    if (X < 2 || X > Wp - 2 || Z < 2 || Z > Wp - 2) continue;
    g.fillStyle = n.wreck
      ? "#ff8020"
      : n.type === "police"
        ? (((now * 3) | 0) % 2 ? "#ff4050" : "#3d74ff")
        : n.hw
          ? "#8fd8ff"
          : "#ffb050";
    g.fillRect(X - 1.4, Z - 1.4, 2.8, 2.8);
  }
  // player
  g.save();
  g.translate(Wp / 2, Wp / 2);
  g.rotate(car.h);
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(0, -6.5);
  g.lineTo(4.2, 5.2);
  g.lineTo(-4.2, 5.2);
  g.closePath();
  g.fill();
  g.restore();
  g.strokeStyle = "rgba(150,170,210,.4)";
  g.lineWidth = 2;
  g.strokeRect(1, 1, Wp - 2, Wp - 2);
}
