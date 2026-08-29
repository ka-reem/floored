"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Game, WIPER_MODE_NAMES } from "@/game/engine";
import { HINT_SHOW_MS, type HintMsg } from "@/game/hints";
import type { LoadReport } from "@/game/loading";
import { CARS, DEFAULT_CAR_ID, PAINTS, getCar } from "@/game/carspecs";
import { carPreviewURL } from "@/game/carpreview";
import {
  loadProfile, saveProfile, defaultSettings, applyPresetDefaults, unitLabel,
  speedInUnits, syncRivalMode, syncCabinMode, cabinAutoLabel,
  type Profile, type GameSettings, type SpeedUnits,
} from "@/game/settings";

type Screen = "main" | "garage" | "settings" | "controls" | "stats" | "loading" | "playing" | "paused" | "photo";

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

  /* create engine once */
  useEffect(() => {
    if (gameRef.current || !hostRef.current) return;
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
    const game = new Game(hostRef.current, profile, {
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
    rerender();
    return () => {
      game.destroy();
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
    p.noHesiBest = g.noHesiBest;
    /* Lifetime totals: construction-time seed + this session, recomputed on
       every call (see Game.lifetimeStats) — writing it repeatedly is safe. */
    p.stats = g.lifetimeStats();
    p.ttt = g.tttTally;
    saveProfile(p);
  }, []);

  /* DRIVE. The world does not exist until this runs — the engine constructor
     only sets up a canvas and the settings the menus read (see Game.load) —
     so the first press pays for the whole build behind the loading screen.
     A second press (after MAIN MENU from the pause screen) is instant. */
  const drive = useCallback(async () => {
    const g = gameRef.current;
    if (!g) return;
    /* Before anything asynchronous: iOS only unlocks an AudioContext created
       inside the gesture itself, and every line below this one is a task or
       more removed from the tap. */
    g.primeAudio();
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
    persist();
  }, [persist]);
  const resume = () => {
    gameRef.current?.setRunning(true);
    setScreen("playing");
    persist();
  };
  const backToMenu = () => {
    setFromPause(false);
    setScreen("main");
    /* Leaving for the menu is how a drive ends — bank it. resume() and
       drive() already persist; this was the one exit that didn't, and it is
       the natural end of a session for the lifetime stats (and noHesiBest). */
    persist();
  };
  const backFrom = (sub: boolean) => {
    if (fromPause && sub) setScreen("paused");
    else setScreen("main");
  };

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

  return (
    <>
      <div ref={hostRef} />
      {/* HUD */}
      <div id="topbar" style={{ display: playing ? "flex" : "none" }}>
        {/* Passive telltales only: the tap-to-signal behavior these glyphs
            briefly carried was removed at the owner's request — signals are
            keyboard-only (Q/E). #topbar stays pointer-events:none, so the
            bar can never intercept a driving touch. */}
        <span id="indL" className="ind">◀</span>
        <span id="clock">21:30</span>
        <span id="wx"></span>
        <span id="indR" className="ind">▶</span>
      </div>
      <div id="hud" style={{ display: playing ? "block" : "none" }}>
        <div className="spd" id="spd">0<small>{unitLabel(g ? g.settings.units : "mph")}</small></div>
        <div className="gear" id="gearTxt">D1</div>
        {/* No Hesi score + combo (game/engine.ts's noHesiUpdate writes the
            text; hidden via the setting, not via this style, so the engine
            is the one source of truth for whether it's on). Styled in
            globals.css with the HUD tokens — see #hud .noHesi. */}
        <div className="noHesi" id="noHesi" />
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
            gameRef.current?.setRunning(false);
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

      {/* ---------- menus ---------- */}
      {screen === "main" && (
        <div className="menuRoot">
          <h1 className="menuTitle">NEON EXPRESSWAY</h1>
          <div className="menuJp">首都高ナイトドライブ</div>
          <p className="menuSub">a procedurally generated town · elevated expressway · dense traffic</p>
          <p className="menuSub">
            car: <b>{getCar(g?.carId || DEFAULT_CAR_ID).name}</b> · paint:{" "}
            {PAINTS[(g?.paintIx || 0) % PAINTS.length].name} · town seed {g?.seed}
          </p>
          <div className="menuBtns">
            <button className="menuBtn primary" onClick={drive}>▶ &nbsp;DRIVE</button>
            {/* The same setting the panel carries, surfaced here so the mode
                is discoverable without going three screens deep. */}
            <button
              className="menuBtn"
              onClick={() => {
                const p = profileRef.current;
                if (!p) return;
                const on = !p.settings.rival;
                p.settings.rival = on;
                if (g) {
                  g.settings.rival = on;
                  syncRivalMode(g.settings);
                } else syncRivalMode(p.settings);
                saveProfile(p);
                rerender();
              }}
            >
              RIVAL 好敵手 — {(g?.settings ?? profileRef.current?.settings)?.rival ? "ON" : "OFF"}
            </button>
            <button className="menuBtn" onClick={() => setScreen("garage")}>GARAGE 車庫</button>
            <button className="menuBtn" onClick={() => setScreen("settings")}>SETTINGS 設定</button>
            <button className="menuBtn" onClick={() => setScreen("controls")}>CONTROLS 操作</button>
          </div>
        </div>
      )}

      {screen === "loading" && (
        <LoadingScreen label={load.label} frac={load.frac} error={loadErr} />
      )}

      {screen === "paused" && (
        <div className="menuRoot paused">
          <h1 className="menuTitle sm">PAUSED</h1>
          <div className="menuBtns">
            <button className="menuBtn primary" onClick={resume}>RESUME</button>
            <button className="menuBtn" onClick={() => setScreen("stats")}>STATS</button>
            <button className="menuBtn" onClick={() => setScreen("garage")}>GARAGE</button>
            <button className="menuBtn" onClick={() => setScreen("settings")}>SETTINGS</button>
            <button className="menuBtn" onClick={() => setScreen("controls")}>CONTROLS</button>
            <button
              className="menuBtn"
              onClick={() => {
                gameRef.current?.resetCar();
                resume();
              }}
            >
              RESET CAR
            </button>
            <button className="menuBtn" onClick={backToMenu}>MAIN MENU</button>
          </div>
        </div>
      )}

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
        <div className="menuRoot">
          <div className="panel">
            <h2>CONTROLS</h2>
            <div className="jp2">操作方法</div>
            {/* Audited against engine.ts (onKeyDown/onKeyUp/readInput,
                bindInput, onPointerDown, gamepad.ts) — every binding listed
                here exists there, and everything bound there is listed. Keep
                the two in step when adding a key. */}
            <div className="ctrlGrid">
              <b>W / S · ↑ / ↓</b><span>throttle · brake &amp; reverse</span>
              <b>A / D · ← / →</b><span>steer</span>
              <b>Space</b><span>handbrake (drift)</span>
              <b>C</b><span>camera: chase → cockpit → hood → console → backseat → dashcam</span>
              <b>B</b><span>look back (chase &amp; cockpit)</span>
              <b>Q / E</b><span>turn signals</span>
              <b>F</b><span>horn (traffic speeds up)</span>
              <b>L</b><span>headlights on / auto</span>
              <b>G</b><span>high beams: tap to flash, hold 2s to latch on / off</span>
              <b>M</b><span>cockpit mirrors</span>
              <b>R</b><span>rain</span>
              <b>U</b><span>wipers: off / int / lo / hi (rain auto-starts lo; also clickable beside the head unit)</span>
              <b>T</b><span>time-lapse</span>
              <b>T</b><span>time-lapse: ×150 → ×1500 → off</span>
              <b>V</b><span>dashcam grade (the DASHCAM view forces its own, harder)</span>
              <b>X</b><span>minimap</span>
              <b>Z</b><span>map zoom: close-up ↔ whole loop (or click the map)</span>
              <b>N</b><span>reset to nearest road</span>
              <b>H</b><span>this help screen</span>
              <b>K</b><span>test mode: extra grip, brakes &amp; power (also in settings; persists)</span>
              <b>O</b><span>photo mode: orbit the car, Space captures a PNG</span>
              <b>P</b><span>in-dash music: play / pause</span>
              <b>I</b><span>interior light — desktop only (off by default; the cabin is meant to be dark)</span>
              <b>P</b><span>in-dash music: play / pause — desktop only</span>
              <b>, / .</b><span>previous / next piece</span>
              <b>Esc</b><span>pause menu (music pauses with it)</span>
            </div>
            <div className="sectionHead">Mouse · in the cabin</div>
            <div className="ctrlGrid">
              <b>Dash screen</b><span>click to switch panes — map / music / trip (desktop)</span>
              <b>Roof console</b><span>click the overhead panel — interior light</span>
            </div>
            <div className="sectionHead">Touch 触れる</div>
            <div className="ctrlGrid">
              <b>Pucks</b><span>steer · pedals · CAM · LTS (high beams) · HORN</span>
              <b>⋯</b><span>quick controls drawer: lights, map, mirrors, rain, time-lapse, dashcam FX, test mode, reset</span>
              <b>Top of frame</b><span>tap the middle — interior light</span>
              <b>Steering</b><span>buttons / touch wheel / tilt — pick in settings</span>
            </div>
            <div className="sectionHead">Gamepad</div>
            <div className="ctrlGrid">
              <b>Sticks / triggers</b><span>left stick steers · RT throttle · LT brake</span>
              <b>Buttons</b><span>A handbrake · B horn · Y lights · RB or D-pad up camera</span>
            </div>
            <p className="ctrlNote">
              Follow the green EXIT boards on the expressway — each numbered exit has a lit
              off-ramp down into the town on both sides, and EXIT 4 峠 leads onto the two-way
              mountain road. Crashed cars keep their hazards on, smoke, and get towed away
              shortly.
            </p>
            <div className="btnrow">
              <button onClick={() => backFrom(true)}>BACK</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ================= loading screen ================= */

/* Rendered from the DRIVE tap until the world is built and warmed.

   Everything that moves here moves on the compositor (see the .loadRoot block
   in globals.css): each build stage blocks the main thread outright, so any
   JS-driven or layout-driven animation would freeze exactly when the player
   most needs to see that something is happening. React re-renders this once
   per stage — a dozen times over the whole load — and the CSS carries the
   motion in between. */
function LoadingScreen({
  label, frac, error,
}: {
  label: string;
  frac: number;
  error: string | null;
}) {
  return (
    <div className="loadRoot">
      <h1 className="loadTitle">NEON EXPRESSWAY</h1>
      <div className="loadJp">首都高ナイトドライブ</div>
      {error ? (
        /* Reload rather than retry: a stage that threw left a half-built world
           in the scene, and running the stages again over it would stack a
           second town on the first (see Game.loadFailed). */
        <div className="loadErr">
          Something went wrong building the town.
          <code>{error}</code>
          <div className="menuBtns inline">
            <button className="menuBtn primary" onClick={() => location.reload()}>
              RELOAD
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="loadBar">
            {/* scaleX rather than width so the bar keeps travelling while the
                next stage blocks the main thread */}
            <div className="loadFill" style={{ transform: `scaleX(${frac})` }} />
            <div className="loadSweep" />
          </div>
          <div className="loadStatus">
            <span>{label}</span>
            <span className="pct">{Math.round(frac * 100)}%</span>
          </div>
        </>
      )}
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

/* Hub horn geometry and timing. HUB_R is the painted #swheelHub disc's radius
   (keep in step with globals.css); DRAG_PX is how far a finger may wander and
   still count as a press rather than a steering input; HOLD_MS is how long it
   must rest before the horn sounds, which is what makes STEERING ALWAYS WIN —
   a drag that starts on the hub has crossed DRAG_PX long before HOLD_MS is up,
   so it steers in silence. A tap that lifts before HOLD_MS never sustained
   anything, so it is answered on release with a STAB_MS blip: real horns
   answer a stab, and without this the most natural gesture on a horn button
   would be the one gesture that made no sound. */
const HUB_R = 27, DRAG_PX = 10, HOLD_MS = 70, STAB_MS = 130;

function SteerWheel({ game }: { game: Game }) {
  const [rot, setRot] = useState(0);
  const active = useRef(false);
  const pid = useRef<number | null>(null);
  const cx = useRef(0);
  /* Hub-horn intent, tracked entirely alongside the steering state above and
     never gating it: every steering line in the handlers below runs exactly as
     it did before the hub existed. The worst a bug in here can do is honk or
     fail to honk — it cannot cost the player a corner. */
  const hornPend = useRef<{ id: number; x: number; y: number; timer: number } | null>(null);
  const hornOn = useRef(false);
  const stabTimer = useRef(0);
  // Mirrors hornOn for the hub's lit state — a ref alone would not re-render.
  const [hornLit, setHornLit] = useState(false);
  const hornRelease = useCallback(() => {
    const hp = hornPend.current;
    if (!hp) return;
    clearTimeout(hp.timer);
    hornPend.current = null;
    if (hornOn.current) {
      hornOn.current = false;
      setHornLit(false);
      game.setWheelHorn(false, null);
      return;
    }
    // Lifted inside HOLD_MS: a deliberate stab. Unwatchdogged (the finger is
    // already gone) and released by this timer, which the unmount effect
    // below also clears so a pause mid-stab cannot leave it sounding.
    game.setWheelHorn(true, null);
    setHornLit(true);
    clearTimeout(stabTimer.current);
    stabTimer.current = window.setTimeout(() => {
      game.setWheelHorn(false, null);
      setHornLit(false);
    }, STAB_MS);
  }, [game]);
  /* Movement past DRAG_PX means the player is steering, not honking: drop the
     intent and silence a horn that had already started. */
  const hornCancel = useCallback(() => {
    const hp = hornPend.current;
    if (hp) clearTimeout(hp.timer);
    hornPend.current = null;
    if (hornOn.current) {
      hornOn.current = false;
      setHornLit(false);
      game.setWheelHorn(false, null);
    }
  }, [game]);
  const end = useCallback(() => {
    active.current = false;
    pid.current = null;
    game.setWheelVal(0);
    game.setWheelPointer(null);
    setRot(0);
    hornRelease();
  }, [game, hornRelease]);
  /* Pausing unmounts this widget mid-drag; without zeroing here the last
     deflection keeps feeding readInput and the car resumes at hard lock. */
  useEffect(
    () => () => {
      game.setWheelVal(0);
      game.setWheelPointer(null);
      // Same reason, for the horn: a pause mid-honk (or mid-stab) unmounts
      // this widget, and neither timer would otherwise ever fire its release.
      const hp = hornPend.current;
      if (hp) clearTimeout(hp.timer);
      clearTimeout(stabTimer.current);
      hornPend.current = null;
      hornOn.current = false;
      game.setWheelHorn(false, null);
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
        /* Hub horn, armed only. Deliberately does NOT sound yet: the honk is
           on a HOLD_MS timer so that a steering drag beginning on the hub —
           which crosses DRAG_PX in a few ms — is silent. Hit-tested against
           the wheel's own rect rather than a child element, so the hub owns
           no pointers and cannot steal the capture set up two lines above. */
        const r = e.currentTarget.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        if (Math.hypot(dx, dy) > HUB_R) return;
        const id = e.pointerId;
        hornPend.current = {
          id,
          x: e.clientX,
          y: e.clientY,
          timer: window.setTimeout(() => {
            // The press outlived HOLD_MS without becoming a drag: honk, and
            // register the live pointer so the frame watchdog owns the release.
            if (hornPend.current?.id !== id) return;
            hornOn.current = true;
            setHornLit(true);
            game.setWheelHorn(true, id);
          }, HOLD_MS),
        };
      }}
      onPointerMove={(e) => {
        if (!active.current || e.pointerId !== pid.current) return;
        const v = Math.max(-1, Math.min(1, (e.clientX - cx.current) / 58));
        game.setWheelVal(v);
        setRot(v * 110);
        // Steering wins, always: past DRAG_PX this is a drag, so the horn
        // intent dies and a honk already sounding is cut.
        const hp = hornPend.current;
        if (hp && e.pointerId === hp.id && Math.hypot(e.clientX - hp.x, e.clientY - hp.y) > DRAG_PX)
          hornCancel();
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
      {/* The horn boss. Purely painted — pointer-events:none, no listeners —
          because the wheel above already hit-tests HUB_R against its own rect;
          a real element here would take the capture and break the drag that
          starts on it. Sibling of swheelInner, not a child, so it stays put
          while the spoke rotates. */}
      <div id="swheelHub" className={hornLit ? "on" : undefined} aria-hidden="true">
        HORN
      </div>
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
   desktop-only by design — no phone headroom), interior light (owner ruled
   out a touch button; the roof-band tap covers it), look-back (dead in the
   shipped dashcam view). */
function QuickDrawer({
  game, open, onClose,
}: {
  game: Game;
  open: boolean;
  onClose: () => void;
}) {
  const [, force] = useState(0);
  const tap = (k: string) => {
    game.uiKeyTap(k);
    force((n) => n + 1);
  };
  // playing implies loaded, but a guard against a not-yet-built car is free
  if (!game.car) return null;
  const rows: { k: string; en: string; jp: string; state: string; on: boolean }[] = [
    { k: "l", en: "HEADLIGHTS", jp: "ライト", state: game.car.lightsUser ? "ON" : "AUTO", on: game.car.lightsUser },
    { k: "x", en: "MINIMAP", jp: "マップ", state: game.mmap ? "ON" : "OFF", on: game.mmap },
    { k: "z", en: "MAP ZOOM", jp: "ズーム", state: game.mmapZoom ? "LOOP" : "NEAR", on: game.mmapZoom },
    { k: "m", en: "MIRRORS", jp: "ミラー", state: game.mirror ? "ON" : "OFF", on: game.mirror },
    { k: "r", en: "RAIN", jp: "雨", state: game.rain ? "ON" : "OFF", on: game.rain },
    /* The touch way into the wiper modes — the stalk click zone is
       desktop-mouse only (see engine.ts wiperStalkTarget). Same key the
       keyboard uses (U), through the same uiKeyTap route. Below RAIN because
       the two are one thought: rain auto-starts LO, this row is for
       choosing INT/HI or going OFF to watch the glass bead up. */
    { k: "u", en: "WIPERS", jp: "ワイパー", state: WIPER_MODE_NAMES[game.wiperMode], on: game.wiperMode > 0 },
    { k: "t", en: "TIME-LAPSE", jp: "時間", state: "×" + game.timeSpeed, on: game.timeSpeed > 0 },
    { k: "v", en: "DASHCAM FX", jp: "映像", state: game.grade ? "ON" : "OFF", on: game.grade },
    { k: "k", en: "TEST MODE", jp: "テスト", state: game.testMode ? "ON" : "OFF", on: game.testMode },
  ];
  return (
    <div id="tcDrawer" className={open ? "open" : undefined}>
      <div className="qdHead">
        QUICK CONTROLS <span>クイック操作</span>
      </div>
      {rows.map((r) => (
        <div key={r.k} className="qdRow" onPointerDown={() => tap(r.k)}>
          <span className="qdLabel">
            {r.en} <i>{r.jp}</i>
          </span>
          <span className={"qdState" + (r.on ? " on" : "")}>{r.state}</span>
        </div>
      ))}
      {/* One-shot, so it also closes the drawer: the whole point of a reset
          is to look at the road it put you back on. */}
      <div
        className="qdRow"
        onPointerDown={() => {
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
        onPointerDown={() => {
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
          <button className="phBtn shutter" onPointerDown={() => game.uiKeyTap(" ")}>
            ◉ SHUTTER
          </button>
          <button className="phBtn" onPointerDown={() => game.uiKeyTap("o")}>
            ✕ EXIT
          </button>
        </div>
      )}
    </div>
  );
}

/* ================= drive stats ================= */

/* The pause menu's STATS panel: this session beside the lifetime record,
   read straight off the engine's accumulator (Game.sessionStats /
   Game.lifetimeStats — see the STATS block in engine.ts). A snapshot, not a
   ticker: the game is paused under it, so nothing here needs to re-render.
   Formatting follows the profile's speed-units setting — the stored numbers
   are engine units (m, m/s, s) and only the display converts. */

const fmtDist = (m: number, u: SpeedUnits) =>
  u === "mph" ? (m / 1609.344).toFixed(1) + " mi" : (m / 1000).toFixed(1) + " km";

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
  /* rec: the session value IS the lifetime record — the record rows warm to
     the accent (same restraint as .combo-hot: a colour shift, not a badge) */
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
      en: "NO HESI SCORE", jp: "スコア",
      sv: String(Math.round(game.noHesiScore)), lv: String(Math.round(game.noHesiBest)),
      rec: game.noHesiScore > 0 && Math.round(game.noHesiScore) >= Math.round(game.noHesiBest),
    },
    {
      en: "BEST COMBO", jp: "最高コンボ",
      sv: "×" + s.bestCombo.toFixed(1), lv: "×" + l.bestCombo.toFixed(1),
      rec: s.bestCombo > 1 && s.bestCombo >= l.bestCombo,
    },
    { en: "CRASHES", jp: "クラッシュ", sv: String(s.crashes), lv: String(l.crashes) },
    { en: "LAPS", jp: "周回", sv: String(s.laps), lv: String(l.laps) },
    { en: "TOUGE RUNS", jp: "峠走破", sv: String(s.mtnRuns), lv: String(l.mtnRuns) },
  ];
  return (
    <div className="menuRoot">
      <div className="panel">
        <h2>STATS</h2>
        <div className="jp2">記録 — drive statistics</div>
        <div className="statsGrid">
          <span />
          <span className="shead">SESSION 今回</span>
          <span className="shead">LIFETIME 通算</span>
          {rows.map((r) => (
            <StatsRow key={r.en} {...r} />
          ))}
        </div>
        <div className="btnrow">
          <button onClick={onBack}>BACK</button>
        </div>
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
      <span className="slabel">
        {en} <i>{jp}</i>
      </span>
      <span className={"sval" + (rec ? " rec" : "")}>{sv}</span>
      <span className="sval">{lv}</span>
    </>
  );
}

/* ================= garage ================= */

function CarPreview({ carId, paintHex }: { carId: string; paintHex: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      /* Two shots for a car with an imported exterior: the procedural one
         returns now and the real-bodywork one replaces it a beat later (see
         carpreview.ts). The card is never empty and never jumps — same frame,
         same lights, only the shell changes — so this is a plain src swap. */
      setUrl(carPreviewURL(carId, paintHex, (real) => {
        if (!cancelled) setUrl(real);
      }));
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [carId, paintHex]);
  return (
    <div className="carImg">
      {url && <img src={url} alt="" draggable={false} />}
    </div>
  );
}

function GaragePanel({ game, onBack }: { game: Game; onBack: () => void }) {
  /* Resolved through getCar rather than taken raw: an engine still carrying a
     locked id from an old profile would otherwise light up a COMING SOON card
     as the current selection. */
  const [carId, setCarId] = useState(() => getCar(game.carId).id);
  const [paintIx, setPaintIx] = useState(game.paintIx);
  const sel = (id: string, pi: number) => {
    setCarId(id);
    setPaintIx(pi);
    game.setCar(id, pi);
  };
  return (
    <div className="menuRoot">
      <div className="panel wide">
        <h2>GARAGE</h2>
        <div className="jp2">車庫 — pick your machine</div>
        <div className="garageCars">
          {CARS.map((c) => {
            /* A locked car keeps its whole card — the live-rendered shot, the
               name, the blurb, the bars — and loses only the ability to be
               picked. sel() is the sole route to game.setCar(), so dropping
               the handler is the whole lock; the dimming is just how it reads.
               The stat bars stay (greyed) because they are what the card is
               teasing, and because a card without them would sit at a
               different height and break the grid row it shares with the two
               playable cars. */
            const locked = !!c.comingSoon;
            return (
              <div
                key={c.id}
                className={"carCard" + (locked ? " locked" : carId === c.id ? " sel" : "")}
                onClick={locked ? undefined : () => sel(c.id, paintIx)}
                aria-disabled={locked || undefined}
              >
                {locked && <span className="soonBadge">COMING SOON</span>}
                <CarPreview carId={c.id} paintHex={PAINTS[paintIx % PAINTS.length].hex} />
                <h3>{c.name} <span style={{ opacity: 0.6 }}>{c.jp}</span></h3>
                <div className="carJp">{c.blurb}</div>
                {(
                  [
                    ["speed", c.stats.speed],
                    ["accel", c.stats.accel],
                    ["grip", c.stats.grip],
                    ["agility", c.stats.handling],
                  ] as const
                ).map(([label, v]) => (
                  <div className="statRow" key={label}>
                    <span>{label}</span>
                    <div className="statBar"><i style={{ width: `${v * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {/* PAINT. The swatches repaint BOTH bodies now: the procedural shell
            through the rig rebuild (engine.ts setCar), and the imported Volvo
            exterior through player.ts tintDonorPaint, which writes the chosen
            colour onto the donor's Car_Paint material when the GLB lands — the
            garage card's real-bodywork shot and the chase cameras agree with
            the dot. (The old comment here was an honest admission that the
            donor kept its baked silver; that limitation is gone.) The caption
            names the selection because eight anonymous dots at 22px is a
            colour test, not a menu — and the finish word is what tells you
            why two similar dots drive differently at night. */}
        <div className="paintRow">
          {PAINTS.map((p, i) => (
            <div
              key={p.name}
              className={"paintDot" + (i === paintIx ? " sel" : "")}
              title={p.name}
              style={{ background: "#" + p.hex.toString(16).padStart(6, "0") }}
              onClick={() => sel(carId, i)}
            />
          ))}
        </div>
        <div className="paintName">
          {PAINTS[paintIx % PAINTS.length].name}
          <i>{PAINTS[paintIx % PAINTS.length].finish}</i>
        </div>
        <div className="btnrow">
          <button onClick={onBack}>DONE</button>
        </div>
      </div>
    </div>
  );
}

/* ================= settings ================= */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row"><label>{label}</label>{children}</div>
  );
}

function Section({ label }: { label: string }) {
  return (
    <div className="sectionHead">{label}</div>
  );
}

function Check({
  label, checked, onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  );
}

function SettingsPanel({
  game, onBack, onReseed,
}: {
  game: Game;
  onBack: () => void;
  onReseed: () => void;
}) {
  const [, force] = useState(0);
  const upd = (fn: (s: GameSettings) => void) => {
    fn(game.settings);
    game.applySettings(game.settings);
    // one call covers every row, so a new rival toggle can never be wired up
    // and then forgotten here
    syncRivalMode(game.settings);
    syncCabinMode(game.settings);
    force((n) => n + 1);
  };
  const s = game.settings;
  return (
    <div className="menuRoot">
      <div className="panel">
        <h2>SETTINGS</h2>
        <div className="jp2">設定</div>
        <Row label="Graphics preset">
          <select
            value={s.preset}
            onChange={(e) => upd((x) => applyPresetDefaults(x, e.target.value as any))}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </Row>
        {/* device tier: caps DPR / reflections / cones etc per hardware class.
            "Auto" shows what detection resolved; the override persists with
            the profile. A `?tier=` URL param (testing) beats both. */}
        <Row label={`Device tier — ${game.renderTier}`}>
          <select
            value={s.tierOverride}
            onChange={(e) => upd((x) => (x.tierOverride = e.target.value as any))}
          >
            <option value="auto">Auto</option>
            <option value="mobile-base">Mobile base</option>
            <option value="mobile-high">Mobile high</option>
            <option value="desktop">Desktop</option>
          </select>
        </Row>
        {/* The imported interior, for cars that ship one (the Volvo). Directly
            under the device tier because that is the row that explains it:
            "Auto" means the real cabin everywhere except a device that fails
            the hardware floor in settings.ts, and the label says which of
            those this device is. Forcing it on a phone that auto-declined is
            allowed and is the point — it is heavy, not forbidden.

            Rebuilds the rig so the choice takes effect now: the donor is
            fetched at build time, so without this the row would look like a
            setting that does nothing until the next reload. setCar is the
            engine's own rebuild path and is a no-op before the world is
            loaded, which is where this panel usually is. */}
        <Row label={`Imported cabin — auto is "${cabinAutoLabel(game.renderTier)}"`}>
          <select
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
          </select>
        </Row>
        <Check label="Road reflections" checked={s.reflections} onChange={(v) => upd((x) => (x.reflections = v))} />
        <Check label="Bloom" checked={s.bloom} onChange={(v) => upd((x) => (x.bloom = v))} />
        <Check label="Day shadows" checked={s.shadows} onChange={(v) => upd((x) => (x.shadows = v))} />
        <Check label="FXAA anti-aliasing" checked={s.fxaa} onChange={(v) => upd((x) => (x.fxaa = v))} />
        <Check label="Motion blur" checked={s.mblur} onChange={(v) => upd((x) => (x.mblur = v))} />
        {/* game.grade is the live truth — the in-game V key flips it too */}
        <Check
          label="Dashcam filter (V)"
          checked={game.grade}
          onChange={(v) =>
            upd((x) => {
              x.dashcam = v;
              game.grade = v;
            })
          }
        />
        <Check label="Traction control" checked={s.tc} onChange={(v) => upd((x) => (x.tc = v))} />
        <Row label="Touch steering">
          <select
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
            <option value="tilt">Tilt</option>
          </select>
        </Row>
        <Row label="Speed units">
          <select value={s.units} onChange={(e) => upd((x) => (x.units = e.target.value as any))}>
            <option value="mph">mph</option>
            <option value="kmh">km/h</option>
          </select>
        </Row>
        <Row label="Fog / haze">
          <select value={s.fog} onChange={(e) => upd((x) => (x.fog = e.target.value as any))}>
            <option value="off">Off</option>
            <option value="light">Light</option>
            <option value="medium">Medium</option>
            <option value="heavy">Heavy</option>
          </select>
        </Row>
        <Row label={`Draw distance — ${s.drawDist} m`}>
          <input
            type="range" min={350} max={1100} step={50} value={s.drawDist}
            onChange={(e) => upd((x) => (x.drawDist = +e.target.value))}
          />
        </Row>
        <Row label={`Traffic density — ${Math.round(s.traffic * 100)}%`}>
          <input
            type="range" min={20} max={100} value={Math.round(s.traffic * 100)}
            onChange={(e) => upd((x) => (x.traffic = +e.target.value / 100))}
          />
        </Row>
        {/* game.testMode is a view onto s.testMode (see Game.testMode), so
            writing either one here is the same write — but go through the
            setting, which is what persist() copies out. The K key in game
            flips the same value. */}
        <Check
          label="Test mode — extra grip, brakes & power"
          checked={s.testMode}
          onChange={(v) => upd((x) => (x.testMode = v))}
        />
        {/* The rival pace car. A mode rather than a difficulty: it costs
            nothing at all while it is off (game/traffic.ts claims its pool
            slot on the toggle, not at construction). */}
        <Check
          label="Rival car (chase the orange one)"
          checked={s.rival}
          onChange={(v) => upd((x) => (x.rival = v))}
        />
        {s.rival && (
          <Check
            label="⤷ rival uses its indicators"
            checked={s.rivalSignals}
            onChange={(v) => upd((x) => (x.rivalSignals = v))}
          />
        )}
        {/* No Hesi scoring: speed + near misses build a combo, contact
            resets it (game/engine.ts's noHesiUpdate). On by default. */}
        <Check
          label="No Hesi score (speed + near misses)"
          checked={s.noHesiScore}
          onChange={(v) => upd((x) => (x.noHesiScore = v))}
        />
        {/* Gates game/hints.ts wholesale. Which tips have already fired is
            stored separately from the settings (see settings.ts), so DEFAULTS
            re-enabling this does not replay them. */}
        <Check
          label="First-run hints (one-time tips)"
          checked={s.hints}
          onChange={(v) => upd((x) => (x.hints = v))}
        />
        <Row label={`Field of view — ${s.fovBase}°`}>
          <input
            type="range" min={58} max={100} value={s.fovBase}
            onChange={(e) => upd((x) => (x.fovBase = +e.target.value))}
          />
        </Row>
        <Row label={`Volume — ${Math.round(s.vol * 100)}%`}>
          <input
            type="range" min={0} max={100} value={Math.round(s.vol * 100)}
            onChange={(e) => upd((x) => (x.vol = +e.target.value / 100))}
          />
        </Row>
        <Section label="World & weather" />
        <Row label={`Time of day — ${fmtTime(game.time)}`}>
          <input
            type="range" min={0} max={24} step={0.25} value={game.time}
            onChange={(e) => {
              game.time = +e.target.value;
              force((n) => n + 1);
            }}
          />
        </Row>
        <Check label="Day/night cycle" checked={s.autoTime} onChange={(v) => upd((x) => (x.autoTime = v))} />
        <Row label="Rain">
          <input
            type="checkbox" checked={game.rain}
            onChange={(e) => {
              game.setRain(e.target.checked);
              force((n) => n + 1);
            }}
          />
        </Row>
        <Section label="Session" />
        <Row label={`Town seed — ${game.seed}`}>
          <button onClick={onReseed}>NEW TOWN (reloads)</button>
        </Row>
        <Row label="Reset all settings">
          <button
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
              force((n) => n + 1);
            }}
          >
            DEFAULTS
          </button>
        </Row>
        <div className="btnrow">
          <button onClick={onBack}>DONE</button>
        </div>
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
