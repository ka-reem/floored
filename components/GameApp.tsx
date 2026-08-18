"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Game } from "@/game/engine";
import { CARS, PAINTS, getCar } from "@/game/carspecs";
import { carPreviewURL } from "@/game/carpreview";
import {
  loadProfile, saveProfile, defaultSettings, applyPresetDefaults, unitLabel,
  type Profile, type GameSettings,
} from "@/game/settings";

type Screen = "main" | "garage" | "settings" | "controls" | "playing" | "paused";

export default function GameApp() {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const profileRef = useRef<Profile | null>(null);
  const [screen, setScreen] = useState<Screen>("main");
  const [fromPause, setFromPause] = useState(false);
  const [toast, setToast] = useState("");
  const [exitHint, setExitHint] = useState<string | null>(null);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenRef = useRef<Screen>("main");
  screenRef.current = screen;

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
      helpRequest: () => {
        if (screenRef.current === "playing") {
          gameRef.current?.setRunning(false);
          setFromPause(true);
          setScreen("controls");
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

  const drive = () => {
    const g = gameRef.current;
    if (!g) return;
    g.start();
    g.setRunning(true);
    setFromPause(false);
    setScreen("playing");
    persist();
  };
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
      {/* touch controls */}
      <div className="tc" id="tcL" style={g && g.settings.steerMode !== "buttons" ? { display: "none" } : undefined}>⟲</div>
      <div className="tc" id="tcR" style={g && g.settings.steerMode !== "buttons" ? { display: "none" } : undefined}>⟳</div>
      <div className="tc" id="tcG">▲</div>
      <div className="tc" id="tcB">▼</div>
      <div className="tc" id="tcC">CAM</div>
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
            <button className="menuBtn" onClick={() => setScreen("garage")}>GARAGE 車庫</button>
            <button className="menuBtn" onClick={() => setScreen("settings")}>SETTINGS 設定</button>
            <button className="menuBtn" onClick={() => setScreen("controls")}>CONTROLS 操作</button>
          </div>
        </div>
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
            const p = profileRef.current!;
            p.seed = (Math.random() * 100000) | 0;
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
              <b>C</b><span>camera: chase → cockpit → hood → dashcam</span>
              <b>B</b><span>look back (chase &amp; cockpit)</span>
              <b>Q / E</b><span>turn signals</span>
              <b>F</b><span>horn (traffic speeds up)</span>
              <b>L</b><span>headlights on / auto</span>
              <b>G</b><span>high beams: hold to flash, double-tap to latch</span>
              <b>M</b><span>cockpit mirrors</span>
              <b>R</b><span>rain</span>
              <b>T</b><span>time-lapse</span>
              <b>V</b><span>dashcam grade (the DASHCAM view forces its own, harder)</span>
              <b>X</b><span>minimap</span>
              <b>N</b><span>reset to nearest road</span>
              <b>Esc</b><span>pause menu</span>
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

/* ================= touch steering wheel ================= */

function SteerWheel({ game }: { game: Game }) {
  const [rot, setRot] = useState(0);
  const active = useRef(false);
  const cx = useRef(0);
  const end = () => {
    active.current = false;
    game.setWheelVal(0);
    setRot(0);
  };
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
  const [carId, setCarId] = useState(game.carId);
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
          {CARS.map((c) => (
            <div
              key={c.id}
              className={"carCard" + (carId === c.id ? " sel" : "")}
              onClick={() => sel(c.id, paintIx)}
            >
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
          ))}
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
        <Row label={`Field of view — ${s.fovBase}°`}>
          <input
            type="range" min={58} max={80} value={s.fovBase}
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
