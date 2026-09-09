/* PostHog product analytics — the one thin door every game event goes
   through.

   Contract: every export here is safe to call from anywhere, any time.
   Before init, on the server render, with PostHog blocked by an ad-blocker,
   or under Do Not Track, each call is a silent no-op — game code never
   checks "is analytics up?" and never sees a throw from in here.

   Event discipline (the whole point of the wrapper):
   - snake_case names, curated in one schema (see the call sites; the full
     table lives in the commit message that introduced this file);
   - NO per-frame or per-second events. Anything a player can spam has to
     come through trackThrottled (horn) or trackDebounced (settings
     sliders), never bare track();
   - anonymous only. We never call posthog.identify — PostHog's own
     anonymous distinct_id is the person. No emails, no names, ever.

   The phc_ key below is a PUBLIC client token (it can only ingest events,
   not read anything) — committing it is fine and is how PostHog snippets
   ship. A personal PostHog API key must never appear in this repo. */

import type posthogT from "posthog-js";

/* posthog-js is LAZY, and that is a load-time decision, not a taste one.

   It was a static import, so webpack put its 273 KB (88 KB over the wire)
   in the layout's own chunk — one of the handful of scripts the browser
   must have parsed before React can render anything at all. A quarter of
   the bytes standing between a cold visitor and the menu were product
   analytics.

   Now the module is fetched from an idle callback after the menu is up and
   every export below buffers until it lands, so NOTHING is lost: an event
   fired in the first second (game_start on a fast DRIVE press, a garage
   tap) is replayed into posthog in order the moment init finishes. The
   buffer is bounded — a browser where the module never arrives (blocked,
   offline) must not grow an array forever. */
type PostHog = typeof posthogT;
let posthog: PostHog | null = null;

const PH_KEY = "phc_wnyGBeLnfzWK3EgKMWeapbjtbDMuVrnVTkrjd5er2XYS";
const PH_HOST = "https://us.i.posthog.com";

let ready = false;
/** Init has been asked for and the module fetch is in flight or done. */
let started = false;
/** Calls made before the module landed, replayed in order once it has.
    Capped: past the cap the oldest are dropped, which is the right way
    round — a stale queued event is worth less than a fresh one. */
const pending: Array<() => void> = [];
const PENDING_MAX = 64;
function later(fn: () => void) {
  if (ready) { fn(); return; }
  if (!started) return; // opted out / webdriver / never initialised: drop
  if (pending.length >= PENDING_MAX) pending.shift();
  pending.push(fn);
}

/** True on the touch devices the engine itself treats as mobile —
    deliberately the same predicate as Game.isTouch (engine.ts), so the
    `device` super property and the engine's mobile/desktop split can never
    disagree about a device. */
export function deviceType(): "mobile" | "desktop" {
  if (typeof window === "undefined") return "desktop";
  return "ontouchstart" in window && matchMedia("(pointer:coarse)").matches
    ? "mobile"
    : "desktop";
}

/** Init once, from PostHogProvider's mount effect. Guards:
    - server render: no window, no-op (posthog-js would no-op too — belt
      and braces);
    - headless test runs (navigator.webdriver): the smoke/perf harnesses
      boot the real game in puppeteer, and their menu-walks must not pour
      fake players into the dashboard;
    - double mount (React strict/dev): the `ready` latch. */
/** Owner / tester opt-out. Visit once with `?owner=1` on a device and that
    browser is excluded from analytics for good (localStorage flag);
    `?owner=0` re-enables it. Client-side because the site has no server
    session to key an IP filter on — and the owner plays from several
    networks anyway. */
const OWNER_KEY = "neonx.analytics.optout";
function ownerOptedOut(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("owner");
    if (q === "1" || q === "true") localStorage.setItem(OWNER_KEY, "1");
    else if (q === "0" || q === "false") localStorage.removeItem(OWNER_KEY);
    return localStorage.getItem(OWNER_KEY) === "1";
  } catch {
    return false;
  }
}

/** Fetch posthog-js when the main thread has nothing better to do.

    requestIdleCallback with a timeout rather than a bare import: the module
    and the game's own engine chunk are both wanted in the first seconds and
    only one of them is on the path to a playable game. The timeout is the
    backstop for a page that never goes idle (it never fires on Safari
    without one, and Safari has no rIC at all — hence the setTimeout arm). */
const IDLE_TIMEOUT_MS = 2500;
function whenIdle(fn: () => void) {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
  }).requestIdleCallback;
  if (ric) ric(fn, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(fn, IDLE_TIMEOUT_MS);
}

export function initAnalytics() {
  if (started || typeof window === "undefined") return;
  if (navigator.webdriver) return;
  if (ownerOptedOut()) {
    console.info("[analytics] owner opt-out active — nothing is sent from this browser");
    return;
  }
  started = true;
  whenIdle(() => {
    void import("posthog-js").then((m) => bootPostHog(m.default)).catch(() => {
      /* Blocked by an extension, offline, chunk 404 after a redeploy. Drop
         the queue AND clear `started`, so later() stops buffering: with it
         still set, every track() for the rest of the session would push a
         closure onto a queue nothing will ever drain. */
      started = false;
      pending.length = 0;
    });
  });
}

function bootPostHog(ph: PostHog) {
  posthog = ph;
  try {
    posthog.init(PH_KEY, {
      api_host: PH_HOST,
      defaults: "2026-08-30",
      /* clicks/inputs on the menus for free; the canvas emits nothing */
      autocapture: true,
      /* capture_pageview stays at its default (on) — one page, one view */
      respect_dnt: true,
      /* Anonymous person profiles: every visitor gets a profile keyed on
         PostHog's generated distinct_id; identify() is never called, so no
         profile ever carries an email or a name. */
      person_profiles: "always",
      session_recording: {
        /* Canvas replay, DESKTOP ONLY.

           The whole game is one <canvas>, and session replay records the DOM,
           so with this off a replay shows the menus and HUD correctly and a
           BLACK RECTANGLE where the driving is. The owner watched one and
           asked why. This turns it on — but not on phones, which was his own
           call and the right one.

           What it actually costs, because "canvas capture is expensive" is
           too vague to decide on: the recorder does not snapshot every frame.
           It samples at canvasFps, capped at 12 and defaulting to 4, and
           encodes each snapshot at canvasQuality (default 0.4). The encode is
           minor. The part that matters for a WebGL game is that reading the
           canvas back forces a pipeline sync — the GPU has to finish what it
           is doing before the pixels can be handed over — and on a phone
           already fighting for its frame budget, four of those a second is a
           cost paid exactly where there is nothing spare. Desktops have the
           headroom; phones do not.

           deviceType() is the same predicate the engine uses for its own
           mobile split (see the comment there), so this can never disagree
           with what the game thinks it is running on. */
        captureCanvas: { recordCanvas: deviceType() === "desktop" },
        /* Client-side sampling: record every session. This takes precedence
           over the project's remote sample-rate setting (posthog-js
           SessionRecordingOptions.sampleRate).

           It was 0.25 — sensible at scale, useless here: at a few dozen
           visitors a quarter-sample is a handful of replays, and the owner
           looked for recordings and found none. Sample everything until the
           traffic is big enough for a sample to mean something.

           Recording ALSO has to be switched on project-side
           (session_recording_opt_in, PostHog → Settings → Session Replay);
           with that off this setting records nothing, whatever it says. */
        sampleRate: 1.0,
      },
    });
    ready = true;
    /* Super properties: stamped on every event from here on. `tier` is
       registered too, from the engine, once resolveRenderTier has run —
       see registerSuper calls in game/engine.ts. */
    registerSuper({ device: deviceType() });
    /* replay what happened while the module was still coming down the wire,
       in the order it happened — after registerSuper, so the buffered
       events carry the same super properties a live one would */
    for (const fn of pending.splice(0)) {
      try { fn(); } catch {}
    }
  } catch {
    /* an init that throws leaves ready=false and every track() a no-op —
       and, like the import failure above, stops the queue from filling */
    started = false;
    pending.length = 0;
  }
}

/** True while events have somewhere to go: init has been asked for and the
    module is either in flight (calls buffer) or up (calls fire). False when
    the owner opted out, under webdriver, before initAnalytics, and — the case
    that matters — after a posthog-js that never arrived cleared `started`.

    lib/telemetry.ts gates its whole sampler on this: with analytics off it
    must not so much as accumulate. Exported rather than inferred so there is
    one answer to "is anything being sent from this browser?". */
export function analyticsLive(): boolean {
  return started;
}

type Props = Record<string, string | number | boolean | null | undefined>;

/** Capture one curated event. No-op until initAnalytics has run. */
export function track(event: string, props?: Props) {
  if (!ready) { later(() => track(event, props)); return; }
  try {
    posthog!.capture(event, props);
  } catch {}
}

/** Merge super properties (stamped onto every subsequent event). */
export function registerSuper(props: Props) {
  if (!ready) { later(() => registerSuper(props)); return; }
  try {
    posthog!.register(props as Record<string, unknown>);
  } catch {}
}

/* Leading-edge throttle, per event name: the first call fires, everything
   inside the window is dropped. For burst-shaped inputs (the horn: "beep
   beep beep" is one use, not three events). */
const lastAt = new Map<string, number>();
export function trackThrottled(event: string, props?: Props, minMs = 8000) {
  if (!started) return;
  /* Throttling is decided HERE, not after the module lands: the window has
     to be measured from when the player actually honked. */
  const now = Date.now();
  const last = lastAt.get(event) ?? -Infinity;
  if (now - last < minMs) return;
  lastAt.set(event, now);
  track(event, props);
}

/* Trailing-edge debounce, per key: only the LAST call in a burst fires,
   with its (freshest) props. For drag-shaped inputs — a settings slider
   fires onChange on every tick of the drag, and the event worth keeping is
   the value the finger settled on. Keyed separately from the event name so
   two different sliders in one drag-happy visit don't swallow each other. */
const debounces = new Map<string, ReturnType<typeof setTimeout>>();
export function trackDebounced(key: string, event: string, props?: Props, waitMs = 1500) {
  if (!started) return;
  const t = debounces.get(key);
  if (t) clearTimeout(t);
  debounces.set(
    key,
    setTimeout(() => {
      debounces.delete(key);
      track(event, props);
    }, waitMs),
  );
}
