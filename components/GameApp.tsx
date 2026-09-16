"use client";

import { Fragment, useEffect, useRef, useState, useCallback } from "react";
import type { Game } from "@/game/engine";
// WIPER_MODE_NAMES went with the locked WIPERS drawer row — camnames.ts keeps it for the engine
import { CAM_NAMES } from "@/game/camnames";
import { track, trackDebounced, deviceType } from "@/lib/analytics";
import { showGfxFail, webglAvailable } from "@/game/gfxfail";
import { HINT_SHOW_MS, type HintMsg } from "@/game/hints";
import type { LoadReport } from "@/game/loading";
import { CARS, DEFAULT_CAR_ID, PAINTS, getCar } from "@/game/carspecs";
import {
  Gantry, NightRoad, SignKP, SignPlate, SignRow, SignRule, SignSep, SignShield, SignTitle,
  SignHead, SignBody, SignFootbar, SignBtn, SignToggle, SignSeg, SignSelect, SignSlider,
  SignShead, SignSrow, SignArrow, SignP,
} from "@/components/ui/Sign";
import { BETA_JP, BETA_LABEL, BETA_NOTE, GAME_NAME, IS_BETA, NAME_VERSION, SHOW_DEV_SETTINGS, VERSION_LABEL } from "@/lib/build";
import {
  loadProfile, saveProfile, defaultSettings, applyPresetDefaults, unitLabel,
  speedInUnits, fmtRunDist, syncRivalMode, syncCabinMode, cabinAutoLabel,
  type Profile, type GameSettings, type SpeedUnits,
} from "@/game/settings";

type Screen = "main" | "garage" | "settings" | "controls" | "stats" | "credits" | "loading" | "playing" | "paused" | "photo";

/** The "Report a bug" link (pause + credits): a plain mailto with the
    subject filled in and the build — beta flag included — in the body, so a
    report always says which build it saw. Everything about the build's
    identity comes from lib/build.ts; nothing here reads package.json.

    SET THE ADDRESS BELOW before shipping — it is a placeholder. */
const BUG_MAILTO =
  "mailto:you@example.com?subject=" + encodeURIComponent(`${NAME_VERSION} bug`) +
  "&body=" + encodeURIComponent(`${NAME_VERSION}\n\nWhat happened:\n`);

/** The BETA mark: 試験版 · BETA on a small outline chip, sitting with the
    corner caption rather than beside the title. It used to be a sodium plate
    in the strongest position on the board and out-shouted DRIVE, which is the
    only thing anyone came to press — so it keeps its words and loses its
    sodium, its 4px border and its halo. `sm` is the sub-screen size.

    Renders NOTHING once lib/build.ts's IS_BETA goes false, which is why every
    screen can mount it unconditionally. Deliberately absent from the driving
    HUD and the phone HUD — the in-drive frame stays clean. */
function BetaMark({ sm }: { sm?: boolean }) {
  if (!IS_BETA) return null;
  return (
    <span className={sm ? "sign-beta sm" : "sign-beta"}>
      <span className="sign-beta-jp ui-jp" lang="ja">
        {BETA_JP}
      </span>
      <span className="sign-beta-en">{BETA_LABEL}</span>
    </span>
  );
}

/* Press glow for the touch controls that are NOT .tc pucks — the ⋯ chip, the
   pause gear, and every row of the quick drawer.

   The pucks were deliberately moved off `:active` and onto a class written
   from the same pointer events the input reads (bindPointerHold in
   engine.ts), because :active is not the element's own idea of being pressed
   under a touch pointer. These three were left behind on :active, and
   measured on an emulated phone driven with real CDP multi-touch
   (test/multitouch-glow-check.mjs) NONE of them lights at all — not as the
   second finger and not as the first. All three carry
   `touch-action: manipulation`, which leaves the browser a gesture it might
   still claim, so it withholds the active state while it waits to see; the
   tap is long over by the time it decides. #gearBtn never had an :active rule
   at all.

   Same fix as the pucks: light from the pointer event itself. GLOW_MIN_MS is
   a floor so a fast tap is still visible, GLOW_MAX_MS a cap so nothing can
   stay lit, and the release is bound at the WINDOW rather than on the element
   because half of these presses close the sheet they sit on — an unmounted
   element never receives its own pointerup. */
const GLOW_MIN_MS = 130, GLOW_MAX_MS = 900;
function useTapGlow() {
  const held = useRef<{ el: HTMLElement; t0: number; timer: number } | null>(null);
  const clear = useCallback(() => {
    const s = held.current;
    if (!s) return;
    held.current = null;
    clearTimeout(s.timer);
    const left = Math.max(0, GLOW_MIN_MS - (performance.now() - s.t0));
    window.setTimeout(() => {
      // ...unless the same element has been pressed again since, whose glow
      // this now-stale timer must not take away
      if (held.current?.el !== s.el) s.el.classList.remove("pressed");
    }, left);
  }, []);
  useEffect(() => {
    const up = () => clear();
    /* Capture phase: a handler that stopPropagation()s its own pointerdown
       (#gearBtn and #tcMore both do) must not be able to strand a glow. */
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up);
      clear();
    };
  }, [clear]);
  return useCallback(
    (e: { currentTarget: EventTarget & HTMLElement }) => {
      clear();
      const el = e.currentTarget;
      el.classList.add("pressed");
      held.current = { el, t0: performance.now(), timer: window.setTimeout(clear, GLOW_MAX_MS) };
    },
    [clear],
  );
}

/* ---- the engine is a SEPARATE DOWNLOAD from the menu ----

   game/engine.ts is the whole game: three.js, the world build, the traffic
   fleet, the audio graph, the post chain. 1.2 MB of JavaScript. It used to
   be a plain static import here, which put it in the same chunk as this
   file — so a cold visitor could not see the main menu until every byte of
   the game had arrived AND been parsed, and the menu is the screen they
   look at while deciding to press DRIVE.

   Nothing on the main menu needs it: every read of the engine below is
   already written `g?.…` because the engine is built in a mount effect and
   the first render has never had one. So the menu now renders from a small
   chunk and the engine is fetched beside it.

   The fetch is kicked off HERE, at module scope, rather than inside the
   mount effect: this module is evaluated immediately before React renders,
   so the request goes out at the same moment the menu paints instead of one
   commit later. It is deliberately not awaited by anything but the handlers
   that genuinely need a Game.

   `void`-ing the promise is not enough on its own — an import() that
   rejects (offline, a stale chunk hash after a redeploy) is an unhandled
   rejection — so the catch is attached here and the failure is re-read by
   whoever awaits it. */
type EngineModule = typeof import("@/game/engine");
let engineMod: EngineModule | null = null;
let enginePromise: Promise<EngineModule | null> | null = null;
function loadEngine(): Promise<EngineModule | null> {
  if (engineMod) return Promise.resolve(engineMod);
  if (!enginePromise) {
    enginePromise = import("@/game/engine").then(
      (m) => (engineMod = m),
      () => null,
    );
  }
  return enginePromise;
}
if (typeof window !== "undefined") void loadEngine();

/** Run `fn` when the main thread is next idle, with a timeout backstop for a
    page that never goes idle — and a plain timer on Safari, which has no
    requestIdleCallback at all. */
/* Traffic density every SURVIVAL run is driven at, whatever the player's own
   slider says.

   The number is fixed and unchangeable, and the reason it has to be is the
   score: survival's number is a distance, kept as a personal best, and a best
   set on an empty road is not the same achievement as one set in traffic. A
   live slider would make the record meaningless.

   0.75, and the value is NOT a taste call — it is the highest density that
   means the same thing on every device.

   traffic.ts reads the slider in two pieces: a linear term against FLEET_BASE
   (120) that every tier shares, plus a jam term that only has any value above
   0.75 and that scales with TierCaps.fleetMax — 240 on desktop, 150 and 120 on
   the two phone tiers. So 0.85 is 144 cars on a desktop and 102 on a phone,
   and two players comparing bests would not have driven the same road. At 0.75
   the jam term is zero everywhere and the answer is 90 cars on every machine
   there is.

   90 is also, not by accident, exactly what the slider's 100% used to mean
   before the jam ceiling — i.e. the busiest road the game has ever actually
   shipped. Raising it is one constant here, but it costs cross-device
   comparability to do it. */
const SURVIVAL_TRAFFIC = 0.75;

const IDLE_TIMEOUT_MS = 1200;

/** How often the profile is written to localStorage WHILE DRIVING — the
    endless bank's safety net (see the effect that uses it). The most a player
    can lose to a closed tab, in milliseconds. */
const BANK_SAVE_MS = 20000;
function whenIdle(fn: () => void) {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
  }).requestIdleCallback;
  if (ric) ric(fn, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(fn, IDLE_TIMEOUT_MS);
}

export default function GameApp() {
  /* Idle-hidden mouse pointer, desktop only.

     The arrow parks in the middle of the frame while driving — nothing moves
     it, because steering is the keyboard — and it sits in every screen
     recording. Hidden after IDLE_MS of no movement and brought back by the
     first movement after that.

     Only while `playing`: in the menus the pointer is the input device, and a
     menu that eats your cursor after two seconds is hostile. The effect
     re-runs on `playing` and its cleanup drops the class, so leaving the game
     always restores it even if it was hidden at that moment.

     A class on <html> rather than pointer-lock. Lock would need a click to
     engage and Esc to release, and would break the clickable in-dash nav
     screen, which is a lot of machinery for "the arrow is in my shot".

     pointermove with `pointerType === "mouse"` rather than mousemove, so a
     touch or a stylus tap cannot trip a cursor state that device does not
     have. */
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  /* Settles when the engine chunk has landed and the Game has been built —
     or when it has failed to, in which case gameRef stays null and the
     callers below fall back to exactly the behaviour a WebGL-less browser
     already gets. Never rejects. */
  const gameReady = useRef<Promise<void> | null>(null);
  const profileRef = useRef<Profile | null>(null);
  const [screen, setScreen] = useState<Screen>("main");
  const [fromPause, setFromPause] = useState(false);
  const [toast, setToast] = useState("");
  const [exitHint, setExitHint] = useState<string | null>(null);
  /* First-run hints: text and visibility are separate so the fade-out has
     something to fade — clearing the text with the flag would empty the pill
     mid-transition. The text just stays behind opacity 0 until the next tip. */
  const [hint, setHint] = useState<HintMsg | null>(null);
  const [hintOn, setHintOn] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [load, setLoad] = useState<LoadReport>({ label: "", frac: 0 });
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenRef = useRef<Screen>("main");
  /* Mirrored for the same reason screenRef is: the UI callbacks handed to the
     engine are built once in a `[]` effect, so they close over the FIRST
     render's state forever. Reading `fromPause` directly in helpRequest would
     see `false` for the life of the session and H would never close. */
  const fromPauseRef = useRef(false);

  screenRef.current = screen;
  fromPauseRef.current = fromPause;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 1600);
  }, []);

  /* ---- analytics: run bookkeeping ----
     A "run" is a stretch of the playing screen: DRIVE/RESUME marks the
     session-stat counters, and every way OUT of the playing screen emits
     one run_end with the delta since the mark. Refs only (the ui callbacks
     handed to the engine are built once, same reason as screenRef), and
     both are no-ops until the world is loaded. */
  const runMark = useRef<{ t: number; d: number; cam: number[] } | null>(null);
  const markRun = useCallback(() => {
    const g = gameRef.current;
    if (g?.loaded) runMark.current = { t: g.sessionStats.driveT, d: g.sessionStats.dist, cam: [...g.cameraSeconds] };
  }, []);
  const emitRunEnd = useCallback((reason: "pause" | "help" | "exit") => {
    const g = gameRef.current, m = runMark.current;
    if (!g || !m || !g.loaded) return;
    const s = g.sessionStats;
    const secs = s.driveT - m.t, dist = s.dist - m.d;
    /* per-camera seconds for THIS run: which view people actually drive in.
       camera_main is the mode that held the most of the run. */
    const camNow = [...g.cameraSeconds];
    const camSecs: Record<string, number> = {};
    let camMain = "", camMax = -1;
    camNow.forEach((v, i) => {
      const d = Math.round(v - (m.cam[i] ?? 0));
      camSecs["camera_seconds_" + CAM_NAMES[i].toLowerCase()] = d;
      if (d > camMax) { camMax = d; camMain = CAM_NAMES[i]; }
    });
    runMark.current = { t: s.driveT, d: s.dist, cam: camNow };
    if (secs < 1) return; // Esc a beat after resuming is not a run worth a row
    track("run_end", {
      reason,
      seconds_played: Math.round(secs),
      distance_m: Math.round(dist),
      camera_main: camMain,
      ...camSecs,
      /* session-scope rollups, not per-run: topSpeed and the counters are
         the engine's session accumulator (Game.sessionStats) */
      top_speed_mph: Math.round(s.topSpeed * 2.236936),
      session_crashes: s.crashes,
      session_near_misses: s.nearMisses,
      session_laps: s.laps,
      /* THE SCORE, per run: how far the car got between crashes at the moment
         the run ended, and the profile's best-ever clean run. Both metres —
         the same engine unit distance_m above is in, converted for display
         only. Replaces nothing: run_end never carried the No Hesi points. */
      clean_run_m: Math.round(g.cleanRunDist),
      clean_best_m: Math.round(g.cleanRunBest),
    });
  }, []);

  /* create engine once, as soon as its chunk lands.

     Two phases, and the split is the whole point. The PROFILE half is
     synchronous — it is what the board reads for the current car, paint and
     seed, and it is a localStorage read, so making the menu wait a network
     round trip for it would be absurd. The ENGINE half waits on the import
     started at module scope above.

     Everything that reads `gameRef.current` was already written to survive
     it being null (the first render has never had a Game), so the gap this
     opens is one the code has always handled. The two places that genuinely
     cannot work without one — DRIVE, and the sub-screens that take a Game as
     a prop — go through ensureGame() below. */
  useEffect(() => {
    if (gameRef.current || !hostRef.current) return;
    /* No WebGL (locked-down browser, blocklisted GPU, hardware acceleration
       off): the renderer would throw inside `new Game()`. Say so on a
       branded panel instead — game/gfxfail.ts, shared with the engine's
       context-lost overlay. */
    if (!webglAvailable()) {
      showGfxFail(hostRef.current, "nowebgl");
      return;
    }
    const profile = loadProfile();
    profileRef.current = profile;
    /* traffic.ts reads rival mode from a live module value rather than from
       the engine (see the rival-mode block in settings.ts), so it has to be
       primed from the restored profile before the first frame. */
    syncRivalMode(profile.settings);
    /* Same reason, one file later: player.ts asks settings.ts whether this
       device may load a donor cabin, and the first rig is built before any
       settings panel has been opened. */
    syncCabinMode(profile.settings);
    /* Paint the restored profile now rather than at the end of the engine
       download: the board's "current car / paint / seed" line already falls
       back to profileRef when there is no Game (see the sign-plate below). */
    rerender();

    const host = hostRef.current;
    let disposed = false;
    let built: Game | null = null;
    gameReady.current = loadEngine().then((mod) => {
      if (disposed || !mod) return;
      buildGame(mod);
    });

    function buildGame(mod: EngineModule) {
      const game = new mod.Game(host, profile, {
        toast: showToast,
        exitHint: (t) => setExitHint(t),
        /* game/hints.ts fires each tip once ever and never overlaps two, so this
           only has to show, hold and let the CSS fade take it back down. */
        hint: (h) => {
          setHint(h);
          setHintOn(true);
          if (hintTimer.current) clearTimeout(hintTimer.current);
          hintTimer.current = setTimeout(() => setHintOn(false), HINT_SHOW_MS);
        },
        pauseRequest: () => {
          const s = screenRef.current;
          if (s === "playing") {
            gameRef.current?.setRunning(false);
            emitRunEnd("pause");
            setFromPause(true);
            setScreen("paused");
          } else if (s === "paused") {
            gameRef.current?.setRunning(true);
            setScreen("playing");
          } else if (s === "photo") {
            /* Esc in photo mode backs out of photo mode, it does not stack the
               pause menu on top of it — same two calls as photoRequest's exit
               branch, because leaving photo mode IS an unpause. */
            gameRef.current?.photoExit();
            gameRef.current?.setRunning(true);
            setScreen("playing");
          }
        },
        /* Photo mode is a pause that swaps which camera the frozen frame is
           rendered through, so this mirrors pauseRequest exactly: setRunning is
           the same sim freeze the pause menu uses, and the screen leaving
           "playing" is what hides every piece of HUD chrome (all of it is
           gated on `playing` below — nothing is hidden piecemeal). The engine's
           photoEnter/photoExit only move the camera and its listeners. */
        photoRequest: () => {
          const s = screenRef.current;
          if (s === "playing") {
            gameRef.current?.setRunning(false);
            gameRef.current?.photoEnter();
            setScreen("photo");
          } else if (s === "photo") {
            gameRef.current?.photoExit();
            gameRef.current?.setRunning(true);
            setScreen("playing");
          }
        },
        /* H TOGGLES. It used to only open: the guard was `=== "playing"`, so the
           second press hit a closed door and the only way out was the mouse.
           Opening and closing a screen with the same key is the whole point of
           a single-key overlay, and the asymmetry was just a missing branch.

           Closing goes through the same two calls `resume()` does — setRunning
           then setScreen — rather than reusing resume() itself, because that one
           also persists the profile, and a help screen has changed nothing worth
           writing to disk.

           Only from "controls" reached BY H (fromPause). The same screen is
           reachable from the main menu, where there is no game to resume and
           setRunning(true) would start one under the menu. */
        helpRequest: () => {
          if (screenRef.current === "playing") {
            gameRef.current?.setRunning(false);
            emitRunEnd("help");
            setFromPause(true);
            setScreen("controls");
          } else if (screenRef.current === "controls" && fromPauseRef.current) {
            gameRef.current?.setRunning(true);
            setFromPause(false);
            setScreen("playing");
          }
        },
      });
      gameRef.current = game;
      built = game;
      rerender();
      /* THE MENU IS IDLE TIME. The world build's two budgeted stages spend
         their seconds downloading ~10 MB of bodyshells and donor models that
         they do not ask for until they run — several seconds into a loading
         screen — while the connection sat idle for the whole time the player
         was reading this board. Ask for them now, at prefetch priority, so
         those stages find them in the cache.

         On idle rather than immediately: the engine chunk has only just
         landed and the menu's own first frames matter more than a speculative
         download. Nothing is parsed and no main-thread time is spent — see
         game/prefetch.ts, which also declines the whole idea on a Save-Data
         or 2g connection. */
      whenIdle(() => {
        if (gameRef.current === game) game.prefetchAssets();
      });
    }

    return () => {
      disposed = true;
      built?.destroy();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback(() => {
    const g = gameRef.current, p = profileRef.current;
    if (!g || !p) return;
    p.settings = g.settings;
    p.carId = g.carId;
    p.paintIx = g.paintIx;
    p.seed = g.seed;
    p.camMode = g.camMode;
    p.cleanRunBest = g.cleanRunBest;
    /* SURVIVAL: the bank and the record. Both getters already fold in what the
       profile was constructed with, so this is idempotent however often it
       runs — which matters, because unlike everything else here these are
       also written on a timer while the player drives (see the effect below):
       money that was driven for must survive a closed tab, not just a clean
       exit through the menu. */
    p.money = g.money;
    p.bestDistance = g.bestDistance;
    /* Lifetime totals: construction-time seed + this session, recomputed on
       every call (see Game.lifetimeStats) — writing it repeatedly is safe. */
    p.stats = g.lifetimeStats();
    p.ttt = g.tttTally;
    saveProfile(p);
  }, []);

  /* Wait for the engine chunk if it is still in the air, then hand back the
     Game. Instant (a resolved ref read) on every warm load and on every press
     after the first second or so of a cold one; the only calls that actually
     await are a tap that beats the download. Returns null when there is no
     Game to be had (no WebGL, or the chunk failed), which is the same null
     every caller here already handles. */
  const ensureGame = useCallback(async (): Promise<Game | null> => {
    if (gameRef.current) return gameRef.current;
    /* gameReady is set by a PASSIVE effect, which React schedules after the
       commit rather than inside it — so a press dispatched from a microtask
       (a harness, an autofill, an accessibility tool driving the page the
       instant the row appears) can land before the effect has run and find
       no promise to wait on at all. That press used to be swallowed in
       silence, before this file split the engine out and equally after.
       One turn of the event loop is all React needs to have flushed it. */
    for (let i = 0; i < 3 && !gameReady.current; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    if (gameReady.current) await gameReady.current;
    return gameRef.current;
  }, []);

  /* The three main-menu rows whose screens take a Game as a prop. Awaiting
     here rather than rendering the screen with no Game keeps the press
     feeling like a slow press instead of showing an empty board. */
  const openScreen = useCallback(
    async (s: Screen) => {
      await ensureGame();
      setScreen(s);
    },
    [ensureGame],
  );

  /* DRIVE. The world does not exist until this runs — the engine constructor
     only sets up a canvas and the settings the menus read (see Game.load) —
     so the first press pays for the whole build behind the loading screen.
     A second press (after MAIN MENU from the pause screen) is instant. */
  const drive = useCallback(async (survival = false) => {
    /* Almost always already there — the engine chunk is fetched from module
       scope, so it has had the whole time the player spent reading the board.
       `waited` is true only for a press that beat the download on a cold,
       uncached first visit. */
    const waited = !gameRef.current;
    const g = await ensureGame();
    if (!g) return;
    /* WHICH MODE THIS PRESS STARTS, decided here and written before the world
       build rather than carried in a toggle the player set earlier.

       FREE DRIVE and SURVIVAL are two game modes, not one button plus an
       on/off switch. So the board has two ways in, not one way in plus a
       toggle, and `endless` stops being a preference the player leaves lying around —
       every press states it. Free drive presses clear it; survival presses
       set it. A player who last drove survival and then taps FREE DRIVE gets
       free drive, which a toggle could not promise.

       SURVIVAL ALSO PINS THE TRAFFIC. The density slider is the player's
       everywhere else, but a distance score is only comparable against other
       runs at the same density — a personal best set at 15% traffic is not
       the same achievement as one set in a jam, and leaving the slider live
       would make the leaderboard number meaningless. See SURVIVAL_TRAFFIC for
       where the number comes from. The player's own setting is saved and put
       back when they next drive free. */
    if (survival) {
      if (!g.settings.endless) survivalTraffic.current = g.settings.traffic;
      g.settings.endless = true;
      g.settings.traffic = SURVIVAL_TRAFFIC;
    } else {
      if (g.settings.endless && survivalTraffic.current !== null)
        g.settings.traffic = survivalTraffic.current;
      g.settings.endless = false;
    }
    g.applySettings(g.settings);
    persist();
    const coldStart = !g.loaded; // whether this press pays for the world build
    /* Before anything asynchronous: iOS only unlocks an AudioContext created
       inside the gesture itself, and every line below this one is a task or
       more removed from the tap. */
    g.primeAudio();
    /* ...and if the await above already cost us that gesture, prime again on
       the next one. Cheap (audio.init and music.prime are both idempotent
       latches), one-shot, and it covers the only case the engine split can
       cost audio: a DRIVE press that lands before the engine chunk does. */
    if (waited) {
      const reprime = () => {
        removeEventListener("pointerdown", reprime, true);
        removeEventListener("keydown", reprime, true);
        gameRef.current?.primeAudio();
      };
      addEventListener("pointerdown", reprime, { capture: true, once: true });
      addEventListener("keydown", reprime, { capture: true, once: true });
    }
    /* Same gesture rule as primeAudio, and the reason this can't live in the
       mount effect: iOS only grants DeviceOrientation permission from inside a
       user gesture, and hookTilt() is one-shot (its tiltHooked guard means a
       refused hook never retries). A profile that loads with tilt steering has
       never hooked the listener — and the on-screen steer buttons are hidden
       in tilt mode — so without this the player has no steering at all. */
    if (g.settings.steerMode === "tilt") g.hookTilt();
    if (!g.loaded) {
      setLoadErr(null);
      setLoad({ label: "", frac: 0 });
      setScreen("loading");
      try {
        await g.load(setLoad);
      } catch (e) {
        // stay on the loading screen, but as an error state with a way out —
        // a half-built world is not something to drop the player into
        setLoadErr(e instanceof Error ? e.message : String(e));
        return;
      }
      // unmounted (or torn down and rebuilt) while we were loading
      if (gameRef.current !== g) return;
    }
    g.start();
    g.setRunning(true);
    setFromPause(false);
    setScreen("playing");
    /* the funnel's anchor event: main menu → behind the wheel. device is
       also a super property; explicit here because game_start is the row
       people segment first. */
    track("game_start", {
      device: deviceType(),
      graphics_tier: g.renderTier,
      graphics_preset: g.settings.preset,
      camera: CAM_NAMES[g.camMode],
      car: g.carId,
      paint: PAINTS[g.paintIx % PAINTS.length].name,
      seed: g.seed,
      cold_start: coldStart,
    });
    markRun();
    persist();
  }, [persist, markRun, ensureGame]);
  /* The traffic density the player had before a SURVIVAL run took the slider
     off them, so free drive can hand it back. Null until a survival run has
     actually borrowed it. */
  const survivalTraffic = useRef<number | null>(null);
  const resume = () => {
    gameRef.current?.setRunning(true);
    setScreen("playing");
    markRun(); // the next run_end measures from this resume, not from DRIVE
    persist();
  };
  /* Arrow keys walk the sign's rows on the home screen (Tab still works;
     Enter/Space activate the focused row natively since each row is a
     <button>). A window listener rather than onKeyDown on the rows, so the
     first press works with nothing focused yet — it lands on DRIVE. Mounted
     only while screen === "main"; the engine's own window key handling is
     untouched (it ignores arrows unless a drive is running, and this never
     stops propagation). */
  useEffect(() => {
    if (screen !== "main" && screen !== "paused") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const rows = [...document.querySelectorAll<HTMLButtonElement>(".signRoot button.sign-row")];
      if (!rows.length) return;
      const ix = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = ix < 0 ? 0 : (ix + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      rows[next].focus();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen]);
  const backToMenu = () => {
    emitRunEnd("exit"); // no-op unless the menu was reached straight from driving
    setFromPause(false);
    setScreen("main");
    /* Leaving for the menu is how a drive ends — bank it. resume() and
       drive() already persist; this was the one exit that didn't, and it is
       the natural end of a session for the lifetime stats (and cleanRunBest). */
    persist();
  };
  const backFrom = (sub: boolean) => {
    if (fromPause && sub) setScreen("paused");
    else setScreen("main");
  };

  /* analytics: one screen_view per menu screen entered. "playing" is not a
     menu — that transition is game_start/run_end territory above. */
  useEffect(() => {
    if (screen !== "playing") track("screen_view", { screen });
  }, [screen]);

  /* BANK THE DRIVE WHILE IT IS HAPPENING. Everything persist() writes used to
     be saved only at the edges of a drive — DRIVE, RESUME, MAIN MENU — which
     is fine for a setting and wrong for a currency: a tab closed or a phone
     that discards the page mid-run would cost the player every metre of money
     they had just earned (and their session's stats and clean-run record with
     it). So while the wheels are turning, save on a slow timer and on the way
     out of the page.

     BANK_SAVE_MS is 20s: one JSON.stringify of a small object per 20 seconds
     is nothing next to a frame, and 20s is the most a player can lose.
     pagehide covers the iOS case visibilitychange misses, and both are cheap
     no-ops when there is no Game. */
  useEffect(() => {
    if (screen !== "playing") return;
    const t = setInterval(persist, BANK_SAVE_MS);
    const onHide = () => persist();
    const onVis = () => {
      if (document.visibilityState === "hidden") persist();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
      persist();
    };
  }, [screen, persist]);

  const g = gameRef.current;
  const playing = screen === "playing";
  /* Touch overflow drawer (the ⋯ button). Session state only, deliberately:
     a drawer that re-opens on the next run is chrome the player has to clear
     before driving, which is the opposite of what an overflow is for. */
  const [drawer, setDrawer] = useState(false);
  const [moreDim, setMoreDim] = useState(false);
  /* Leaving the driving screen for any reason — pause, help, a crash into
     the main menu — closes the drawer, so it can never sit over a menu or
     greet the player already open on resume. */
  useEffect(() => {
    if (!playing && drawer) setDrawer(false);
  }, [playing, drawer]);
  /* Close on ANY pointerdown outside the drawer — which is also close-on-
     drive-input, because a tap on the wheel, a pedal or the canvas IS a tap
     outside the drawer. Capture phase so no stopPropagation downstream can
     keep the drawer from seeing it, and never preventDefault/stopPropagation
     here: the same press must still steer/brake/fire whatever it landed on.
     The drawer closing must only ever be a side effect of input, never a
     consumer of it. */
  useEffect(() => {
    if (!drawer) return;
    const close = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && (t.closest("#tcDrawer") || t.closest("#tcMore"))) return;
      setDrawer(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [drawer]);
  /* Auto-dim the ⋯ button while driving, same idea as the idle-hidden mouse
     cursor above: after a few seconds without a touch it fades to quarter
     presence (CSS .dim) and any touch anywhere brings it back. Dimmed, not
     hidden — a control that vanishes has to be rediscovered mid-drive. Touch
     devices only; desktop never shows the button at all. */
  useEffect(() => {
    if (!playing || typeof window === "undefined" || !("ontouchstart" in window)) return;
    const IDLE_MS = 3500;
    let t: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setMoreDim(true), IDLE_MS);
    };
    const wake = () => {
      setMoreDim(false);
      arm();
    };
    window.addEventListener("pointerdown", wake, true);
    arm();
    return () => {
      window.removeEventListener("pointerdown", wake, true);
      if (t) clearTimeout(t);
      setMoreDim(false);
    };
  }, [playing]);
  useEffect(() => {
    if (!playing) return;
    const IDLE_MS = 2000;
    const root = document.documentElement;
    let t: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => root.classList.add("cursor-idle"), IDLE_MS);
    };
    const wake = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      root.classList.remove("cursor-idle");
      arm();
    };
    window.addEventListener("pointermove", wake);
    arm();
    return () => {
      window.removeEventListener("pointermove", wake);
      if (t) clearTimeout(t);
      root.classList.remove("cursor-idle");
    };
  }, [playing]);
  const tcHide = playing ? undefined : { display: "none" as const };
  // press glow for the gear and the ⋯ chip — see useTapGlow
  const tapGlow = useTapGlow();

  return (
    <>
      <div ref={hostRef} />
      {/* HUD */}
      <div id="topbar" style={{ display: playing ? "flex" : "none" }}>
        {/* Passive telltales only: the tap-to-signal behavior these glyphs
            briefly carried has been removed — signals are keyboard-only
            (Q/E). #topbar stays pointer-events:none, so the
            bar can never intercept a driving touch. */}
        <span id="indL" className="ind">◀</span>
        <span id="clock">21:30</span>
        <span id="wx"></span>
        <span id="indR" className="ind">▶</span>
      </div>
      {/* display comes from globals.css when playing (the HUD stack is a flex
          column so the clean-run readout can sit under the speedo or under
          the gear by `order` alone) — the inline style only ever HIDES. */}
      <div id="hud" style={playing ? undefined : { display: "none" }}>
        <div className="spd" id="spd">0<small>{unitLabel(g ? g.settings.units : "mph")}</small></div>
        <div className="gear" id="gearTxt">D1</div>
        {/* Clean-run distance (game/engine.ts's hud() writes the text and the
            .run-reset/.run-blip classes; hidden via the setting, not via this
            style, so the engine is the one source of truth for whether it's
            on). Which of the three treatments is worn is the data-run
            attribute the engine stamps on #hud — see RUN_HUD in engine.ts and
            the #hud .runDist rules in globals.css. */}
        <div className="runDist" id="runDist" />
      </div>
      {/* SURVIVAL panel — run score (metres), personal best, bank. The
          engine writes all three figures and owns whether the panel is on
          screen at all (data-on, from settings.endless), the same contract
          the clean-run readout has; this style only ever hides it when the
          player is not driving. Top left — the one free corner of the frame;
          see the #ezHud block in globals.css. */}
      <div id="ezHud" data-on="0" style={playing ? undefined : { display: "none" }}>
        <div className="ez-cap">
          <i lang="ja">生存</i>SURVIVAL
        </div>
        <div className="ez-run">
          <span id="ezRun">0</span>
          <small>m</small>
        </div>
        <div className="ez-line">
          <b>BEST</b>
          <span id="ezBest">0</span> m
        </div>
        <div className="ez-line ez-bank">
          <b>¥</b>
          <span id="ezMoney">0</span>
        </div>
      </div>
      <div id="toast" style={{ opacity: toast ? 1 : 0 }}>{toast}</div>
      <div id="exitHint" style={{ opacity: exitHint && playing ? 1 : 0 }}>{exitHint}</div>
      {/* Desktop only: a click on the map cycles its zoom, routed through the
          Z key's own handler so the two can never drift (same uiKeyTap path
          the touch drawer uses). On touch the canvas keeps pointer-events:none
          (globals.css) — it sits over the throttle puck — so this handler is
          unreachable there and the drawer's MAP ZOOM row stands in. */}
      {/* First-run hint pill — engine fires via ui.hint, at most one at a
          time; sits below the exit board so the EXIT 4 tip can share the
          frame with the navigation hint it is explaining. */}
      <div id="hint" style={{ opacity: hint && hintOn && playing ? 1 : 0 }}>
        {hint && (
          <>
            {hint.en}
            <i>{hint.jp}</i>
          </>
        )}
      </div>
      <canvas
        id="mmap" width={172} height={172}
        style={{ display: playing && g?.mmap ? "block" : "none" }}
        onPointerDown={(e) => {
          if (e.button === 0) g?.uiKeyTap("z");
        }}
      />
      {playing && (
        <div
          id="gearBtn"
          onPointerDown={(e) => {
            e.stopPropagation();
            tapGlow(e);
            gameRef.current?.setRunning(false);
            emitRunEnd("pause");
            setFromPause(true);
            setScreen("paused");
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Settings">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z" />
          </svg>
        </div>
      )}
      {/* ⋯ — the touch overflow. One unobtrusive button beside the pause
          gear; everything a keyboard has that the pucks don't fits behind it
          (see QuickDrawer). Toggling on pointerdown keeps it as immediate as
          the gear button next door; the stopPropagation is only so the
          drawer's own outside-tap closer (capture phase, unaffected) is the
          single authority on closing — without it this press would toggle
          and bubble into nothing anyway, but the intent reads clearer. */}
      {playing && (
        <div
          id="tcMore"
          className={moreDim && !drawer ? "dim" : undefined}
          aria-label="More controls"
          onPointerDown={(e) => {
            e.stopPropagation();
            tapGlow(e);
            setDrawer((d) => !d);
          }}
        >
          ⋯
        </div>
      )}
      {playing && g && <QuickDrawer game={g} open={drawer} onClose={() => setDrawer(false)} />}
      {screen === "photo" && g && <PhotoHint game={g} />}
      {/* Touch controls. These stay mounted on every screen — bindInput()
          grabs them by id once, in the Game constructor — so the menus hide
          them with an inline display instead of unmounting them. */}
      <div className="tc" id="tcL" style={!playing || (g && g.settings.steerMode !== "buttons" && analogSteerLive()) ? { display: "none" } : undefined}>⟲</div>
      <div className="tc" id="tcR" style={!playing || (g && g.settings.steerMode !== "buttons" && analogSteerLive()) ? { display: "none" } : undefined}>⟳</div>
      <div className="tc" id="tcG" style={tcHide}>▲</div>
      <div className="tc" id="tcB" style={tcHide}>▼</div>
      <div className="tc" id="tcC" style={tcHide}>CAM</div>
      <div className="tc" id="tcF" style={tcHide}>LTS</div>
      <div className="tc" id="tcH" style={tcHide}>HORN</div>
      {playing &&
        g &&
        g.settings.steerMode === "wheel" &&
        typeof window !== "undefined" &&
        "ontouchstart" in window && <SteerWheel game={g} />}
      {playing &&
        g &&
        g.settings.steerMode === "slider" &&
        typeof window !== "undefined" &&
        "ontouchstart" in window && <SteerSlider game={g} />}

      {/* ---------- menus ---------- */}
      {/* Home screen: a blue expressway guide-sign hung on a lit gantry over
          the dashcam road ("Blue Route v2" styling; the kit is
          components/ui/Sign.tsx + app/ui-system.css). The rows are real
          buttons whose text still carries DRIVE / RIVAL / GARAGE / SETTINGS /
          CONTROLS — every headless test finds them by textContent. Before the
          first drive there is no world under the menu (Game.load builds it),
          so a CSS night road stands in; once loaded, the live scene shows
          through instead, in whichever camera the player left it. */}
      {screen === "main" && (
        <div className="menuRoot signRoot">
          {!g?.loaded && <NightRoad />}
          <Gantry />
          <div className="sign-stack">
            <SignPlate hangers>
              <header className="sign-head">
                <SignShield />
                <SignTitle jp="首都高ナイトドライブ" en="FLOORED" />
                {/* corner group: the build mark sits WITH the caption, not
                    beside the title. The caption lines drop out on a phone
                    (ui-system.css); the chip stays. */}
                <div className="sign-corner sign-cap" aria-hidden="true">
                  <BetaMark />
                  <span className="sign-corner-lines">
                    TOKYO METROPOLITAN
                    <br />
                    EXPWY · NIGHT
                    <br />
                    <span className="ui-jp" lang="ja">首都高速</span>
                  </span>
                </div>
              </header>
              <SignRule />
              <nav className="sign-rows" aria-label="Main menu">
                <SignRow
                  selected glyph="up" jp="本線" en="FREE DRIVE" dist="0.0"
                  onClick={() => drive(false)}
                />
                <SignSep />
                {/* SURVIVAL — a second way to START a drive, not a switch.

                    It used to be ENDLESS, a row with an ON/OFF badge that set
                    a preference the player then had to press DRIVE to use.
                    It is a game mode, not an on/off switch: you click it and
                    you get a drive until you crash. So the badge is gone and
                    the row starts a run, the same as the one above it — the
                    board offers two drives, and which one you pressed is what
                    decides the rules.

                    SURVIVAL was picked from four names shot on this board;
                    ENDLESS read as a mode setting rather than a drive. */}
                <SignRow
                  glyph="ne"
                  jp="生存"
                  en="SURVIVAL"
                  note="DRIVE UNTIL YOU CRASH"
                  onClick={() => drive(true)}
                />
                {/* The same setting the panel carries, surfaced here so the mode
                    is discoverable without going three screens deep. */}
                {/* THE RIVAL IS HELD BACK for the beta, but the row STAYS,
                    reading NOT AVAILABLE rather than disappearing. A disabled
                    <button>, so it keeps its place and its name in the
                    destination list and reads NOT AVAILABLE where the ON/OFF
                    chip used to be.

                    No onClick and no badge, deliberately: this was the only
                    control that wrote settings.rival outside the settings
                    panel's upd(), and the badge read from the profile — with
                    the scrub in settings.ts clearing rival on load, a live
                    badge here would always have said OFF, which reads as "you
                    can switch it on" rather than "not yet". Unlocking is
                    restoring the onClick and the badge, un-disabling it, and
                    dropping the scrub. */}
                <SignRow
                  disabled
                  className="na"
                  glyph="ne"
                  jp="好敵手"
                  en="RIVAL"
                  note="NOT AVAILABLE"
                  dist="1.2"
                />
                <SignRow glyph="p" jp="車庫" en="GARAGE" dist="0.4" onClick={() => void openScreen("garage")} />
                <SignRow glyph="nw" jp="設定" en="SETTINGS" dist="2.6" onClick={() => void openScreen("settings")} />
                <SignRow glyph="nw" jp="操作" en="CONTROLS" dist="3.1" onClick={() => setScreen("controls")} />
              </nav>
              {/* landscape-phone stand-in for the plate below: one caption
                  line inside the board (ui-system.css shows it only there) */}
              <div className="sign-foot sign-cap faint" aria-hidden="true">
                <span className="ui-jp" lang="ja">現在の車</span> {getCar(g?.carId || DEFAULT_CAR_ID).name} ·{" "}
                {PAINTS[(g?.paintIx || 0) % PAINTS.length].name} · TOWN SEED {g?.seed} ·{" "}
                <span className="sign-ver">{VERSION_LABEL}</span>
              </div>
            </SignPlate>
            {/* The same words as before, said ONCE and without a plate around
                them: no border, no backlight, no second version chip — caption
                text standing in whitespace under the board. (The bordered
                .sign-plate is still what the credits screen uses.) */}
            <div className="sign-plate flat">
              <span className="sign-plate-line">
                <span className="ui-jp" lang="ja">現在の車</span>{" "}
                <span>
                  {getCar(g?.carId || DEFAULT_CAR_ID).name} · {PAINTS[(g?.paintIx || 0) % PAINTS.length].name} · TOWN
                  SEED {g?.seed} · <span className="sign-ver">{VERSION_LABEL}</span>
                </span>
              </span>
              <span className="sign-plate-line faint">
                A PROCEDURALLY GENERATED TOWN · ELEVATED EXPRESSWAY · DENSE TRAFFIC
              </span>
              {/* The one line of beta copy (lib/build.ts BETA_NOTE): what to
                  expect, and where the bug link already lives. It sits on the
                  home plate rather than in game/hints.ts on purpose — the
                  first-run hints fire over a moving car, and the in-drive
                  frame stays clean. Gone with IS_BETA. */}
              {IS_BETA && <span className="sign-plate-line beta">{BETA_NOTE}</span>}
              {/* the way to the credits (attributions, privacy); the build
                  number is on the first line now rather than said twice */}
              <span className="sign-plate-line foot">
                <button type="button" className="sign-plate-btn" onClick={() => setScreen("credits")}>
                  CREDITS
                </button>
              </span>
            </div>
          </div>
          {/* the kilometre post reads the lifetime distance driven */}
          <SignKP value={g ? (g.lifetimeStats().dist / 1000).toFixed(1) : "0.0"} />
        </div>
      )}

      {screen === "loading" && (
        <LoadingScreen
          label={load.label}
          frac={load.frac}
          error={loadErr}
          game={g}
          onSettingChange={persist}
        />
      )}

      {/* Pause: a 620-wide board (Pause.dc.html) over the frozen frame. The
          design's mounting post is gone — see ui-system.css for why. The rows paint their JP from data-jp so each button's text is
          exactly its EN label — every harness finds the pause menu by a
          button that says "RESUME". In landscape the rows sit in two columns
          so the whole board fits without scrolling (ui-system.css). */}
      {screen === "paused" && (
        <div className="menuRoot signRoot sub paused">
          <div className="sign-stack sub narrow">
            <SignPlate screen>
              {/* No build mark and no kilometre post: this is a four-second
                  interruption, not a landing screen. */}
              <SignHead jp="一時停止" en="PAUSED" corner={<>Esc RESUMES<br />MUSIC PAUSED</>} />
              <SignRule />
              <SignBody>
                <nav className="sign-rows two" aria-label="Pause menu">
                  <SignRow selected jpAttr glyph="up" jp="再開" en="RESUME" onClick={resume} />
                  <SignSep />
                  <SignRow jpAttr glyph="ne" jp="記録" en="STATS" onClick={() => setScreen("stats")} />
                  <SignRow jpAttr glyph="p" jp="車庫" en="GARAGE" onClick={() => setScreen("garage")} />
                  <SignRow jpAttr glyph="nw" jp="設定" en="SETTINGS" onClick={() => setScreen("settings")} />
                  <SignRow jpAttr glyph="nw" jp="操作" en="CONTROLS" onClick={() => setScreen("controls")} />
                  {/* whitespace, not a second hairline: the two rows below end
                      or restart the drive, and they should separate from the
                      navigation by a gap you cannot mistake for a divider */}
                  <div className="sign-gap" aria-hidden="true" />
                  <SignRow
                    jpAttr
                    glyph={<>↺</>}
                    jp="リセット"
                    en="RESET CAR"
                    note="NEAREST ROAD"
                    onClick={() => {
                      gameRef.current?.resetCar();
                      resume();
                    }}
                  />
                  <SignRow jpAttr glyph={<>↩</>} jp="出口" en="MAIN MENU" note="ENDS THE DRIVE" onClick={backToMenu} />
                </nav>
              </SignBody>
              {/* One line, because a pause screen is a four-second
                  interruption: the endless record, in the mode's own metres.
                  Only while the mode is on — with it off this is the clean-run
                  readout's number and the STATS board is where it belongs. */}
              <SignFootbar
                keep
                caption={
                  <>
                    {GAME_NAME} <span className="sign-ver">{VERSION_LABEL}</span>
                    {g?.settings.endless && <> · BEST {Math.floor(g.bestDistance).toLocaleString("en-US")} m</>}
                  </>
                }
              >
                <a className="sign-btn ghost sm" href={BUG_MAILTO}>REPORT A BUG</a>
              </SignFootbar>
            </SignPlate>
          </div>
        </div>
      )}

      {screen === "credits" && <CreditsScreen loaded={!!g?.loaded} onBack={() => backFrom(true)} />}

      {screen === "stats" && g && (
        <StatsPanel game={g} onBack={() => backFrom(true)} />
      )}
      {screen === "garage" && g && (
        <GaragePanel
          game={g}
          onBack={() => {
            persist();
            backFrom(true);
          }}
        />
      )}
      {screen === "settings" && g && (
        <SettingsPanel
          game={g}
          onBack={() => {
            persist();
            backFrom(true);
          }}
          onApplyReload={() => {
            persist();
            location.reload();
          }}
          onReseed={() => {
            /* Write the new seed to the GAME, not to the profile. persist()
               below does `p.seed = g.seed` before saving, so setting p.seed
               here was overwritten by the old value one line later and the
               reload rebuilt the identical town — the button did nothing, and
               the panel's own "Town seed" readout proved it by not changing.
               Going through the game is also the only version that survives
               someone reordering persist(). */
            const g = gameRef.current;
            if (g) g.seed = (Math.random() * 100000) | 0;
            persist();
            location.reload();
          }}
        />
      )}
      {screen === "controls" && (
        <ControlsScreen
          loaded={!!g?.loaded}
          onBack={() => backFrom(true)}
          onCredits={() => setScreen("credits")}
        />
      )}
    </>
  );
}

/* ================= settings, while it loads =================

   Settings are offered DURING the load, so a wait that has to happen is
   spent doing something rather than watching a bar. This matters most on
   mobile, where the load is longest.

   WHAT IT MAY OFFER is decided by the world build, not by taste. Every row
   here writes ONLY `game.settings` (plus the profile) and is read live by
   something that has not been built yet or is re-read every frame:

     touch steering  readInput reads settings.steerMode every frame. Picking
                     "tilt" also hooks the orientation listener, which iOS
                     only grants inside a user gesture — the tap on the
                     control IS that gesture, so it is the one place besides
                     the DRIVE press where switching to tilt can work at all.
     speed units     the HUD formats from settings.units; nothing is built
                     from it.
     volume          applied by setRunning(true) at the end of the load
                     (audio.setLevels(s.vol, 1)), which happens after every
                     one of these rows.
     rival car       WAS offered here on the same grounds — traffic.ts reads a
                     module value refreshed through syncRivalMode, and claims
                     its pool slot on the toggle rather than at construction.
                     The row is gone because the rival is off for the beta, not
                     because it could not be honoured; syncRivalMode still runs
                     on every row below.
     camera view     camUpdate() branches on game.camMode every frame and
                     nothing is built from it — the warm pass links all the
                     modes' programs regardless. Written through the engine's
                     setCamMode() rather than by hand, because that is the one
                     window where a raw assignment could be undone; see the
                     method for why.
     traffic         engine.ts passes settings.traffic into traffic.update()
                     every frame as the live pool cap. The POOL is a fixed
                     TierCaps.fleetMax slots built by the traffic stage no
                     matter what this row says — the slider only decides how
                     many of them are live — so the row is honoured before and
                     after it.
     minimap         hudVisible() reads game.mmap every frame, and the canvas
                     is shown by GameApp's own render once play starts.

   THREE OF THESE ARE ENGINE MIRRORS, not plain settings fields: camMode,
   mmap and grade are copied out of the profile in the constructor and are
   the live values from then on, so a row that wrote only `settings` would
   save the pick and not apply it. Those rows write both sides, exactly as
   the in-game keys (C / X / V) do. Anything NOT mirrored — every field the
   engine reads through `this.settings` — needs only the settings write.

   WHAT IT MAY NOT OFFER, and why this panel is short: GRAPHICS. The preset
   is consumed by the FIRST stage of the build (MIXING PAINT decides there
   and then whether the photo scans are fetched at all) and half a dozen
   later ones inherit that decision, so a preset control here would either
   lie about what it did or force the build to start over. Same for the
   render tier and the imported cabin. A control that cannot honour the tap
   is worse than no control, so those rows stay in SETTINGS, where the world
   is either not built yet or can be rebuilt around them.

   IT APPEARS THE MOMENT THE LOAD DOES. It is not a dialog — no overlay, no
   close button, nothing to dismiss. It is more of the same board, under the
   bar, and it leaves with the screen.

   IT WAS GATED BEHIND A DELAY AND THAT IS GONE. First 2500 ms, then 800 —
   both were guesses at "only show this if the load is slow enough to be
   worth filling", and watching the 800 ms build settled it: a panel that
   arrives seconds after the loading screen does reads as a glitch, not as an
   offer. So there is no gate — the rows are in the first painted frame of
   the loading screen. A warm DRIVE is over
   fast enough that the panel simply comes and goes with it, which costs
   nothing and is far cheaper than the player who left during the gap.

   ONE HONEST CAVEAT, stated here because it is a property of the loader and
   not of this panel: each build stage is a single synchronous block, so a
   tap that lands inside one is queued and answered at that stage's end
   rather than immediately (loading.ts yields to a paint between stages, and
   only between them). With no gate at all the panel is up before the first
   blocking stage, so an early tap is the likeliest kind: it is queued and
   answered at that stage's end rather than the instant it lands, so a row
   can take a beat to repaint. Nothing is dropped — the pick always applies —
   and a control that repaints late beats a control the player never sees. */

function LoadSettings({ game, onChange }: { game: Game; onChange: () => void }) {
  const [, force] = useState(0);
  const s = game.settings;
  /* No applySettings() call. Every row above is live-read or applied at
     start(); calling it here would rebuild render targets and re-key shadow
     programs in the middle of a stage that is mid-build, for no gain. */
  /* One door, like the settings panel's own upd(): every row names the key it
     changed so the event says WHICH control people reach for while they wait,
     and syncRivalMode runs whether or not the rival row was the one touched
     (the same "wire it once" rule the panel follows). onChange writes the
     profile — these are saved, not just applied to this drive. */
  const upd = (key: string, fn: (x: GameSettings) => void) => {
    fn(s);
    syncRivalMode(s);
    onChange();
    force((n) => n + 1);
    track("load_settings_change", { setting: key, device: deviceType() });
  };
  return (
    <div className="loadSet">
      <div className="loadSetHead">
        <b>WHILE YOU WAIT</b>
        <span className="ui-jp" lang="ja">設定</span>
        <i>saved as you pick</i>
      </div>
      <div className="loadSetRows">
        {/* TOUCH ONLY: the on-screen controls exist only for mobile, so the
            row has no business on desktop. Every option here — BUTTONS,
            WHEEL, SLIDER — is an on-screen touch control; a desktop player steers
            with WASD/arrows and steerMode does nothing for them, so the row
            was asking a question their answer could not change.

            game.isTouch is the same predicate readInput uses to decide
            whether to read the touch controls at all (and the same one
            deviceType() reports), so this row is shown exactly when the
            setting behind it is live. */}
        {game.isTouch && (
        <SignSrow name="Steering">
          <SignSeg
            label="Steering"
            value={s.steerMode}
            options={[
              { v: "buttons", t: "BUTTONS" },
              { v: "wheel", t: "WHEEL" },
              { v: "slider", t: "SLIDER" },
              /* TILT is locked for the beta — see the migration note in
                 settings.ts for the three faults in hookTilt() that cannot be
                 verified without a real phone. Putting this row back is the
                 whole of unlocking it. */
            ]}
            onChange={(v) =>
              upd("steerMode", (x) => {
                x.steerMode = v as GameSettings["steerMode"];
                // same gesture rule as the DRIVE press — see drive()
                if (x.steerMode === "tilt") game.hookTilt();
              })
            }
          />
        </SignSrow>
        )}
        <SignSrow name="Speed units">
          <SignSeg
            label="Speed units"
            value={s.units}
            options={[{ v: "mph", t: "MPH" }, { v: "kmh", t: "KM/H" }]}
            onChange={(v) => upd("units", (x) => (x.units = v as SpeedUnits))}
          />
        </SignSrow>
        {/* live: camUpdate() branches on camMode every frame (engine.ts).
            Four of the six — the console and backseat brackets stay on the C
            key and the settings screen, because a six-way segmented control
            does not fit a 390 px board, which is the phone this panel exists
            for. */}
        <SignSrow name="Camera">
          <SignSeg
            label="Camera"
            value={String(game.camMode)}
            options={[
              { v: "3", t: "DASHCAM" },
              { v: "0", t: "CHASE" },
              { v: "1", t: "COCKPIT" },
              { v: "2", t: "HOOD" },
            ]}
            onChange={(v) =>
              upd("camMode", () => {
                /* Not a GameSettings field — it lives on the profile, and
                   persist() writes p.camMode = g.camMode, so onChange() below
                   saves it like every other row here. */
                game.setCamMode(Number(v));
              })
            }
          />
        </SignSrow>
        {/* live: passed into traffic.update() every frame as the pool cap
            (engine.ts). Three stops off the settings screen's 20..100 slider,
            which stays the fine control; a load board gets one tap. */}
        {/* Same pin as the settings panel's slider, and it matters more here:
            this board is up DURING a survival load, so a control that appeared
            to change the density would be changing it out from under the run
            the player just started. */}
        {s.endless ? (
          <SignSrow name="Traffic">
            <span className="sign-cap faint">
              {Math.round(SURVIVAL_TRAFFIC * 100)}% &middot; FIXED
            </span>
          </SignSrow>
        ) : (
          <SignSrow name="Traffic">
            <SignSeg
              label="Traffic"
              value={s.traffic <= 0.5 ? "light" : s.traffic <= 0.85 ? "some" : "heavy"}
              options={[
                { v: "light", t: "LIGHT" },
                { v: "some", t: "SOME" },
                { v: "heavy", t: "HEAVY" },
              ]}
              onChange={(v) =>
                upd("traffic", (x) => (x.traffic = v === "light" ? 0.4 : v === "some" ? 0.7 : 1))
              }
            />
          </SignSrow>
        )}
        {/* Held back for the beta, but kept in the list rather than removed,
            reading NOT AVAILABLE. Static caption, no toggle: the profile scrub in settings.ts is what makes
            it true for players who already had it on, and upd() still calls
            syncRivalMode on every other row so the module flag keeps following
            the scrubbed profile and traffic.ts never claims the slot. */}
        <SignSrow name="Rival car" aside="— chase the orange one">
          <span className="sign-cap faint">NOT AVAILABLE</span>
        </SignSrow>
        {/* live: hudVisible() reads game.mmap every frame; the canvas itself is
            shown by this file's own render the moment play starts. Mirrored
            field — settings alone would save it without applying it. */}
        <SignSrow name="Minimap">
          <SignToggle
            label="Minimap"
            checked={s.mmap}
            onChange={(v) =>
              upd("mmap", (x) => {
                x.mmap = v;
                game.mmap = v;
              })
            }
          />
        </SignSrow>
        <SignSrow last stack name="Volume">
          <SignSlider
            label="Volume"
            min={0}
            max={100}
            value={Math.round(s.vol * 100)}
            text={`${Math.round(s.vol * 100)}%`}
            onChange={(v) => upd("vol", (x) => (x.vol = v / 100))}
          />
        </SignSrow>
      </div>
    </div>
  );
}

/* ================= loading screen ================= */

/* Rendered from the DRIVE tap until the world is built and warmed — the toll
   plaza you wait at (Loading.dc.html): a gantry with three booth plates, the
   home board's shield and titles, a lane-arrow progress track and the stage
   being built, in the sign language.

   Everything that moves here moves on the compositor (see the .loadRoot and
   .signLoad blocks in globals.css / ui-system.css): each build stage blocks
   the main thread outright, so any JS-driven or layout-driven animation would
   freeze exactly when the player most needs to see that something is
   happening. React re-renders this once per stage — a dozen times over the
   whole load — and the CSS carries the motion in between. The .loadRoot /
   .loadErr / .pct / .loadStatus hooks are what the harnesses read. */
function LoadingScreen({
  label, frac, error, game, onSettingChange,
}: {
  label: string;
  frac: number;
  error: string | null;
  game: Game | null;
  onSettingChange: () => void;
}) {
  return (
    <div className="loadRoot signLoad">
      <div className="toll" aria-hidden="true">
        <div className="gantry-truss" />
        <div className="gantry-lattice" />
        <div className="toll-booths">
          <div className="toll-booth etc"><i /><b>ETC</b></div>
          <div className="toll-booth open"><i /><b>↑ OPEN</b></div>
          <div className="toll-booth jp"><i /><b lang="ja">一般</b></div>
        </div>
      </div>
      <div className="sign-stack load">
        <div className="sign loadboard">
          <div className="sign-sheet" aria-hidden="true" />
          <header className="sign-head">
            <SignShield />
            <div className="sign-titles">
              <div className="sign-title-jp loadJp" lang="ja">首都高ナイトドライブ</div>
              <h1 className="sign-title loadTitle">FLOORED</h1>
            </div>
            {/* the build chip rides in the corner here too, not on the title */}
            <div className="sign-corner sign-cap" aria-hidden="true">
              <BetaMark />
            </div>
          </header>
          <SignRule />
          {error ? (
            /* Reload rather than retry: a stage that threw left a half-built world
               in the scene, and running the stages again over it would stack a
               second town on the first (see Game.loadFailed). */
            <div className="loadErr">
              <div className="tri" aria-hidden="true" />
              <div>
                Something went wrong building the town.
                <code>{error}</code>
              </div>
              <SignBtn variant="primary" onClick={() => location.reload()}>
                RELOAD
              </SignBtn>
            </div>
          ) : (
            <>
              <div className="loadBar">
                {/* scaleX rather than width so the bar keeps travelling while the
                    next stage blocks the main thread */}
                <div className="loadFill" style={{ transform: `scaleX(${frac})` }} />
                <div className="loadSweep" />
                <div className="loadDashes" aria-hidden="true" />
              </div>
              <div className="loadStatus">
                <div className="stage">
                  <b>BUILDING</b>
                  <span>{label}</span>
                </div>
                <div className="pct">
                  {Math.round(frac * 100)}
                  <small>%</small>
                </div>
              </div>
              <div className="sign-cap faint loadCap">
                first press builds the whole town · the next DRIVE is instant
              </div>
              {game && <LoadSettings game={game} onChange={onSettingChange} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================= touch steering wheel ================= */

/* Mirrors Game.isTouch (engine.ts): readInput only takes the wheel/tilt value
   on a coarse-pointer touch device. Anywhere else the analog paths are dead, so
   the on-screen steer buttons have to stay up or there is no steering at all.
   Only ever called with a live Game in hand, i.e. after mount — never during
   the server render, where `window` does not exist. */
function analogSteerLive() {
  return "ontouchstart" in window && matchMedia("(pointer:coarse)").matches;
}

/* The analog steering wheel. Nothing but steering: the HORN boss that used
   to sit in the middle of it — a second horn control, a hand's width from
   the HORN puck that is on screen in every steer mode — has been removed.
   The horn itself is untouched: the #tcH puck and the F key both still
   write the same keydown["f"] they always did.

   With it went the whole hub-press discrimination — HUB_R/DRAG_PX/HOLD_MS/
   STAB_MS, the pending-press timer, the stab blip and Game.setWheelHorn —
   so a press anywhere on this wheel is a steering input and nothing else. */
function SteerWheel({ game }: { game: Game }) {
  const [rot, setRot] = useState(0);
  const active = useRef(false);
  const pid = useRef<number | null>(null);
  const cx = useRef(0);
  const end = useCallback(() => {
    active.current = false;
    pid.current = null;
    game.setWheelVal(0);
    game.setWheelPointer(null);
    setRot(0);
  }, [game]);
  /* Pausing unmounts this widget mid-drag; without zeroing here the last
     deflection keeps feeding readInput and the car resumes at hard lock. */
  useEffect(
    () => () => {
      game.setWheelVal(0);
      game.setWheelPointer(null);
    },
    [game],
  );
  /* Belt-and-braces: a gesture the browser hijacks outright (an edge-swipe,
     the loupe the mobile-input work elsewhere is closing) can end a touch
     without ever delivering pointerup/pointercancel/lostpointercapture to
     #swheel itself. The window still sees the pointer go away — capture only
     changes who an event targets, not whether window sees it at all in the
     bubble phase — so this is the second line of defence behind
     Game.watchdogTouchInput(), which is the third (see engine.ts). */
  useEffect(() => {
    const release = (e: PointerEvent) => {
      if (pid.current !== null && e.pointerId === pid.current) end();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [end]);
  return (
    <div
      id="swheel"
      onPointerDown={(e) => {
        // A second finger joining mid-drag must not re-base the origin: that
        // is the wrong-way-jump bug (a stray touch shifts cx, and the next
        // move computes against the new origin) as much as it is the stuck
        // one (either finger's later lift then zeroes a still-held wheel).
        if (active.current) return;
        active.current = true;
        pid.current = e.pointerId;
        cx.current = e.clientX;
        game.setWheelPointer(e.pointerId);
        // State is already committed above, so a capture that throws (the
        // pointer can be gone by the time this runs on a fast tap) loses
        // only the drift-off-element case, never the press itself.
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {}
      }}
      onPointerMove={(e) => {
        if (!active.current || e.pointerId !== pid.current) return;
        const v = Math.max(-1, Math.min(1, (e.clientX - cx.current) / 58));
        game.setWheelVal(v);
        setRot(v * 110);
      }}
      onPointerUp={(e) => {
        if (e.pointerId === pid.current) end();
      }}
      onPointerCancel={(e) => {
        if (e.pointerId === pid.current) end();
      }}
      onLostPointerCapture={(e) => {
        if (e.pointerId === pid.current) end();
      }}
    >
      <div id="swheelInner" style={{ transform: `rotate(${rot}deg)` }}>
        ◠<br />│
      </div>
    </div>
  );
}

/* ================= touch steering slider ================= */

/* Half the painted nub's width (globals.css #sslider .ssNub is 44px — the two
   must move together — the same paint-and-code contract the wheel's hub used
   to carry). The usable half-range is
   the strip's half-width minus this, so a thumb at either end parks the nub
   flush inside the track at exactly full lock instead of poking past it. */
const SLIDER_NUB_HALF = 22;

/* The third steering mode: a wide, low-profile strip where the wheel normally
   sits. ABSOLUTE mapping — the thumb's position ON the strip is the steering
   angle (centre = straight, ends = full lock), which is the classic slider
   feel and what makes it readable at a glance: the nub is always exactly
   where your steering is. The very first touch adopts that position too, so
   a press near an end IS an immediate lock, not a new origin to drag from.

   Feeds the same wheelVal/wheelPointer channel as SteerWheel (readInput picks
   whichever of the two widgets the mode mounted), so every mobile-input
   recovery layer — clearLatchedInput on pause/blur, and the frame watchdog
   against hijacked gestures — covers this control with no new engine state.
   Pointer discipline is the wheel's, unchanged: one owning pointer id,
   a second finger neither re-bases nor releases, state committed before a
   try/caught setPointerCapture, and a window-level up/cancel fallback behind
   lostpointercapture. On release the value snaps to 0 (the engine's analog
   slew — sRate 7 in readInput — is the eased return the wheel already has)
   while the nub glides back on a CSS transition that only exists while NOT
   dragging, so letting go anywhere, pointercancel included, reads as a
   smooth re-centre rather than a teleport. */
function SteerSlider({ game }: { game: Game }) {
  const [v, setV] = useState(0);
  const [drag, setDrag] = useState(false);
  const pid = useRef<number | null>(null);
  /* px from centre to full lock, measured off the live rect on every event
     rather than cached at mount: CSS (safe-area insets, a rotation) owns the
     strip's width, and the nub render below needs the same number. */
  const half = useRef(0);
  const apply = useCallback(
    (clientX: number, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      half.current = Math.max(1, r.width / 2 - SLIDER_NUB_HALF);
      const val = Math.max(-1, Math.min(1, (clientX - (r.left + r.width / 2)) / half.current));
      game.setWheelVal(val);
      setV(val);
    },
    [game],
  );
  const end = useCallback(() => {
    pid.current = null;
    setDrag(false);
    game.setWheelVal(0);
    game.setWheelPointer(null);
    setV(0);
  }, [game]);
  /* Pausing unmounts this widget mid-drag; without zeroing here the last
     deflection keeps feeding readInput and the car resumes at hard lock.
     (clearLatchedInput also zeroes it engine-side — belt and braces, same
     as the wheel.) */
  useEffect(
    () => () => {
      game.setWheelVal(0);
      game.setWheelPointer(null);
    },
    [game],
  );
  /* Same second line of defence the wheel carries: a gesture the browser
     hijacks outright can end a touch without pointerup/pointercancel/
     lostpointercapture ever reaching #sslider, but the window still sees it
     go. Game.watchdogTouchInput() is the third line for the value itself;
     this one also brings the nub home. Losing the document (tab switch,
     app backgrounded) gets the same treatment — the engine clears its side
     on blur, and without these the nub would sit at lock on return. */
  useEffect(() => {
    const release = (e: PointerEvent) => {
      if (pid.current !== null && e.pointerId === pid.current) end();
    };
    const lost = () => {
      if (pid.current !== null) end();
    };
    const vis = () => {
      if (document.visibilityState === "hidden") lost();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", lost);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", lost);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [end]);
  const a = Math.abs(v);
  return (
    <div
      id="sslider"
      className={drag ? "drag" : undefined}
      onPointerDown={(e) => {
        // One owning pointer: a second finger (a pedal press that wandered,
        // a brushed knuckle) must neither re-base the mapping nor become the
        // finger whose lift re-centres a still-held strip.
        if (pid.current !== null) return;
        pid.current = e.pointerId;
        setDrag(true);
        game.setWheelPointer(e.pointerId);
        apply(e.clientX, e.currentTarget);
        // State is already committed above, so a capture that throws (the
        // pointer can be gone by the time this runs on a fast tap) loses
        // only the drift-off-element case, never the press itself.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {}
      }}
      onPointerMove={(e) => {
        if (e.pointerId !== pid.current) return;
        apply(e.clientX, e.currentTarget);
      }}
      onPointerUp={(e) => {
        if (e.pointerId === pid.current) end();
      }}
      onPointerCancel={(e) => {
        if (e.pointerId === pid.current) end();
      }}
      onLostPointerCapture={(e) => {
        if (e.pointerId === pid.current) end();
      }}
    >
      {/* Painted only, like the wheel's hub: every child is pointer-events:
          none so the strip itself owns every pointer that lands anywhere in
          its (deliberately taller-than-the-track) hit area. */}
      <div className="ssTrack">
        {/* centre-anchored fill, scaleX(v): negative v mirrors it left, so
            one compositor-only transform draws both directions */}
        <div
          className="ssFill"
          style={{ transform: `scaleX(${v})`, opacity: 0.2 + 0.5 * a }}
        />
        <div className="ssDetent" />
      </div>
      <div
        className="ssNub"
        style={{
          transform: `translateX(${v * half.current}px)`,
          // lights toward the accent as lock increases — the same palette
          // the drawer's state chips use, driven by |v| instead of a class
          borderColor: `rgba(140, 178, 255, ${0.3 + 0.5 * a})`,
          background: `rgba(95, 141, 255, ${0.1 + 0.3 * a})`,
          boxShadow: a > 0.02 ? `0 0 ${4 + 14 * a}px rgba(95, 141, 255, ${0.45 * a})` : "none",
        }}
      />
    </div>
  );
}

/* ================= touch overflow drawer ================= */

/* The second level of the touch control scheme: driving keeps the pucks and
   nothing else, and every remaining keyboard feature lives one tap away
   behind the ⋯ button. The game does NOT pause under it — it is a glovebox,
   not a menu — so the sheet stays narrow, hugs the top-right corner clear of
   every steering/pedal hit area, and dims nothing.

   Always mounted while playing; `open` only flips a class. Closed, the CSS
   holds it at opacity 0 with pointer-events:none, so mid-transition in
   EITHER direction it can never swallow a touch meant for the road — a
   drawer that is not fully open is already inert. Rows fire on pointerdown
   (same immediacy as the pucks) through Game.uiKeyTap, so each row is
   literally its keyboard key: same toggle body, same toast, same
   settings/persistence write.

   Not here, on purpose: camera (the CAM puck has it), high beams and horn
   (pucks — and in wheel mode the horn is also the wheel's own hub, which is
   where a driver's thumb already is), signals (the topbar telltales), music
   (MusicPlayer is
   desktop-only by design — no phone headroom), interior light (no touch
   button by design; the roof-band tap covers it), look-back (dead in the
   shipped dashcam view). */
function QuickDrawer({
  game, open, onClose,
}: {
  game: Game;
  open: boolean;
  onClose: () => void;
}) {
  const [, force] = useState(0);
  // every row is :active-only in CSS and so never lights on touch — see useTapGlow
  const tapGlow = useTapGlow();
  const tap = (k: string) => {
    game.uiKeyTap(k);
    force((n) => n + 1);
  };
  // playing implies loaded, but a guard against a not-yet-built car is free
  if (!game.car) return null;
  /* `lock: true` is a row that STAYS but cannot be tapped. A feature held
     back for the beta keeps its place in the list and says NOT AVAILABLE,
     rather than vanishing and leaving the player wondering whether the game
     has it at all. */
  const rows: { k: string; en: string; jp: string; state: string; on: boolean; lock?: boolean }[] = [
    { k: "l", en: "HEADLIGHTS", jp: "ライト", state: game.car.lightsMode.toUpperCase(),
      on: game.car.lightsMode === "on" },
    { k: "x", en: "MINIMAP", jp: "マップ", state: game.mmap ? "ON" : "OFF", on: game.mmap },
    { k: "z", en: "MAP ZOOM", jp: "ズーム", state: game.mmapZoom ? "LOOP" : "NEAR", on: game.mmapZoom },
    /* Field of view, reachable from the quick sheet (the 3 dots) and not only
       from SETTINGS. A STEPPED row, not a slider: every other row here is a tap that routes through
       uiKeyTap, i.e. it literally is a keyboard key (K), and that is what
       keeps a row and its key from ever drifting apart. The continuous
       58..100 slider is still in SETTINGS for anyone who wants an exact
       number; this cycles the four named stops in engine.ts's FOV_STOPS and
       writes the SAME `settings.fovBase` the slider does — one FOV number in
       the game, two ways to reach it.

       Here rather than at the bottom of the list because the sheet SCROLLS on
       a 390x664 phone (max-height: 100vh - 280px) — eleven rows do not fit —
       and a control that exists to be reached quickly should not be the one
       below the fold. Beside MAP ZOOM is also where it belongs: both are "how
       much of the world do I see". */
    { k: "k", en: "FIELD OF VIEW", jp: "画角", state: game.fovRow.text, on: game.fovRow.changed },
    { k: "m", en: "MIRRORS", jp: "ミラー", state: game.mirror ? "ON" : "OFF", on: game.mirror },
    /* RAIN AND WIPERS ARE HELD BACK for the beta, shown but not tappable.
       Wipers go with rain because a wiper control on dry glass is a dead
       switch. Nothing underneath is removed: setRain, the rain FX, the
       wet-road materials and every wiper mode still run, and the R and U keys
       still reach them through the same uiKeyTap route these rows used — so
       unlocking is dropping the two `lock` flags here, the settings-panel
       caption, and the profile scrub in settings.ts. */
    { k: "r", en: "RAIN", jp: "雨", state: "NOT AVAILABLE", on: false, lock: true },
    { k: "u", en: "WIPERS", jp: "ワイパー", state: "NOT AVAILABLE", on: false, lock: true },
    { k: "t", en: "TIME-LAPSE", jp: "時間", state: "×" + game.timeSpeed, on: game.timeSpeed > 0 },
    { k: "v", en: "DASHCAM FX", jp: "映像", state: game.grade ? "ON" : "OFF", on: game.grade },
  ];
  return (
    <div id="tcDrawer" className={open ? "open" : undefined}>
      <div className="qdHead">
        QUICK CONTROLS <span>クイック操作</span>
      </div>
      {rows.map((r) => (
        /* A locked row gets no pointer handler at all rather than a disabled
           one: uiKeyTap is the only way this drawer reaches the engine, so not
           wiring it is what makes the lock real, and without the handler the
           :active glow never fires either. */
        <div
          key={r.k}
          className={"qdRow" + (r.lock ? " locked" : "")}
          aria-disabled={r.lock || undefined}
          onPointerDown={r.lock ? undefined : (e) => { tapGlow(e); tap(r.k); }}
        >
          <span className="qdLabel">
            {r.en} <i>{r.jp}</i>
          </span>
          <span className={"qdState" + (r.on ? " on" : "") + (r.lock ? " na" : "")}>{r.state}</span>
        </div>
      ))}
      {/* One-shot, so it also closes the drawer: the whole point of a reset
          is to look at the road it put you back on. */}
      <div
        className="qdRow"
        onPointerDown={(e) => {
          tapGlow(e);
          tap("n");
          onClose();
        }}
      >
        <span className="qdLabel">
          RESET CAR <i>リセット</i>
        </span>
        <span className="qdState">↺</span>
      </div>
      {/* Photo mode — the touch route to the O key. One-shot like RESET: the
          screen leaves "playing", which unmounts this drawer anyway; the
          explicit onClose just keeps the session drawer-state honest. Shutter
          and exit live on the photo screen itself (PhotoHint), because this
          sheet is gone once the mode is up. */}
      <div
        className="qdRow"
        onPointerDown={(e) => {
          tapGlow(e);
          tap("o");
          onClose();
        }}
      >
        <span className="qdLabel">
          PHOTO MODE <i>フォト</i>
        </span>
        <span className="qdState">◉</span>
      </div>
    </div>
  );
}

/* ================= photo mode hint ================= */

/* The one piece of UI photo mode keeps: a corner chip naming the controls,
   plus — on touch, where there is no keyboard to name — the shutter and exit
   as real buttons. Both route through Game.uiKeyTap, the same single door the
   drawer rows use, so a tapped shutter and a pressed Space are literally the
   same code path. The container is pointer-events:none (globals.css): a drag
   that starts over the hint must still orbit the camera, only the buttons
   themselves swallow their taps. */
function PhotoHint({ game }: { game: Game }) {
  const touch = typeof window !== "undefined" && "ontouchstart" in window;
  return (
    <div id="photoHint">
      <div className="phTitle">
        PHOTO MODE <span>フォト</span>
      </div>
      <div className="phKeys">
        {touch
          ? "drag to orbit · pinch to zoom"
          : "drag to orbit · scroll to zoom · SPACE shutter · O / ESC exit"}
      </div>
      {touch && (
        <div className="phBtns">
          <button type="button" className="phBtn shutter" onPointerDown={() => game.uiKeyTap(" ")}>
            ◉ SHUTTER
          </button>
          <button type="button" className="phBtn" onPointerDown={() => game.uiKeyTap("o")}>
            ✕ EXIT
          </button>
        </div>
      )}
    </div>
  );
}

/* ================= drive stats ================= */

/* The pause menu's STATS board: this session beside the lifetime record,
   read straight off the engine's accumulator (Game.sessionStats /
   Game.lifetimeStats — see the STATS block in engine.ts). A snapshot, not a
   ticker: the game is paused under it, so nothing here needs to re-render.
   Formatting follows the profile's speed-units setting — the stored numbers
   are engine units (m, m/s, s) and only the display converts. Layout per
   Stats.dc.html: a 900-wide board, label · SESSION · LIFETIME columns, the
   session value that IS the lifetime record lit sodium. */

/* Distances on the board are the clean-run readout's own format (settings.ts)
   — one formatter, so the DISTANCE row and the CLEAN RUN row can never
   disagree about what "1.4 mi" means. */
const fmtDist = fmtRunDist;

const fmtSpeed = (v: number, u: SpeedUnits) =>
  Math.round(speedInUnits(v, u)) + " " + unitLabel(u);

function fmtDur(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

function StatsPanel({ game, onBack }: { game: Game; onBack: () => void }) {
  const s = game.sessionStats;
  const l = game.lifetimeStats();
  const u = game.settings.units;
  /* rec: the session value IS the lifetime record — the record rows light
     sodium (the one warm thing on the board) */
  const rows: { en: string; jp: string; sv: string; lv: string; rec?: boolean }[] = [
    { en: "DISTANCE", jp: "走行距離", sv: fmtDist(s.dist, u), lv: fmtDist(l.dist, u) },
    { en: "TIME DRIVEN", jp: "走行時間", sv: fmtDur(s.driveT), lv: fmtDur(l.driveT) },
    {
      en: "TOP SPEED", jp: "最高速度",
      sv: fmtSpeed(s.topSpeed, u), lv: fmtSpeed(l.topSpeed, u),
      rec: s.topSpeed > 0 && s.topSpeed >= l.topSpeed,
    },
    {
      en: "NEAR MISSES", jp: "ニアミス",
      sv: String(s.nearMisses), lv: String(l.nearMisses),
    },
    {
      /* THE SCORE. Session column = the run on screen right now (it zeroes
         when the player crashes, which is the point); lifetime = the best
         clean run ever driven on this profile. */
      en: "CLEAN RUN", jp: "無事故走行",
      sv: fmtRunDist(game.cleanRunDist, u), lv: fmtRunDist(game.cleanRunBest, u),
      rec: game.cleanRunDist > 0 && game.cleanRunDist >= game.cleanRunBest,
    },
    {
      /* Kept from the retired No Hesi loop: the streak still runs (silently)
         because a stored bestCombo is a record players already hold. */
      en: "BEST COMBO", jp: "最高コンボ",
      sv: "×" + s.bestCombo.toFixed(1), lv: "×" + l.bestCombo.toFixed(1),
      rec: s.bestCombo > 1 && s.bestCombo >= l.bestCombo,
    },
    {
      /* SURVIVAL's two persisted numbers. The bank is a LIFETIME figure
         by nature — a crash never takes any of it — so the session column is
         what this drive has earned and the lifetime column is the total.
         Never lit: it is not a record to beat, it only grows. */
      en: "MONEY", jp: "所持金",
      sv: "¥" + Math.floor(game.moneyEarned).toLocaleString("en-US"),
      lv: "¥" + Math.floor(game.money).toLocaleString("en-US"),
    },
    { en: "CRASHES", jp: "クラッシュ", sv: String(s.crashes), lv: String(l.crashes) },
    { en: "LAPS", jp: "周回", sv: String(s.laps), lv: String(l.laps) },
    { en: "TOUGE RUNS", jp: "峠走破", sv: String(s.mtnRuns), lv: String(l.mtnRuns) },
  ];
  return (
    <div className="menuRoot signRoot sub">
      {!game.loaded && <NightRoad />}
      <Gantry />
      <div className="sign-stack sub mid">
        <SignPlate hangers screen>
          <SignHead jp="記録" en="STATS" corner={<>DRIVE STATISTICS<br />SNAPSHOT · PAUSED</>} mark={<BetaMark sm />} />
          <SignRule />
          <SignBody>
            <div className="statsGrid">
              <span />
              <span className="shead">
                SESSION <span className="ui-jp" lang="ja">今回</span>
              </span>
              <span className="shead">
                LIFETIME <span className="ui-jp" lang="ja">通算</span>
              </span>
              <span className="srule" aria-hidden="true" />
              {rows.map((r) => (
                <StatsRow key={r.en} {...r} />
              ))}
            </div>
          </SignBody>
          <SignFootbar caption="orange = this session is the lifetime record">
            <SignBtn variant="ghost" back onClick={onBack}>
              BACK
            </SignBtn>
          </SignFootbar>
        </SignPlate>
      </div>
    </div>
  );
}

function StatsRow({
  en, jp, sv, lv, rec,
}: {
  en: string;
  jp: string;
  sv: string;
  lv: string;
  rec?: boolean;
}) {
  return (
    <>
      <span className={"slabel" + (rec ? " rec" : "")}>
        {en} <i lang="ja">{jp}</i>
      </span>
      <span className={"sval" + (rec ? " rec" : "")}>{sv}</span>
      <span className="sval life">{lv}</span>
    </>
  );
}

/* ================= garage ================= */

/* One card's art. Asks carpreview's render queue rather than rendering in
   its own effect: the queue shoots one card per animation frame (and puts
   the selected car first on a paint change), so five cards and their
   donor-body re-shoots can never freeze the page in one frame. The old url
   stays up until the new one lands — a card that starts empty and fills in
   a beat later is worse than one that improves. */
function CarPreview({
  carId, paintHex, first, children,
}: {
  carId: string;
  paintHex: number;
  first?: boolean;
  children?: React.ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  /* game/carpreview.ts is three.js plus the whole player-car builder. Imported
     here rather than at the top of this file so it cannot weld either into the
     chunk the main menu is parsed from — by the time a card mounts, the engine
     chunk has landed and every module this needs is already in memory. */
  useEffect(() => {
    let live = true;
    let cancel: (() => void) | null = null;
    void import("@/game/carpreview").then(({ requestCarPreview }) => {
      if (!live) return;
      cancel = requestCarPreview(carId, paintHex, (u) => setUrl(u), first);
    });
    return () => {
      live = false;
      cancel?.();
    };
    // `first` is only a queue-order hint for the render this effect starts;
    // a change in which card is selected must not re-render every card
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carId, paintHex]);
  return (
    <div className="carImg">
      {url && <img src={url} alt="" draggable={false} />}
      {children}
    </div>
  );
}

const STAT_LABELS = [
  ["speed", "speed"],
  ["accel", "accel"],
  ["grip", "grip"],
  ["agility", "handling"],
] as const;

function GaragePanel({ game, onBack }: { game: Game; onBack: () => void }) {
  /* Resolved through getCar rather than taken raw: an engine still carrying a
     locked id from an old profile would otherwise light up a COMING SOON card
     as the current selection. */
  const [carId, setCarId] = useState(() => getCar(game.carId).id);
  const [paintIx, setPaintIx] = useState(game.paintIx);
  const sel = (id: string, pi: number) => {
    // sel() is the single door to game.setCar (see the locked-card note
    // below), so a diff here sees every real change and nothing twice
    if (id !== carId) track("garage_car", { car: id });
    if (pi !== paintIx) {
      const p = PAINTS[pi % PAINTS.length];
      track("garage_paint", {
        paint: p.name,
        finish: p.finish,
        hex: "#" + p.hex.toString(16).padStart(6, "0"),
        car: id,
      });
    }
    setCarId(id);
    setPaintIx(pi);
    game.setCar(id, pi);
  };
  const paint = PAINTS[paintIx % PAINTS.length];
  const nPlayable = CARS.filter((c) => !c.comingSoon).length;
  const nSoon = CARS.length - nPlayable;
  return (
    <div className="menuRoot signRoot sub">
      {!game.loaded && <NightRoad />}
      <Gantry />
      <div className="sign-stack sub">
        <SignPlate hangers screen>
          <SignHead
            jp="車庫"
            en="GARAGE"
            glyph={<SignP big />}
            corner={<>PICK YOUR MACHINE<br />{nPlayable} DRIVEABLE · {nSoon} COMING SOON</>}
            mark={<BetaMark sm />}
          />
          <SignRule />
          <SignBody>
            {/* the cars as parking bays (Garage.dc.html): white-bordered cards,
                the selected one on the sodium lane-edge rule */}
            <div className="sign-garage" role="radiogroup" aria-label="Car">
              {CARS.map((c) => {
                /* A locked car keeps its whole card — the live-rendered shot, the
                   name, the blurb, the bars — and loses only the ability to be
                   picked. sel() is the sole route to game.setCar(), so dropping
                   the handler is the whole lock; the dimming is just how it reads.
                   The stat bars stay because they are what the card is teasing,
                   and because a card without them would sit at a different
                   height and break the row it shares with the playable cars. */
                const locked = !!c.comingSoon;
                const on = !locked && carId === c.id;
                return (
                  <div
                    key={c.id}
                    className={"carCard" + (locked ? " locked" : on ? " sel" : "")}
                    role="radio"
                    aria-checked={on}
                    aria-disabled={locked || undefined}
                    tabIndex={locked ? -1 : 0}
                    onClick={locked ? undefined : () => sel(c.id, paintIx)}
                    onKeyDown={
                      locked
                        ? undefined
                        : (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              sel(c.id, paintIx);
                            }
                          }
                    }
                  >
                    <CarPreview carId={c.id} paintHex={paint.hex} first={on}>
                      {locked && <span className="soonBadge">COMING SOON</span>}
                      {on && <span className="sign-chip on carChip">SELECTED</span>}
                    </CarPreview>
                    <h3>
                      {c.name} <span className="jp" lang="ja">{c.jp}</span>
                    </h3>
                    <div className="carJp">{c.blurb}</div>
                    <div className="stats">
                      {STAT_LABELS.map(([label, key]) => (
                        <div className="statRow" key={label}>
                          <span>{label}</span>
                          <div className="statBar"><i style={{ width: `${c.stats[key] * 100}%` }} /></div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* PAINT. The swatches repaint BOTH bodies: the procedural shell
                through the rig rebuild (engine.ts setCar), and the imported Volvo
                exterior through player.ts tintDonorPaint, which writes the chosen
                colour onto the donor's Car_Paint material when the GLB lands — the
                garage card's real-bodywork shot and the chase cameras agree with
                the swatch. The caption names the selection because eight anonymous
                squares is a colour test, not a menu — and the finish word is what
                tells you why two similar swatches drive differently at night. */}
            <div className="sign-paint-rule" aria-hidden="true" />
            <div className="sign-paint">
              <div className="sign-titles" aria-hidden="true">
                <div className="sign-title-jp" lang="ja">塗装</div>
                <div className="sign-title">PAINT</div>
              </div>
              <div className="paintRow" role="radiogroup" aria-label="Paint">
                {PAINTS.map((p, i) => (
                  <button
                    key={p.name}
                    type="button"
                    role="radio"
                    aria-checked={i === paintIx}
                    aria-label={p.name}
                    className={"paintDot" + (i === paintIx ? " sel" : "")}
                    title={p.name}
                    style={{ background: "#" + p.hex.toString(16).padStart(6, "0") }}
                    onClick={() => sel(carId, i)}
                  />
                ))}
              </div>
              <div className="paintName">
                {paint.name}
                <i>{paint.finish}</i>
              </div>
              <div className="sign-cap faint sign-paintnote">
                repaints both bodies — the procedural shell
                <br />
                and the imported Volvo exterior
              </div>
            </div>
          </SignBody>
          <SignFootbar caption="car art is the live studio shot of each car in the chosen paint">
            <SignBtn onClick={onBack}>DONE</SignBtn>
          </SignFootbar>
        </SignPlate>
      </div>
    </div>
  );
}

/* ================= settings ================= */

/* Three columns per Settings.dc.html — GRAPHICS · DRIVING · WORLD & WEATHER
   (+ SESSION) — every row of the old panel on the sign's own controls
   (Sign.tsx: SignToggle / SignSeg / SignSelect / SignSlider), each with a
   real input underneath. The row whose value changed last lights the sodium
   lane-edge rule, so the one warm thing on the board is the thing you just
   touched. */
function SettingsPanel({
  game, onBack, onReseed, onApplyReload,
}: {
  game: Game;
  onBack: () => void;
  onReseed: () => void;
  /** persist the profile, then reload — for a setting the engine can only
      read at construction (device tier). */
  onApplyReload: () => void;
}) {
  const [, force] = useState(0);
  const [lit, setLit] = useState<string | null>(null);
  /* ADVANCED is collapsed on arrival and expands IN PLACE: the public set
     stays where it is and dims rather than scrolling away, so opening the
     section never costs you your place on the screen. */
  const [adv, setAdv] = useState(false);
  const advRef = useRef<HTMLDivElement>(null);
  const upd = (fn: (s: GameSettings) => void) => {
    /* analytics: shallow snapshot for the key diff below — every row funnels
       through upd(), so instrumenting here covers the whole panel and any
       row added later, with no per-row wiring to forget. */
    const before: Record<string, unknown> = { ...game.settings };
    fn(game.settings);
    game.applySettings(game.settings);
    // one call covers every row, so a new rival toggle can never be wired up
    // and then forgotten here
    syncRivalMode(game.settings);
    syncCabinMode(game.settings);
    const after = game.settings as unknown as Record<string, unknown>;
    let changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    // a preset flip rewrites its derived keys too; the choice was the preset
    if (changed.includes("preset")) changed = ["preset"];
    for (const k of changed) {
      const v = after[k] as string | number | boolean;
      if (k === "steerMode") {
        // its own curated event: which steering scheme mobile players pick
        // is a top-level question, not a generic settings row
        track("mobile_steer_mode", { mode: String(v), device: deviceType() });
      } else {
        /* debounced per key: range sliders fire onChange on every tick of a
           drag, and the value worth keeping is the one it settles on */
        trackDebounced("settings_change:" + k, "settings_change", {
          setting: k,
          value: v,
          previous: before[k] as string | number | boolean,
        });
      }
    }
    if (changed.length) setLit(changed[0]);
    force((n) => n + 1);
  };
  const s = game.settings;
  const L = (k: string) => lit === k;
  return (
    <div className="menuRoot signRoot sub">
      {!game.loaded && <NightRoad />}
      <Gantry />
      <div className="sign-stack sub">
        <SignPlate hangers screen>
          <SignHead
            jp="設定"
            en="SETTINGS"
            corner={<>CHANGES APPLY LIVE</>}
            mark={<BetaMark sm />}
          />
          <SignRule />
          <SignBody>
            {/* THE PUBLIC SET — the twelve rows a first-time player sees (plus
                touch steering, which the touch lane owns). Everything niche is
                one tap away in ADVANCED below; the three developer rows only
                exist behind lib/build.ts's SHOW_DEV_SETTINGS; and reflections /
                bloom / day shadows / FXAA are no longer rows at all, because
                applyPresetDefaults and the device tier already decide all four
                and a second control could only fight them. */}
            <div className={adv ? "sign-cols dim" : "sign-cols"}>
              <div>
                <SignShead en="DRIVING" jp="運転" />
                <SignSrow name="Traction control" lit={L("tc")}>
                  <SignToggle label="Traction control" checked={s.tc} onChange={(v) => upd((x) => (x.tc = v))} />
                </SignSrow>
                {/* THE RIVAL IS LOCKED OFF for the beta, the same way rain is:
                    the row keeps its place so the section still reads the same,
                    but it is a static NOT AVAILABLE caption instead of a switch.
                    The car itself is untouched in game/traffic.ts — it claims
                    its pool slot on the toggle rather than at construction, so
                    off costs nothing. Unlocking is putting this SignToggle
                    back, restoring the home-board shortcut and the loading
                    board's row, and dropping the scrub in settings.ts. */}
                <SignSrow name="Rival car">
                  <span className="sign-cap faint">NOT AVAILABLE</span>
                </SignSrow>
                {/* SURVIVAL used to have a toggle here, mirroring the home
                    board's ENDLESS switch. Both are gone: the mode is chosen
                    by which row on the board you press, so a preference that
                    sits here between runs would be a second, silent answer to
                    a question the press already asks. The score panel, the
                    reset and the pinned traffic all follow that press.

                    Nothing is lost from this screen — SETTINGS is where you
                    change how the game behaves, and survival is not a way the
                    game behaves any more, it is a drive you start. */}
                {/* The clean-run readout: distance since the last real impact
                    (game/engine.ts's runUpdate). On by default. */}
                <SignSrow name="Clean run" aside="— distance since your last crash" lit={L("cleanRunScore")}>
                  <SignToggle label="Clean run" checked={s.cleanRunScore} onChange={(v) => upd((x) => (x.cleanRunScore = v))} />
                </SignSrow>
                <SignSrow name="Speed units" lit={L("units")}>
                  <SignSeg
                    label="Speed units"
                    value={s.units}
                    options={[{ v: "mph", t: "MPH" }, { v: "kmh", t: "KM/H" }]}
                    onChange={(v) => upd((x) => (x.units = v as SpeedUnits))}
                  />
                </SignSrow>
                {/* Phone control, kept on every device because the touch-controls
                    lane owns whether it should hide itself on a mouse. */}
                <SignSrow name="Touch steering" lit={L("steerMode")}>
                  <SignSelect
                    aria-label="Touch steering"
                    value={s.steerMode}
                    onChange={(e) =>
                      upd((x) => {
                        x.steerMode = e.target.value as any;
                        if (x.steerMode === "tilt") game.hookTilt();
                      })
                    }
                  >
                    <option value="buttons">Buttons</option>
                    <option value="wheel">Touch wheel</option>
                    <option value="slider">Swipe slider</option>
                    {/* TILT locked for the beta — see settings.ts */}
                  </SignSelect>
                </SignSrow>
                {/* SURVIVAL pins this — see SURVIVAL_TRAFFIC. A caption
                    rather than a disabled slider: a control that does not move
                    is worse than no control, and the row still has to say what
                    the traffic IS, because the player can see it out of the
                    windscreen and would otherwise think the setting broke. */}
                {s.endless ? (
                  <SignSrow stack last name="Traffic density">
                    <span className="sign-cap faint">
                      {Math.round(SURVIVAL_TRAFFIC * 100)}% &middot; FIXED IN SURVIVAL
                    </span>
                  </SignSrow>
                ) : (
                  <SignSrow stack last name="Traffic density" lit={L("traffic")}>
                    <SignSlider
                      label="Traffic density"
                      min={20} max={100} value={Math.round(s.traffic * 100)}
                      text={`${Math.round(s.traffic * 100)}%`}
                      onChange={(v) => upd((x) => (x.traffic = v / 100))}
                    />
                  </SignSrow>
                )}
              </div>
              <div>
                <SignShead en="WORLD" jp="天候" />
                <SignSrow stack name="Time of day" lit={L("time")}>
                  <SignSlider
                    label="Time of day"
                    min={0} max={24} step={0.25} value={game.time}
                    text={fmtTime(game.time)}
                    onChange={(v) => {
                      game.time = v;
                      setLit("time");
                      force((n) => n + 1);
                    }}
                  />
                </SignSrow>
                <SignSrow name="Day/night cycle" lit={L("autoTime")}>
                  <SignToggle label="Day/night cycle" checked={s.autoTime} onChange={(v) => upd((x) => (x.autoTime = v))} />
                </SignSrow>
                {/* RAIN IS LOCKED for the beta — see the migration note in
                    settings.ts. The row stays so WORLD still reads as weather,
                    but it is a static NOT AVAILABLE caption in the panel's own
                    faint style instead of a switch. Putting this SignToggle
                    back (with the two QuickDrawer rows) is the whole of
                    unlocking it. */}
                <SignSrow last name="Rain">
                  <span className="sign-cap faint">NOT AVAILABLE</span>
                </SignSrow>
                <SignShead en="SOUND" jp="音" />
                <SignSrow stack last name="Volume" lit={L("vol")}>
                  <SignSlider
                    label="Volume"
                    min={0} max={100} value={Math.round(s.vol * 100)}
                    text={`${Math.round(s.vol * 100)}%`}
                    onChange={(v) => upd((x) => (x.vol = v / 100))}
                  />
                </SignSrow>
              </div>
              <div>
                <SignShead en="PICTURE" jp="画質" />
                {/* The one quality control. It writes reflections, bloom, day
                    shadows, FXAA and motion blur itself (applyPresetDefaults),
                    and TIER_CAPS caps what the device can actually do — which
                    is why none of those is a row of its own any more. */}
                <SignSrow name="Graphics quality" lit={L("preset")}>
                  <SignSeg
                    label="Graphics quality"
                    value={s.preset}
                    options={[{ v: "low", t: "LOW" }, { v: "medium", t: "MEDIUM" }, { v: "high", t: "HIGH" }]}
                    onChange={(v) => upd((x) => applyPresetDefaults(x, v))}
                  />
                </SignSrow>
                {/* DEVICE TIER — the second quality axis, and the one detection
                    gets wrong. Graphics quality above is what you WANT; this is
                    what the machine is allowed to attempt (TIER_CAPS), and the
                    preset is capped by it. Auto is right for almost everyone,
                    so it leads and says what it detected.

                    IT RELOADS, and the row says so, because renderTier is
                    resolved once in the engine constructor and decides which
                    donor assets are even fetched (donorAssetUrls) — there is no
                    honest way to change it mid-drive. Same contract as NEW TOWN
                    below: write the profile, then location.reload().

                    Was developer-only behind SHOW_DEV_SETTINGS at both ends;
                    it is a player setting now, so a laptop or phone that
                    detects wrong can be pinned to the right tier by hand. */}
                <SignSrow stack name="Device tier" aside={s.tierOverride === "auto" ? `— detected "${game.renderTier}" \u00b7 reloads` : `— running "${game.renderTier}" \u00b7 reloads`} lit={L("tierOverride")}>
                  <SignSelect
                    aria-label="Device tier"
                    value={s.tierOverride}
                    onChange={(e) => {
                      const v = e.target.value as GameSettings["tierOverride"];
                      if (v === s.tierOverride) return;
                      upd((x) => (x.tierOverride = v));
                      /* THROUGH THE PARENT, because the panel's own upd() does
                         NOT persist — the profile is written when the screen is
                         left. Reloading straight from here would have thrown
                         the choice away on the way out, which is the one thing
                         a reloading setting must not do. onApplyReload does
                         persist() then location.reload(), exactly like NEW
                         TOWN. */
                      onApplyReload();
                    }}
                  >
                    <option value="auto">Auto &mdash; detect this device</option>
                    <option value="mobile-base">Mobile base &mdash; fewest effects</option>
                    <option value="mobile-high">Mobile high</option>
                    <option value="desktop">Desktop &mdash; everything</option>
                  </SignSelect>
                </SignSrow>
                <SignSrow stack name="Field of view" lit={L("fovBase")}>
                  <SignSlider
                    label="Field of view"
                    min={58} max={100} value={s.fovBase}
                    text={`${s.fovBase}°`}
                    onChange={(v) => upd((x) => (x.fovBase = v))}
                  />
                </SignSrow>
                {/* THE DASHCAM FILTER IS LOCKED OFF for the beta, the same way
                    rain and the rival are: the row keeps its place so the
                    section still reads the same, but it is a static NOT
                    AVAILABLE caption instead of a switch. game.grade, the
                    grade pass in post and the V key are all untouched, and
                    game/settings.ts scrubs a stored `true` so nobody is left
                    wearing the filter with no control to remove it. Unlocking
                    is putting this SignToggle back and dropping that line. */}
                <SignSrow last name="Dashcam filter">
                  <span className="sign-cap faint">NOT AVAILABLE</span>
                </SignSrow>
                {/* DEVELOPER — not in a public build (lib/build.ts). Both rows
                    here are testing levers, and each one RESOLVES to its auto
                    answer while this group is hidden (game/settings.ts
                    resolveRenderTier / syncCabinMode), so a value set in dev
                    can never strand a player in a state with no control for
                    it. Nothing is written back: ?debug=1 shows both exactly as
                    they were left. (A third row, test mode, lived here until
                    its spec became the only car — see carspecs.ts.) */}
                {SHOW_DEV_SETTINGS && (
                  <>
                    <SignShead en="DEVELOPER" jp="開発" />
                    {/* Device tier moved to PICTURE as a player row — it is a
                        real setting now, not a debug affordance, and two copies
                        of one control is how they drift apart. */}
                    <SignSrow last name="Imported cabin" aside={`— auto is "${cabinAutoLabel(game.renderTier)}"`} lit={L("cabin")}>
                      <SignSelect
                        aria-label="Imported cabin"
                        value={s.cabin}
                        onChange={(e) =>
                          upd((x) => {
                            x.cabin = e.target.value as any;
                            syncCabinMode(x);
                            game.setCar(game.carId, game.paintIx);
                          })
                        }
                      >
                        <option value="auto">Auto</option>
                        <option value="donor">Real cabin (heavy)</option>
                        <option value="procedural">Procedural</option>
                      </SignSelect>
                    </SignSrow>
                  </>
                )}
              </div>
            </div>
            {/* ADVANCED — real settings, one tap away rather than in the way. */}
            <div className={adv ? "sign-adv open" : "sign-adv"} ref={advRef}>
              <button
                type="button"
                className="sign-adv-head"
                aria-expanded={adv}
                onClick={() => {
                  const open = !adv;
                  setAdv(open);
                  track("settings_advanced", { open });
                  /* On a phone the seven rows open BELOW the fold, so without
                     this the tap reads as "everything dimmed and nothing
                     happened". `nearest` is a no-op wherever the section is
                     already fully visible, which is every desktop layout. */
                  if (open) {
                    requestAnimationFrame(() =>
                      advRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
                    );
                  }
                }}
              >
                <span className="sign-adv-caret" aria-hidden="true" />
                <span className="sign-adv-title">
                  ADVANCED <span className="ui-jp" lang="ja">詳細</span>
                </span>
                <span className="sign-cap faint sign-adv-note">
                  {adv
                    ? "niche but real — nothing here changes what the game is"
                    : "draw distance · fog · motion blur · rival indicators · first-run hints · new town · reset"}
                </span>
              </button>
              {adv && (
                <div className="sign-cols">
                  <div>
                    <SignSrow stack name="Draw distance" lit={L("drawDist")}>
                      <SignSlider
                        label="Draw distance"
                        min={350} max={1100} step={50} value={s.drawDist}
                        text={`${s.drawDist} m`}
                        onChange={(v) => upd((x) => (x.drawDist = v))}
                      />
                    </SignSrow>
                    <SignSrow last name="Motion blur" lit={L("mblur")}>
                      <SignToggle label="Motion blur" checked={s.mblur} onChange={(v) => upd((x) => (x.mblur = v))} />
                    </SignSrow>
                  </div>
                  <div>
                    <SignSrow name="Fog / haze" lit={L("fog")}>
                      <SignSeg
                        label="Fog / haze"
                        value={s.fog}
                        options={[{ v: "off", t: "OFF" }, { v: "light", t: "LIGHT" }, { v: "medium", t: "MED" }, { v: "heavy", t: "HEAVY" }]}
                        onChange={(v) => upd((x) => (x.fog = v as GameSettings["fog"]))}
                      />
                    </SignSrow>
                    {/* Held back with the rival itself — it is only ever read
                        while a rival is running. Kept rather than deleted, on
                        the same instruction as the RIVAL row on the home board
                        ("dont remove it just say not available"). */}
                    <SignSrow last name="Rival indicators" aside="— the rival signals its lane changes">
                      <span className="sign-cap faint">NOT AVAILABLE</span>
                    </SignSrow>
                  </div>
                  <div>
                    {/* Gates game/hints.ts wholesale. Which tips have already fired is
                        stored separately from the settings (see settings.ts), so DEFAULTS
                        re-enabling this does not replay them. */}
                    <SignSrow name="First-run hints" aside="— one-time tips" lit={L("hints")}>
                      <SignToggle label="First-run hints" checked={s.hints} onChange={(v) => upd((x) => (x.hints = v))} />
                    </SignSrow>
                    <SignSrow name="New town" aside={`— seed ${game.seed} · reloads`}>
                      <SignBtn sm onClick={onReseed}>
                        NEW TOWN
                      </SignBtn>
                    </SignSrow>
                    <SignSrow last name="Reset everything">
                      <SignBtn
                        sm
                        variant="ghost"
                        onClick={() => {
                          Object.assign(game.settings, defaultSettings());
                          game.applySettings(game.settings);
                          /* Every other write to settings goes through upd(), which calls
                             this; DEFAULTS assigns straight onto game.settings and so
                             skipped it. applySettings does not cover the rival — it is
                             driven separately — so resetting left the rival in whatever
                             state it was in while the panel claimed it was back to
                             default. */
                          syncRivalMode(game.settings);
                          syncCabinMode(game.settings);
                          // one event, not a diff of every key the reset touched
                          track("settings_change", { setting: "reset_defaults", value: true });
                          setLit(null);
                          force((n) => n + 1);
                        }}
                      >
                        DEFAULTS
                      </SignBtn>
                    </SignSrow>
                  </div>
                </div>
              )}
            </div>
          </SignBody>
          <SignFootbar caption="changes apply live · the orange row is the one you just changed">
            <SignBtn onClick={onBack}>DONE</SignBtn>
          </SignFootbar>
        </SignPlate>
      </div>
    </div>
  );
}

function fmtTime(t: number) {
  const hh = t | 0;
  let mm = Math.round((t - hh) * 60);
  if (mm === 60) mm = 0;
  return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
}

/* ================= controls ================= */

/* Audited against engine.ts (onKeyDown/onKeyUp/readInput, bindInput,
   onPointerDown, gamepad.ts) — every binding listed here exists there, and
   everything bound there is listed. Keep the two in step when adding a key.
   Split into two columns per Controls.dc.html; the third column carries
   touch and gamepad and the green EXIT board the old note talked about. */
const KEYS_A: [string, string][] = [
  ["W / S · ↑ / ↓", "throttle · brake & reverse"],
  ["A / D · ← / →", "steer"],
  ["SPACE", "handbrake (drift)"],
  ["C", "camera: chase → cockpit → hood → console → backseat → dashcam"],
  ["B", "look back (chase & cockpit)"],
  ["Q / E", "turn signals"],
  ["F", "horn (traffic speeds up)"],
  ["L", "headlights: auto / on / off"],
  ["G", "high beams: tap to flash, hold 2s to latch on / off"],
  ["M", "cockpit mirrors"],
  ["R", "rain"],
  ["U", "wipers: off / int / lo / hi (rain auto-starts lo; also clickable beside the head unit)"],
  ["T", "time-lapse: ×150 → ×1500 → off"],
  ["V", "dashcam grade (the DASHCAM view forces its own, harder)"],
  ["K", "field of view: narrow 58° → normal 67° → wide 80° → ultra 100° (settings has the full slider)"],
];
const KEYS_B: [string, string][] = [
  ["X", "minimap"],
  ["Z", "map zoom: close-up ↔ whole loop (or click the map)"],
  ["N", "reset to nearest road"],
  ["O", "photo mode: orbit the car, Space captures a PNG"],
  ["I", "interior light — desktop only (off by default; the cabin is meant to be dark)"],
  ["P", "in-dash music: play / pause — desktop only"],
  [", / .", "previous / next piece"],
  ["ESC", "pause menu (music pauses with it)"],
];
const KEYS_MOUSE: [string, string][] = [
  ["DASH SCREEN", "click to switch panes — map / music / trip (desktop)"],
  ["ROOF CONSOLE", "click the overhead panel — interior light"],
];
const KEYS_TOUCH: [string, string][] = [
  ["PUCKS", "steer · pedals · CAM · LTS (high beams) · HORN"],
  ["⋯", "quick controls drawer: lights, map, mirrors, rain, wipers, time-lapse, field of view, dashcam FX, reset, photo mode"],
  ["TOP EDGE", "tap the middle — interior light"],
  ["STEERING", "buttons / touch wheel / swipe slider — pick in settings"],
];
const KEYS_PAD: [string, string][] = [
  ["STICKS", "left stick steers · RT throttle · LT brake"],
  ["BUTTONS", "A handbrake · B horn · Y lights · RB or D-pad up camera"],
];

function KeyList({ rows }: { rows: [string, string][] }) {
  return (
    <div className="sign-keys">
      {rows.map(([k, d]) => (
        <Fragment key={k}>
          <span className="sign-chip">{k}</span>
          <span>{d}</span>
        </Fragment>
      ))}
    </div>
  );
}

function ControlsScreen({
  loaded, onBack, onCredits,
}: {
  loaded: boolean;
  onBack: () => void;
  onCredits: () => void;
}) {
  return (
    <div className="menuRoot signRoot sub">
      {!loaded && <NightRoad />}
      <Gantry />
      <div className="sign-stack sub">
        <SignPlate hangers screen>
          <SignHead jp="操作方法" en="CONTROLS" corner={<>H TOGGLES THIS SCREEN<br />IN-GAME</>} mark={<BetaMark sm />} />
          <SignRule />
          <SignBody>
            <div className="sign-cols ctrl">
              <div>
                <SignShead en="KEYBOARD" jp="キーボード" />
                <KeyList rows={KEYS_A} />
              </div>
              <div>
                <SignShead en="KEYBOARD" jp="続き" />
                <KeyList rows={KEYS_B} />
                <SignShead en="MOUSE · IN THE CABIN" />
                <KeyList rows={KEYS_MOUSE} />
              </div>
              <div>
                <SignShead en="TOUCH" jp="触れる" />
                <KeyList rows={KEYS_TOUCH} />
                <SignShead en="GAMEPAD" />
                <KeyList rows={KEYS_PAD} />
                <div className="sign-exitboard">
                  <div className="sign-sheet" aria-hidden="true" />
                  <div className="sign-exitboard-head">
                    <span className="sign-arrow" aria-hidden="true">
                      <SignArrow dir="ne" />
                    </span>
                    <div>
                      <div className="sign-exitboard-title">
                        EXIT 4 <span className="ui-jp" lang="ja">峠</span>
                      </div>
                      <span className="sign-cap">MOUNTAIN ROAD · ONE-WAY</span>
                    </div>
                  </div>
                  <p>
                    Follow the green EXIT boards on the expressway — each numbered exit has a
                    lit off-ramp down into the town on both sides, and EXIT 4 leads onto the
                    one-way mountain road — a single lane, one direction, with a turnout
                    where slower cars let you by. Crashed cars keep their hazards on, smoke, and get
                    towed away shortly.
                  </p>
                </div>
              </div>
            </div>
          </SignBody>
          <SignFootbar caption="every key, tap and button the game listens for">
            <SignBtn variant="ghost" onClick={onCredits}>
              CREDITS
            </SignBtn>
            <SignBtn variant="ghost" back onClick={onBack}>
              BACK
            </SignBtn>
          </SignFootbar>
        </SignPlate>
      </div>
    </div>
  );
}

/* ================= credits ================= */

/* The CC-BY attributions from ATTRIBUTIONS.md (the assets that ship and
   require credit), the typefaces, and the privacy plate. Keep this list in
   step with ATTRIBUTIONS.md when an asset changes hands. */
const CREDITS: { what: string; use: string; who: string; host: string; href: string; lic: string }[] = [
  {
    what: "Orchids Simulator Traffic Car Pack",
    use: "NPC traffic bodyshells — sedan, hybrid, compact, SUV, taxi, police, van, truck",
    who: "SphereBall20 (@playmode280513)",
    host: "sketchfab.com",
    href: "https://sketchfab.com/3d-models/orchids-simulator-traffic-car-pack-2fc5970d5ba2415fa98ec98b8801e794",
    lic: "CC BY 4.0",
  },
  {
    what: "Generic civil service vehicles pack",
    use: "NPC traffic — the bus",
    who: "comrade1280",
    host: "sketchfab.com",
    href: "https://sketchfab.com/3d-models/8ff2a13f30914932a70c7950cfa58465",
    lic: "CC BY 4.0",
  },
  {
    what: "Volvo S90 Recharge (Free)",
    use: "the player car — cockpit interior and exterior body",
    who: "lazercar",
    host: "sketchfab.com",
    href: "https://sketchfab.com/3d-models/volvo-s90-recharge-free-9462b07c10244fd4a28d86846dc9e3a9",
    lic: "CC BY 4.0",
  },
  {
    what: "Car Tire Skid Squealing",
    use: "tyre squeal (downmixed to mono, peak-normalised)",
    who: "qubodup",
    host: "opengameart.org",
    href: "https://opengameart.org/content/car-tire-skid-squealing",
    lic: "CC BY 3.0",
  },
];
const TYPE_CREDITS: { what: string; use: string; who: string; lic: string }[] = [
  { what: "Overpass", use: "the sign's Latin face", who: "Delve Withrington, Delve Fonts", lic: "OFL 1.1" },
  { what: "Zen Kaku Gothic New", use: "the sign's Japanese face", who: "Yoshimichi Ohira", lic: "OFL 1.1" },
  { what: "Space Grotesk", use: "HUD numerals", who: "Florian Karsten", lic: "OFL 1.1" },
  { what: "three.js · Next.js · React", use: "engine and app", who: "their contributors", lic: "MIT" },
];

function CreditsScreen({ loaded, onBack }: { loaded: boolean; onBack: () => void }) {
  return (
    <div className="menuRoot signRoot sub">
      {!loaded && <NightRoad />}
      <Gantry />
      <div className="sign-stack sub mid">
        <SignPlate hangers screen>
          <SignHead
            jp="クレジット"
            en="CREDITS"
            corner={<>{NAME_VERSION}<br />ATTRIBUTIONS · PRIVACY</>}
            mark={<BetaMark sm />}
          />
          <SignRule />
          <SignBody>
            <SignShead en="THIRD-PARTY ASSETS" jp="素材" />
            <div className="sign-credits">
              {CREDITS.map((c) => (
                <div className="sign-credit" key={c.what}>
                  <div className="what">
                    {c.what}
                    <small>{c.use}</small>
                  </div>
                  <div className="who">
                    {c.who} ·{" "}
                    <a href={c.href} target="_blank" rel="noreferrer">
                      {c.host}
                    </a>
                  </div>
                  <span className="sign-chip">{c.lic}</span>
                </div>
              ))}
            </div>
            <SignShead en="TYPE & CODE" jp="書体" />
            <div className="sign-credits">
              {TYPE_CREDITS.map((c) => (
                <div className="sign-credit" key={c.what}>
                  <div className="what">
                    {c.what}
                    <small>{c.use}</small>
                  </div>
                  <div className="who">{c.who}</div>
                  <span className="sign-chip">{c.lic}</span>
                </div>
              ))}
            </div>
            <SignShead en="PRIVACY" jp="プライバシー" />
            {/* mirrors lib/analytics.ts: anonymous PostHog product analytics,
                session replay with inputs masked, canvas replay on desktop
                only, respect_dnt, and the ?owner= opt-out flag. KEEP THIS
                PLATE IN STEP with session_recording.sampleRate and
                captureCanvas — it is what a player is TOLD is
                being recorded, so a stale figure here is a false privacy
                notice rather than a stale comment. It said "about one session
                in four" while the rate was 0.25; the rate is 1.0 now. */}
            <div className="sign-plate inboard">
              <b>ANONYMOUS ANALYTICS</b>
              The game sends anonymous product analytics to PostHog — which screens get opened, which
              settings get changed, how long a drive lasts — and records a session replay (with every
              input masked; on desktop the replay includes the game screen itself). There are no accounts, no sign-in, and no
              email or name is ever attached. A browser&apos;s Do Not Track setting is respected. To opt
              out on this device open the game once with <code>?owner=1</code> in the address; <code>?owner=0</code>{" "}
              turns it back on.
            </div>
          </SignBody>
          <SignFootbar keep caption={<>every asset&apos;s provenance is in ATTRIBUTIONS.md · <span className="sign-ver">{VERSION_LABEL}</span></>}>
            <a className="sign-btn ghost sm" href={BUG_MAILTO}>REPORT A BUG</a>
            <SignBtn variant="ghost" back onClick={onBack}>
              BACK
            </SignBtn>
          </SignFootbar>
        </SignPlate>
      </div>
    </div>
  );
}
