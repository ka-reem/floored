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

import posthog from "posthog-js";

const PH_KEY = "phc_wnyGBeLnfzWK3EgKMWeapbjtbDMuVrnVTkrjd5er2XYS";
const PH_HOST = "https://us.i.posthog.com";

let ready = false;

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

export function initAnalytics() {
  if (ready || typeof window === "undefined") return;
  if (navigator.webdriver) return;
  if (ownerOptedOut()) {
    console.info("[analytics] owner opt-out active — nothing is sent from this browser");
    return;
  }
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
  } catch {
    /* an init that throws leaves ready=false and every track() a no-op */
  }
}

type Props = Record<string, string | number | boolean | null | undefined>;

/** Capture one curated event. No-op until initAnalytics has run. */
export function track(event: string, props?: Props) {
  if (!ready) return;
  try {
    posthog.capture(event, props);
  } catch {}
}

/** Merge super properties (stamped onto every subsequent event). */
export function registerSuper(props: Props) {
  if (!ready) return;
  try {
    posthog.register(props as Record<string, unknown>);
  } catch {}
}

/* Leading-edge throttle, per event name: the first call fires, everything
   inside the window is dropped. For burst-shaped inputs (the horn: "beep
   beep beep" is one use, not three events). */
const lastAt = new Map<string, number>();
export function trackThrottled(event: string, props?: Props, minMs = 8000) {
  if (!ready) return;
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
  if (!ready) return;
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
