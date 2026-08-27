"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Game } from "@/game/engine";
import type { LoadReport } from "@/game/loading";
import { CARS, PAINTS, getCar } from "@/game/carspecs";
import { carPreviewURL } from "@/game/carpreview";
import {
  loadProfile, saveProfile, defaultSettings, applyPresetDefaults, unitLabel,
  syncRivalMode,
  type Profile, type GameSettings,
} from "@/game/settings";

type Screen = "main" | "garage" | "settings" | "controls" | "loading" | "playing" | "paused";

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
    const game = new Game(hostRef.current, profile, {
      toast: showToast,
      exitHint: (t) => setExitHint(t),
      pauseRequest: () => {
        const s = screenRef.current;
        if (s === "playing") {
          gameRef.current?.setRunning(false);
          setFromPause(true);
          setScreen("paused");
        } else if (s === "paused") {
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
  };
  const backFrom = (sub: boolean) => {
    if (fromPause && sub) setScreen("paused");
    else setScreen("main");
  };

  const g = gameRef.current;
  const playing = screen === "playing";
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
        <span id="indL" className="ind">◀</span>
        <span id="clock">21:30</span>
        <span id="wx"></span>
        <span id="indR" className="ind">▶</span>
      </div>
      <div id="hud" style={{ display: playing ? "block" : "none" }}>
        <div className="spd" id="spd">0<small>{unitLabel(g ? g.settings.units : "mph")}</small></div>
        <div className="gear" id="gearTxt">D1</div>
      </div>
      <div id="toast" style={{ opacity: toast ? 1 : 0 }}>{toast}</div>
      <div id="exitHint" style={{ opacity: exitHint && playing ? 1 : 0 }}>{exitHint}</div>
      <canvas
        id="mmap" width={172} height={172}
        style={{ display: playing && g?.mmap ? "block" : "none" }}
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
            car: <b>{getCar(g?.carId || "kaze").name}</b> · paint:{" "}
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
          <h1 className="menuTitle" style={{ fontSize: 34 }}>PAUSED</h1>
          <div className="menuBtns">
            <button className="menuBtn primary" onClick={resume}>RESUME</button>
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
            <div className="ctrlGrid">
              <b>W / S</b><span>throttle · brake &amp; reverse</span>
              <b>A / D</b><span>steer</span>
              <b>Space</b><span>handbrake (drift)</span>
              <b>C</b><span>camera: chase → cockpit → hood → console → dashcam</span>
              <b>B</b><span>look back (chase &amp; cockpit)</span>
              <b>Q / E</b><span>turn signals</span>
              <b>F</b><span>horn (traffic speeds up)</span>
              <b>L</b><span>headlights on / auto</span>
              <b>G</b><span>high beams: tap to flash, hold 2s to latch on / off</span>
              <b>M</b><span>cockpit mirrors</span>
              <b>R</b><span>rain</span>
              <b>T</b><span>time-lapse</span>
              <b>V</b><span>dashcam grade (the DASHCAM view forces its own, harder)</span>
              <b>X</b><span>minimap</span>
              <b>N</b><span>reset to nearest road</span>
              <b>H</b><span>this help screen</span>
              <b>I</b><span>interior light (off by default — the cabin is meant to be dark)</span>
              <b>J</b><span>imported Volvo dash + body / the procedural car (A/B)</span>
              <b>K</b><span>test mode: extra grip, brakes &amp; power (also in settings; persists)</span>
              <b>P</b><span>in-dash music: play / pause</span>
              <b>, / .</b><span>previous / next piece</span>
              <b>Esc</b><span>pause menu (music pauses with it)</span>
            </div>
            <p style={{ color: "#7d8aa8", marginTop: 12, fontSize: 12 }}>
              Follow the green EXIT boards on the expressway — each numbered exit has a lit
              off-ramp down into the town on both sides. Crashed cars keep their hazards on,
              smoke, and get towed away shortly.
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
          <div className="menuBtns" style={{ minWidth: 0, marginTop: 18 }}>
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

function SteerWheel({ game }: { game: Game }) {
  const [rot, setRot] = useState(0);
  const active = useRef(false);
  const cx = useRef(0);
  const end = () => {
    active.current = false;
    game.setWheelVal(0);
    setRot(0);
  };
  /* Pausing unmounts this widget mid-drag; without zeroing here the last
     deflection keeps feeding readInput and the car resumes at hard lock. */
  useEffect(() => () => game.setWheelVal(0), [game]);
  return (
    <div
      id="swheel"
      onPointerDown={(e) => {
        active.current = true;
        cx.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        const v = Math.max(-1, Math.min(1, (e.clientX - cx.current) / 58));
        game.setWheelVal(v);
        setRot(v * 110);
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div id="swheelInner" style={{ transform: `rotate(${rot}deg)` }}>
        ◠<br />│
      </div>
    </div>
  );
}

/* ================= garage ================= */

function CarPreview({ carId, paintHex }: { carId: string; paintHex: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (!cancelled) setUrl(carPreviewURL(carId, paintHex));
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
      <div className="panel" style={{ width: "min(760px,95vw)" }}>
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
               different height and break the grid row it shares with KAZE. */
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
        <hr />
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
        <hr />
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
