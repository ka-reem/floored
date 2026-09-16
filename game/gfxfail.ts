/* Graphics failure panels — plain DOM, no React, so the engine can raise one
   from inside its own canvas listeners and GameApp can raise the other before
   it has an engine at all.

   Two failure modes, one look:
   - "nowebgl": the browser (or its settings) offers no WebGL context. The
     three.js renderer would throw inside `new Game()` and the page would be
     an unstyled crash. GameApp asks webglAvailable() first and shows this
     instead.
   - "lost": the GPU dropped the game's context mid-session (memory pressure
     on a phone, a driver reset on desktop). three.js stops drawing; without a
     word from us the player is left staring at a frozen frame.

   Styling is inline against the tokens in app/globals.css (with literal
   fallbacks) rather than classes there, so the panel reads as the game even
   if the stylesheet is what failed to load. */

import { NAME_LABEL } from "@/lib/build";
import { forceSafeMode, safeMode } from "./safemode";

export type GfxFailKind = "nowebgl" | "lost";

const PANEL_ID = "gfxFail";

const COPY: Record<GfxFailKind, { head: string; body: string; btn: string }> = {
  nowebgl: {
    head: "This browser can't run WebGL",
    body:
      "FLOORED draws everything on the GPU through WebGL, and this " +
      "browser isn't offering one. A current Chrome, Edge, Firefox or Safari " +
      "with hardware acceleration switched on will run it.",
    btn: "TRY AGAIN",
  },
  lost: {
    head: "Graphics context lost",
    body:
      "The GPU dropped the game's drawing context — that happens when the " +
      "device runs low on memory or the graphics driver resets. Reload to " +
      "pick the drive back up; your garage and stats are saved.",
    btn: "RELOAD",
  },
};

/* The second button, and the reason it exists.
 *
 * A driver reset on a desktop is a one-off: RELOAD is the whole fix. Running
 * out of memory on a phone is not, because the reload rebuilds the identical
 * world out of the identical assets and runs out of memory in the identical
 * place — the player presses RELOAD, watches the same panel come back, and
 * correctly concludes the game is broken. game/safemode.ts latches after two
 * such deaths on its own, but a player looking at this panel right now should
 * not have to crash twice more to be taken at their word.
 *
 * Only on "lost": a browser with no WebGL at all has nothing to hold back. */
const SAFE_NOTE =
  "Crashed here before? Safe mode drops the heaviest textures — the imported " +
  "car interior above all — for a lighter build that fits in less memory.";

/** True when a WebGL2 or WebGL1 context can be created. The probe context is
 *  released straight away so it never competes with the renderer's own. */
export function webglAvailable(): boolean {
  try {
    if (typeof document === "undefined") return false;
    const c = document.createElement("canvas");
    const gl =
      (c.getContext("webgl2") as WebGL2RenderingContext | null) ||
      (c.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Raise the panel over everything. Idempotent — a second call updates the
 *  copy of the one already up rather than stacking another. */
export function showGfxFail(host: HTMLElement, kind: GfxFailKind): HTMLElement {
  const doc = host.ownerDocument;
  let root = doc.getElementById(PANEL_ID);
  if (!root) {
    root = doc.createElement("div");
    root.id = PANEL_ID;
    root.setAttribute("role", "alertdialog");
    root.setAttribute("aria-live", "assertive");
    (doc.body ?? host).appendChild(root);
  }
  root.dataset.kind = kind;
  const c = COPY[kind];
  root.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;" +
    "justify-content:center;padding:24px;box-sizing:border-box;" +
    "background:radial-gradient(120% 90% at 50% 110%,#141b3a 0%,#080a16 55%,#05060c 100%);" +
    "color:var(--ink,#eef3ff);font-family:var(--font-body,'Segoe UI',system-ui,sans-serif);" +
    "text-align:center;";
  root.innerHTML = "";

  const box = doc.createElement("div");
  box.style.cssText = "max-width:460px;width:100%;";

  const title = doc.createElement("div");
  title.textContent = NAME_LABEL;
  title.style.cssText =
    "font-family:var(--font-display,'Segoe UI',system-ui,sans-serif);font-weight:700;" +
    "letter-spacing:0.28em;font-size:14px;color:var(--accent-2,#7fd8ff);" +
    "text-shadow:0 0 12px var(--accent-glow,rgba(95,141,255,0.4));";
  const jp = doc.createElement("div");
  jp.textContent = "首都高";
  jp.style.cssText = "margin-top:6px;font-size:12px;letter-spacing:0.4em;color:var(--jp,#ff6f9c);";

  const head = doc.createElement("h1");
  head.textContent = c.head;
  head.style.cssText =
    "margin:28px 0 12px;font-family:var(--font-display,'Segoe UI',system-ui,sans-serif);" +
    "font-size:22px;font-weight:600;letter-spacing:0.04em;line-height:1.25;";
  const body = doc.createElement("p");
  body.textContent = c.body;
  body.style.cssText = "margin:0 0 26px;font-size:14px;line-height:1.55;color:var(--ink-dim,#a6b3d6);";

  const btn = doc.createElement("button");
  btn.type = "button";
  btn.textContent = c.btn;
  btn.style.cssText =
    "appearance:none;cursor:pointer;min-height:44px;padding:12px 28px;border-radius:999px;" +
    "font-family:var(--font-display,'Segoe UI',system-ui,sans-serif);font-weight:600;" +
    "letter-spacing:0.18em;font-size:13px;color:var(--ink,#eef3ff);" +
    "background:var(--accent-soft,rgba(95,141,255,0.16));" +
    "border:1px solid var(--accent-line,rgba(140,178,255,0.5));" +
    "box-shadow:0 0 22px var(--accent-glow,rgba(95,141,255,0.4));";
  btn.addEventListener("click", () => doc.defaultView?.location.reload());

  box.append(title, jp, head, body, btn);

  /* Offered only where it can still help: on a context loss, and only while
     the game is not already holding itself back. Once safe mode is on, a
     second loss means the cut did not cover it and re-offering the same cut
     would be a lie. */
  if (kind === "lost" && !safeMode()) {
    const note = doc.createElement("p");
    note.textContent = SAFE_NOTE;
    note.style.cssText =
      "margin:26px auto 12px;max-width:380px;font-size:12.5px;line-height:1.5;" +
      "color:var(--ink-dim,#a6b3d6);opacity:0.85;";

    const safe = doc.createElement("button");
    safe.type = "button";
    safe.textContent = "RELOAD IN SAFE MODE";
    safe.style.cssText =
      "appearance:none;cursor:pointer;min-height:44px;padding:12px 24px;border-radius:999px;" +
      "font-family:var(--font-display,'Segoe UI',system-ui,sans-serif);font-weight:600;" +
      "letter-spacing:0.16em;font-size:12px;color:var(--ink-dim,#a6b3d6);" +
      "background:transparent;border:1px solid var(--accent-line,rgba(140,178,255,0.32));";
    safe.addEventListener("click", () => {
      forceSafeMode();
      doc.defaultView?.location.reload();
    });

    box.append(note, safe);
  }
  root.appendChild(box);
  btn.focus({ preventScroll: true });
  return root;
}
