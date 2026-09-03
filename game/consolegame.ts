import { rr, drawBackPill } from "./carscreen";
import type { ScreenAction } from "./carscreen";
import { track } from "../lib/analytics";

/* GAMES pane for the head unit — tic-tac-toe against the car.

   Lives behind carscreen.ts's view system the same way the music player
   does: a pill on the map view opens it, the shared ‹ MAP pill closes it,
   and hitScreen() hands this module the clicks that land below the chrome.
   Everything is canvas-drawn in the panel's own palette — zero downloaded
   assets, no new fonts.

   Cost model, same contract as the music view: this module renders into an
   offscreen canvas that is repainted only when something visible changed (a
   mark landing, the cursor crossing a cell, the thinking dots stepping), and
   costs one drawImage per repaint of the head unit while the pane is open.
   While any other view is up it costs NOTHING — drawGamePane is simply never
   called, no state advances, and the CPU opponent stops mid-think until the
   pane is looked at again. That is deliberate and not just thrift: the
   opponent's clock below only runs inside drawGamePane, so the game cannot
   resolve itself while nobody is watching.

   The opponent is minimax over the full 9-cell tree — trivial at this size —
   with a DELIBERATE blunder rate, because a perfect tic-tac-toe player only
   ever draws and a toy you cannot beat stops being played the second time.
   The rates are tuned unevenly on purpose (see cpuPick): it almost never
   misses its own winning move, but now and then fails to see yours coming,
   which is exactly the shape of a human opponent having an off moment. */

/* ------------------------------------------------------------- geometry -- */

/* The panel's logical 256x160 space, stated locally rather than imported:
   carscreen.ts imports this module, so a top-level read of its consts here
   is a TDZ trap under the module cycle (the function imports above are
   safe — they are hoisted declarations, called only at paint time). The
   size is carscreen's W/H contract and does not drift: both painters map
   through the same base transform on the same canvas. */
const W = 256, H = 160;

/* Board left, stats column right — the music view's album-art/controls split,
   so the two panes read as siblings. 34 px cells match the transport buttons:
   already proven a comfortable cursor target on this panel at dashcam angle. */
const CELL = 34, GAP = 3;
const BOARD = { x: 16, y: 38, s: CELL * 3 + GAP * 2 }; // 108
const COL_X = 140, COL_R = 246;
/** Rematch pill, transport-row height. Hit-tested only once a game is over —
    the pane never offers a button that would throw a live game away. */
const AGAIN = { x: COL_X, y: 122, w: COL_R - COL_X, h: 24 };

const cellRect = (i: number) => ({
  x: BOARD.x + (i % 3) * (CELL + GAP),
  y: BOARD.y + ((i / 3) | 0) * (CELL + GAP),
});

/** Everything a click on the games pane can mean. "g0".."g8" are cells in
    reading order; carscreen's hitScreen folds these into ScreenAction. */
export type GameAction =
  | "g0" | "g1" | "g2" | "g3" | "g4" | "g5" | "g6" | "g7" | "g8" | "gNew";

/* ----------------------------------------------------------------- state -- */

/** Session W-L-D tally, from the PLAYER's side. Rebound onto the profile's
    own object at engine construction (bindGameTally), so marks survive a
    reload through the same persist() path that keeps noHesiBest. */
export interface GameTally { w: number; l: number; d: number }

/** 0 empty, 1 player (X), 2 CPU (O). */
type Cell = 0 | 1 | 2;
/** 0 in play, 1 player won, 2 CPU won, 3 draw. */
type Outcome = 0 | 1 | 2 | 3;

interface GameState {
  board: Cell[];
  /** whose mark lands next */
  turn: 1 | 2;
  outcome: Outcome;
  /** the three winning cells, for the strike-through */
  line: number[] | null;
  /** who opens the NEXT game — alternates per rematch so the CPU's small
      first-move advantage doesn't compound across a session */
  playerOpens: boolean;
  /** ms of "thinking" left before the CPU's chosen move lands. Counted down
      inside drawGamePane only, and only below walking speed — see below. */
  aiWait: number;
  /** the move the CPU committed to when its turn began. Chosen once, up
      front, so the wait is theatre rather than compute. */
  aiMove: number;
  lastMs: number;
  tally: GameTally;
  /* offscreen pane + repaint gate */
  cv: HTMLCanvasElement | null;
  gg: CanvasRenderingContext2D | null;
  scale: number;
  painted: string;
}

const st: GameState = {
  board: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  turn: 1, outcome: 0, line: null, playerOpens: true,
  aiWait: 0, aiMove: -1, lastMs: 0,
  tally: { w: 0, l: 0, d: 0 },
  cv: null, gg: null, scale: 1, painted: "",
};

/* Debug handle for the headless click-through test (test/console-clicks.mjs),
   same convention as __roofTap / __audioDebug: the live state object, read
   straight off window so the test can watch a synthetic game resolve without
   this module growing a second API for it. */
if (typeof window !== "undefined")
  (window as unknown as { __ttt?: GameState }).__ttt = st;

/** Hand the pane the profile's own tally object. Mutated in place, the same
    contract as engine.settings: the profile holds the object, this module
    writes it, GameApp's persist() saves it. */
export function bindGameTally(t: GameTally) {
  st.tally = t;
}
export function gameTally(): GameTally {
  return st.tally;
}

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function winner(b: Cell[]): { who: Cell; line: number[] } | null {
  for (const l of LINES)
    if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[1]] === b[l[2]])
      return { who: b[l[0]], line: l };
  return null;
}

function settle(who: Cell, line: number[] | null) {
  st.outcome = who === 1 ? 1 : who === 2 ? 2 : 3;
  st.line = line;
  if (who === 1) st.tally.w++;
  else if (who === 2) st.tally.l++;
  else st.tally.d++;
  /* one event per finished game — settle() is the single resolution point
     both sides share, so this can never double-count */
  track("ttt_game", {
    result: who === 1 ? "win" : who === 2 ? "loss" : "draw",
    wins: st.tally.w, losses: st.tally.l, draws: st.tally.d,
    player_opened: st.playerOpens,
  });
}

/** Drop a mark, resolve the game if that ended it, otherwise pass the turn.
    Shared by both sides so the end-of-game bookkeeping cannot diverge. */
function place(i: number, who: 1 | 2) {
  st.board[i] = who;
  const w = winner(st.board);
  if (w) return settle(w.who, w.line);
  if (!st.board.includes(0)) return settle(0, null);
  st.turn = who === 1 ? 2 : 1;
  if (st.turn === 2) beginThink();
}

function newGame() {
  st.board = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  st.outcome = 0;
  st.line = null;
  st.playerOpens = !st.playerOpens;
  st.turn = st.playerOpens ? 1 : 2;
  if (st.turn === 2) beginThink();
}

/* ------------------------------------------------------------- opponent -- */

/** Minimax score of `b` with `who` to move, from the CPU's side: +10 a CPU
    win, -10 a player win, 0 a draw, shaded by depth so the CPU prefers the
    quick kill and the slow loss. 9 cells caps the tree at a few thousand
    nodes; nothing here is worth memoising. */
function score(b: Cell[], who: 1 | 2, depth: number): number {
  const w = winner(b);
  if (w) return w.who === 2 ? 10 - depth : depth - 10;
  if (!b.includes(0)) return 0;
  let best = who === 2 ? -99 : 99;
  for (let i = 0; i < 9; i++) {
    if (b[i]) continue;
    b[i] = who;
    const s = score(b, who === 1 ? 2 : 1, depth + 1);
    b[i] = 0;
    best = who === 2 ? Math.max(best, s) : Math.min(best, s);
  }
  return best;
}

/** The blunder knobs. MISS_WIN is near zero — a player who overlooks their
    own three-in-a-row reads as broken, not beatable — while MISS_BEST is the
    real handicap: roughly one move in four the CPU plays a genuinely worse
    line (failing to block, walking into a fork), which is what leaves the
    door open without ever making it look like it stopped trying. */
const MISS_WIN = 0.06, MISS_BEST = 0.27;

function cpuPick(): number {
  const moves: { i: number; s: number }[] = [];
  for (let i = 0; i < 9; i++) {
    if (st.board[i]) continue;
    st.board[i] = 2;
    moves.push({ i, s: score(st.board, 1, 1) });
    st.board[i] = 0;
  }
  moves.sort((a, b) => b.s - a.s);
  const bestS = moves[0].s;
  const off = moves.filter((m) => m.s < bestS);
  if (off.length) {
    const miss = bestS >= 8 ? MISS_WIN : MISS_BEST;
    if (Math.random() < miss) return off[(Math.random() * off.length) | 0].i;
  }
  const best = moves.filter((m) => m.s === bestS);
  return best[(Math.random() * best.length) | 0].i;
}

function beginThink() {
  st.aiMove = cpuPick();
  st.aiWait = 420 + Math.random() * 380;
}

/* ------------------------------------------------------------ interaction -- */

/** Hit test for the pane's own region, called by carscreen.hitScreen with
    the same flipped canvas coordinates it uses for every other view. The
    chrome (‹ MAP) stays carscreen's; only playable things answer here, so
    the cursor and the hover glow only ever point at a move that would
    actually land: an occupied cell, a finished board, or the CPU's turn are
    all dead space. */
export function hitGamePane(x: number, y: number): GameAction | null {
  if (st.outcome !== 0 &&
    x >= AGAIN.x && x <= AGAIN.x + AGAIN.w && y >= AGAIN.y && y <= AGAIN.y + AGAIN.h)
    return "gNew";
  if (st.outcome === 0 && st.turn === 1) {
    for (let i = 0; i < 9; i++) {
      const c = cellRect(i);
      if (st.board[i] === 0 &&
        x >= c.x && x <= c.x + CELL && y >= c.y && y <= c.y + CELL)
        return ("g" + i) as GameAction;
    }
  }
  return null;
}

/** A click hitGamePane said was live. Returns true if it changed the game —
    engine.ts uses that edge for the UI blip, so a click that did nothing
    stays silent. */
export function gameClick(a: GameAction): boolean {
  if (a === "gNew") {
    if (st.outcome === 0) return false;
    newGame();
    return true;
  }
  const i = +a.slice(1);
  if (st.outcome !== 0 || st.turn !== 1 || st.board[i] !== 0) return false;
  place(i, 1);
  return true;
}

/* -------------------------------------------------------------- painting -- */

const INK = "#eef1f7", DIM = "#9aa6bc", FAINT = "#8f98ab";
/** X in the panel's accent blue, O in the tracklist's sodium amber — both
    colours the head unit already speaks, hot enough to survive the dashcam
    degrade without going blown-white. */
const X_COL = "#6fb2ff", O_COL = "#ffb347";

function mark(gg: CanvasRenderingContext2D, who: Cell, cx: number, cy: number, r: number, dim = false) {
  gg.lineWidth = 3.4;
  gg.lineCap = "round";
  if (who === 1) {
    gg.strokeStyle = dim ? "rgba(111,178,255,.34)" : X_COL;
    gg.beginPath();
    gg.moveTo(cx - r, cy - r); gg.lineTo(cx + r, cy + r);
    gg.moveTo(cx + r, cy - r); gg.lineTo(cx - r, cy + r);
    gg.stroke();
  } else {
    gg.strokeStyle = dim ? "rgba(255,179,71,.34)" : O_COL;
    gg.beginPath();
    gg.arc(cx, cy, r, 0, Math.PI * 2);
    gg.stroke();
  }
}

function paint(hover: ScreenAction | null, dots: number) {
  const gg = st.gg!;
  gg.clearRect(0, 0, W, H);
  gg.fillStyle = "#0a0d13";
  gg.fillRect(0, 0, W, H);

  drawBackPill(gg, hover === "map");

  gg.fillStyle = FAINT;
  gg.font = "600 8px sans-serif";
  gg.textAlign = "right";
  gg.fillText("TIC-TAC-TOE", W - 10, 20);
  gg.textAlign = "left";

  /* --- board -------------------------------------------------------------- */
  rr(gg, BOARD.x - 6, BOARD.y - 6, BOARD.s + 12, BOARD.s + 12, 10);
  gg.fillStyle = "rgba(255,255,255,.04)";
  gg.fill();
  gg.strokeStyle = "rgba(255,255,255,.09)";
  gg.lineWidth = 1;
  gg.stroke();

  for (let i = 0; i < 9; i++) {
    const c = cellRect(i);
    const on = hover === "g" + i;
    rr(gg, c.x, c.y, CELL, CELL, 6);
    gg.fillStyle = on ? "rgba(111,178,255,.20)" : "rgba(8,11,18,.85)";
    gg.fill();
    gg.strokeStyle = on ? "rgba(160,205,255,.75)" : "rgba(255,255,255,.08)";
    gg.lineWidth = 1;
    gg.stroke();
    if (st.board[i]) {
      const faded = !!st.line && !st.line.includes(i);
      mark(gg, st.board[i], c.x + CELL / 2, c.y + CELL / 2, 9.5, faded);
    } else if (on) {
      // ghost of the mark a click would land — the panel's usual "this is
      // what this control does" hover language, in mark form
      mark(gg, 1, c.x + CELL / 2, c.y + CELL / 2, 9.5, true);
    }
  }
  if (st.line) {
    const a = cellRect(st.line[0]), b = cellRect(st.line[2]);
    gg.strokeStyle = st.outcome === 1 ? "rgba(160,205,255,.9)" : "rgba(255,197,110,.9)";
    gg.lineWidth = 2.5;
    gg.beginPath();
    gg.moveTo(a.x + CELL / 2, a.y + CELL / 2);
    gg.lineTo(b.x + CELL / 2, b.y + CELL / 2);
    gg.stroke();
  }

  /* --- tally -------------------------------------------------------------- */
  const chips: [string, number, string][] = [
    ["YOU", st.tally.w, X_COL], ["CPU", st.tally.l, O_COL], ["TIE", st.tally.d, DIM],
  ];
  const cw = 32;
  gg.textAlign = "center";
  for (let k = 0; k < 3; k++) {
    const x = COL_X + k * (cw + 5);
    rr(gg, x, 38, cw, 30, 6);
    gg.fillStyle = "rgba(255,255,255,.05)";
    gg.fill();
    gg.strokeStyle = "rgba(255,255,255,.09)";
    gg.lineWidth = 1;
    gg.stroke();
    gg.fillStyle = chips[k][2];
    gg.font = "600 7px sans-serif";
    gg.fillText(chips[k][0], x + cw / 2, 48);
    gg.fillStyle = INK;
    gg.font = "700 12px sans-serif";
    gg.fillText(String(Math.min(999, chips[k][1])), x + cw / 2, 62);
  }

  /* --- status ------------------------------------------------------------- */
  gg.font = "700 10px sans-serif";
  const midX = COL_X + (COL_R - COL_X) / 2;
  if (st.outcome === 0) {
    gg.fillStyle = st.turn === 1 ? INK : DIM;
    gg.fillText(
      st.turn === 1 ? "YOUR MOVE" : "CPU IS THINKING" + ".".repeat(dots + 1),
      midX, 96,
    );
  } else {
    gg.fillStyle = st.outcome === 1 ? X_COL : st.outcome === 2 ? O_COL : INK;
    gg.fillText(st.outcome === 1 ? "YOU WIN" : st.outcome === 2 ? "CPU WINS" : "DRAW", midX, 96);
  }

  /* --- rematch ------------------------------------------------------------ */
  if (st.outcome !== 0) {
    const on = hover === "gNew";
    rr(gg, AGAIN.x, AGAIN.y, AGAIN.w, AGAIN.h, 8);
    gg.fillStyle = on ? "rgba(111,178,255,.26)" : "rgba(255,255,255,.055)";
    gg.fill();
    gg.strokeStyle = on ? "rgba(160,205,255,.85)" : "rgba(255,255,255,.10)";
    gg.lineWidth = 1;
    gg.stroke();
    gg.fillStyle = on ? "#ffffff" : "#c8d0de";
    gg.font = "700 9px sans-serif";
    gg.fillText("NEW GAME", AGAIN.x + AGAIN.w / 2, AGAIN.y + 15.5);
  }
  gg.textAlign = "left";
}

/* ------------------------------------------------------------ entry point -- */

/** Advance and draw the pane into the head unit's context. Only carscreen
    calls this, and only while the games view is up — which is the whole
    update loop, so closing the pane freezes the game exactly where it was.

    `speed` is |car.u| in m/s: above a walking pace the CPU's think timer
    holds, so the opponent never resolves the game while the player's eyes
    are (hopefully) on the road. Their own moves stay possible — playing
    while driving is the owner's own risk, the car merely refuses to play
    back until things calm down. */
export function drawGamePane(
  g: CanvasRenderingContext2D, scale: number, hover: ScreenAction | null,
  speed: number, ms: number,
) {
  if (!st.cv || st.scale !== scale) {
    st.cv = document.createElement("canvas");
    st.cv.width = Math.max(1, Math.round(W * scale));
    st.cv.height = Math.max(1, Math.round(H * scale));
    st.gg = st.cv.getContext("2d")!;
    st.gg.setTransform(scale, 0, 0, scale, 0, 0);
    st.scale = scale;
    st.painted = "";
  }

  /* CPU clock. dt is clamped so the first frame after the pane was away —
     however long — cannot land the move as a jump-scare. */
  const dt = Math.min(120, ms - st.lastMs);
  st.lastMs = ms;
  if (st.outcome === 0 && st.turn === 2 && speed < 2) {
    st.aiWait -= dt;
    if (st.aiWait <= 0 && st.aiMove >= 0 && st.board[st.aiMove] === 0)
      place(st.aiMove, 2);
  }

  const dots = st.turn === 2 && st.outcome === 0 ? ((ms / 420) | 0) % 3 : 0;
  const sig =
    st.board.join("") + "|" + st.turn + st.outcome + "|" + (hover ?? "") +
    "|" + dots + "|" + st.tally.w + "," + st.tally.l + "," + st.tally.d;
  if (sig !== st.painted) {
    paint(hover, dots);
    st.painted = sig;
  }
  g.drawImage(st.cv!, 0, 0, W, H);
}
