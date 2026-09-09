/* Two tables that both the engine and the MENU need, kept out of the engine
   so the menu does not have to download it to use them.

   game/engine.ts pulls in three.js, the traffic fleet, the audio graph and
   the whole world build — 1.2 MB of JavaScript. components/GameApp.tsx used
   to import CAM_NAMES and WIPER_MODE_NAMES straight from it, and a bare
   `import { CAM_NAMES } from "@/game/engine"` is enough to weld all of that
   into the chunk React must parse before it can paint the main menu. Two
   string arrays are not worth a megabyte of download, so they live here and
   engine.ts re-exports them: every existing `from "./engine"` import still
   resolves, and the menu reaches them without the engine.

   Both are INDEXED BY A PERSISTED VALUE (Profile.camMode, Game.wiperMode),
   so neither may be reordered — see the CAM_CYCLE note in engine.ts for the
   whole story on why the cycle order and the numeric order differ. */

/* Camera modes. CAM_POV (index 3) is the hard-mounted dashcam: it shares the
   cockpit's rendering (interior shell visible, mirror and gauges live) but
   none of its head physics — a bracket bolted over the dash does not lean
   into corners, crane to look back, or breathe under braking. CAM_CONSOLE is
   a second bracket, on the tunnel between the seats.

   These are NOT in cycle order; see CAM_CYCLE in engine.ts. */
export const CAM_NAMES = ["CHASE", "COCKPIT", "HOOD", "DASHCAM", "CONSOLE", "BACKSEAT"];

/** Wiper modes, indexed by Game.wiperMode. Index 0 is OFF. */
export const WIPER_MODE_NAMES = ["OFF", "INT", "LO", "HI"] as const;
