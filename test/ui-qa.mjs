/* Automated UI / gameplay QA walkthrough — the "go play the game and test
   stuff" pass, made repeatable. Rerun after every merge.

   What it does, per viewport (desktop 1440×900, phone portrait 390×844 under a
   mobile UA + touch emulation, phone landscape 844×390):
     main menu → garage (every playable car, a couple of paints) → settings
     (scroll, flip a toggle, change a select/segmented, drag a slider) →
     controls → DRIVE → HUD while driving (sim-stepped) → touch drawer (⋯, phone)
     → pause → stats → resume → photo mode → exit to menu.
   Every state is screenshotted and put through a LAYOUT AUDIT in page context:
     a  horizontal document overflow                         (error)
     b  visible element extends outside the viewport > 2 px  (error)
     c  overflow:hidden element clipping its own text > 4 px (warning)
     d  interactive elements whose rects overlap > 8 px      (error)
     e  touch target smaller than 44×44 on a phone viewport  (warning)
     f  button/chip text centre off its box centre > 3 px    (warning)
     g  console errors / page errors                         (error)
   Desktop only, after the walkthrough:
     - camera sweep: all six cameras screenshotted while driving, plus a chase-
       cam pitch trace over a full-throttle launch (max pitch-down and
       frame-to-frame jitter, both a deterministic 60 Hz sim trace and the
       real rendered frames);
     - mountain-road drive-through: a pure-pursuit driver takes the car off the
       expressway onto the pass at the exit gore, over the whole route and back
       onto the deck, logging position/speed/road-height/stall/reset/collision
       per step; entrance / mid / exit shots from the dashcam and the chase cam.
       An incomplete pass is a hard failure (rule mtn-*).

   Exit status is non-zero when any a/b/d/g finding exists or the mountain pass
   did not complete; everything else is a warning in the report.

   Outputs (under --out, default <scratchpad>/qa or ./test/artifacts/qa):
     shots/<viewport>/NN-<screen>.png, findings.json, report.md,
     mountain-log.json, chase-pitch.json

   Usage:
     node test/ui-qa.mjs [--url http://localhost:3131] [--out DIR]
                         [--viewports desktop,phone,phone-land]
                         [--skip-mountain] [--skip-cameras]
   Starts `next dev` itself when no --url is given. Everything is driven by SIM
   time through window.__neonx (test/lib/debug-url.mjs adds ?debug=1), so a
   loaded box with SwiftShader at a frame per second still finishes. */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i > -1 ? argv[i + 1] : null;
};
const has = (k) => argv.includes(k);
const externalUrl = argOf("--url");
const SCRATCH = process.env.CLAUDE_SCRATCHPAD ||
  "/tmp/claude-0/-home-user-racing-game/d557af8b-cf5b-5327-b452-a82bf20b5727/scratchpad";
const OUT = path.resolve(
  argOf("--out") || (existsSync(SCRATCH) ? path.join(SCRATCH, "qa") : path.join(process.cwd(), "test", "artifacts", "qa")),
);
const SKIP_MTN = has("--skip-mountain");
const SKIP_CAMS = has("--skip-cameras");
const VIEWPORTS_ALL = {
  desktop: { width: 1440, height: 900, phone: false },
  phone: { width: 390, height: 844, phone: true },
  "phone-land": { width: 844, height: 390, phone: true },
};
const VIEWPORTS = (argOf("--viewports") || "desktop,phone,phone-land").split(",").map((s) => s.trim()).filter(Boolean);
for (const v of VIEWPORTS) if (!VIEWPORTS_ALL[v]) { console.error("unknown viewport", v); process.exit(2); }

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f1 = (n) => (typeof n === "number" ? n.toFixed(1) : String(n));
const f2 = (n) => (typeof n === "number" ? n.toFixed(2) : String(n));

mkdirSync(OUT, { recursive: true });

/* ---------------- dev server ---------------- */
async function freePort(start) {
  for (let p = start; p < start + 40; p++) {
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once("error", () => res(false));
      s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error("no free port");
}

async function startDev() {
  if (externalUrl) return { url: externalUrl, child: null };
  const port = await freePort(3131);
  const child = spawn("npx", ["next", "dev", "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    detached: true,
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("next dev timeout")), 180000);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Ready") || s.includes("started server")) { clearTimeout(to); resolve(); }
    });
    child.stderr.on("data", (d) => process.stderr.write("[next:err] " + d.toString()));
    child.on("exit", (c) => reject(new Error("next dev exited " + c)));
  });
  return { url: `http://localhost:${port}`, child };
}
function killDev(child) {
  if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
}

/* ---------------- findings ---------------- */
const SEVERITY = {
  "a-hscroll": "error", "b-offscreen": "error", "c-clipped-text": "warning",
  "d-overlap": "error", "e-small-target": "warning", "f-text-centre": "warning",
  "g-console": "error", "touch-layout": "error", "walk": "error",
  "mtn-stall": "error", "mtn-offroad": "error", "mtn-drop": "error", "mtn-reset": "error",
  "mtn-collision": "error", "mtn-incomplete": "error", "mtn-height-step": "warning",
  "chase-pitch": "warning", "chase-jitter": "warning",
};
const findings = [];
const shots = []; // { viewport, screen, file }
function addFinding(viewport, screen, rule, sel, text, nums) {
  findings.push({ viewport, screen, rule, severity: SEVERITY[rule] || "warning", sel, text: text || "", nums: nums || {} });
}

/* ---------------- the in-page layout audit ----------------
   Runs inside the page; returns an array of {rule, sel, text, nums}. */
const AUDIT_FN = (opts) => {
  const W = innerWidth, H = innerHeight;
  const out = [];
  const push = (rule, el, nums, text) => out.push({ rule, sel: desc(el), text: text ?? shortText(el), nums });
  const desc = (el) => {
    if (!el || el === document) return "document";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.classList && el.classList.length) s += "." + [...el.classList].slice(0, 3).join(".");
    if (el.type && el.tagName === "INPUT") s += `[type=${el.type}]`;
    return s;
  };
  const shortText = (el) => ((el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28));
  const r4 = (n) => Math.round(n * 10) / 10;

  const se = document.scrollingElement || document.documentElement;
  if (se.scrollWidth > se.clientWidth + 1)
    push("a-hscroll", document, { scrollWidth: se.scrollWidth, clientWidth: se.clientWidth }, "");

  const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "HEAD", "HTML", "NOSCRIPT", "TEMPLATE", "NEXTJS-PORTAL"]);
  const all = [...document.body.querySelectorAll("*")].filter(
    (e) => !SKIP.has(e.tagName) && !e.closest("nextjs-portal"),
  );
  const csCache = new Map();
  const cs = (e) => { let s = csCache.get(e); if (!s) { s = getComputedStyle(e); csCache.set(e, s); } return s; };
  const visCache = new Map();
  const visible = (e) => {
    if (!e || e === document.body || e === document.documentElement) return true;
    if (visCache.has(e)) return visCache.get(e);
    const s = cs(e);
    let v = !(s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0);
    if (v) v = visible(e.parentElement);
    visCache.set(e, v);
    return v;
  };
  const inter = (a, b) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  /* rect an element can actually paint into: clipped by every overflow-
     clipping ancestor (a scrolling settings panel legitimately has children
     below the fold). position:fixed escapes ancestor clipping. */
  const clipOf = (el) => {
    let c = { l: -1e9, t: -1e9, r: 1e9, b: 1e9 };
    if (cs(el).position === "fixed") return c;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = cs(p);
      if (s.overflowX !== "visible" || s.overflowY !== "visible" || (s.clipPath && s.clipPath !== "none"))
        c = inter(c, box(p));
      if (s.position === "fixed") break;
    }
    return c;
  };

  /* (b) off-screen. Outermost offender only — a wrapper that hangs off the
     edge takes its children with it. */
  const flaggedB = new Set();
  for (const el of all) {
    if (!visible(el)) continue;
    const b = box(el);
    if (b.w <= 0 || b.h <= 0) continue;
    const vr = inter(b, clipOf(el));
    if (vr.r <= vr.l || vr.b <= vr.t) continue;
    const over = { left: -vr.l, top: -vr.t, right: vr.r - W, bottom: vr.b - H };
    const worst = Math.max(over.left, over.top, over.right, over.bottom);
    if (worst > 2) {
      let anc = el.parentElement, skip = false;
      while (anc) { if (flaggedB.has(anc)) { skip = true; break; } anc = anc.parentElement; }
      if (skip) continue;
      flaggedB.add(el);
      const side = Object.entries(over).filter(([, v]) => v > 2).map(([k, v]) => `${k}+${r4(v)}`).join(" ");
      push("b-offscreen", el, { overflowPx: r4(worst), rect: [r4(b.l), r4(b.t), r4(b.w), r4(b.h)], viewport: [W, H] }, `${side} · ${shortText(el)}`);
    }
  }

  /* (c) clipped text */
  for (const el of all) {
    if (!visible(el)) continue;
    const s = cs(el);
    const hidX = s.overflowX === "hidden" || s.overflowX === "clip";
    const hidY = s.overflowY === "hidden" || s.overflowY === "clip";
    if (!hidX && !hidY) continue;
    if (!(el.textContent || "").trim()) continue;
    const dx = el.scrollWidth - el.clientWidth, dy = el.scrollHeight - el.clientHeight;
    if ((hidX && dx > 4) || (hidY && dy > 4))
      push("c-clipped-text", el, { clippedX: dx, clippedY: dy, clientW: el.clientWidth, clientH: el.clientHeight });
  }

  /* (d) overlapping interactive, (e) small touch targets */
  const INTER = "button, input, select, textarea, a[href], [role=button], .tc, .carCard, .paintDot, .qdRow, #gearBtn, #tcMore, .phBtn, .menuBtn, #mmap, #swheel, #sslider";
  const inter_ = [...document.querySelectorAll(INTER)].filter((e) => {
    if (!visible(e) || e.closest("nextjs-portal")) return false;
    if (cs(e).pointerEvents === "none") return false;
    const b = box(e);
    return b.w > 0 && b.h > 0;
  });
  for (let i = 0; i < inter_.length; i++) {
    const A = inter_[i], ba = box(A);
    if (opts.phone && (ba.w < 44 || ba.h < 44))
      push("e-small-target", A, { w: r4(ba.w), h: r4(ba.h) });
    for (let j = i + 1; j < inter_.length; j++) {
      const B = inter_[j];
      if (A.contains(B) || B.contains(A)) continue;
      const x = inter(ba, box(B));
      const w = x.r - x.l, h = x.b - x.t;
      if (w > 8 && h > 8)
        push("d-overlap", A, { overlapW: r4(w), overlapH: r4(h), other: desc(B) }, `${shortText(A)} ⟂ ${shortText(B)}`);
    }
  }

  /* (f) text centring on buttons / chips */
  const CHIPS = "button, .tc, #tcMore, .menuBtn, .phBtn, .qdState, .soonBadge, .paintName, .menuTitle, .loadTitle";
  for (const el of document.querySelectorAll(CHIPS)) {
    if (!visible(el) || el.closest("nextjs-portal")) continue;
    const txt = (el.textContent || "").trim();
    if (!txt) continue;
    const s = cs(el);
    const centred = el.tagName === "BUTTON" || s.textAlign === "center" ||
      (s.display.includes("flex") && /center|space-around|space-evenly/.test(s.justifyContent));
    if (!centred) continue;
    const b = box(el);
    if (b.w <= 0 || b.h <= 0) continue;
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const rects = [...rg.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    const u = rects.reduce((a, r) => ({ l: Math.min(a.l, r.left), t: Math.min(a.t, r.top), r: Math.max(a.r, r.right), b: Math.max(a.b, r.bottom) }),
      { l: 1e9, t: 1e9, r: -1e9, b: -1e9 });
    // padding box centre (border excluded) — that is what a centred label centres in
    const bl = parseFloat(s.borderLeftWidth) || 0, br = parseFloat(s.borderRightWidth) || 0;
    const bt = parseFloat(s.borderTopWidth) || 0, bb = parseFloat(s.borderBottomWidth) || 0;
    const cx = (b.l + bl + b.r - br) / 2, cy = (b.t + bt + b.b - bb) / 2;
    const dx = (u.l + u.r) / 2 - cx, dy = (u.t + u.b) / 2 - cy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3)
      push("f-text-centre", el, { dx: r4(dx), dy: r4(dy), box: [r4(b.w), r4(b.h)] });
  }
  return out;
};

/* ---------------- browser helpers ---------------- */
const IGNORE_CONSOLE = /favicon|ERR_TUNNEL_CONNECTION_FAILED|va\.vercel-scripts\.com|\/_vercel\/insights\/|posthog|Failed to load resource|net::ERR_|WebSocket|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i;

class Session {
  constructor(page, vpName, vp) {
    this.page = page;
    this.vpName = vpName;
    this.vp = vp;
    this.n = 0;
    this.screen = "boot";
    this.consoleErrors = [];
    this.dir = path.join(OUT, "shots", vpName);
    mkdirSync(this.dir, { recursive: true });
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (IGNORE_CONSOLE.test(t)) return;
      this.consoleErrors.push(t);
      addFinding(vpName, this.screen, "g-console", "console", t.slice(0, 300));
      console.log("  ⛔ console.error:", t.slice(0, 200));
    });
    page.on("pageerror", (e) => {
      const t = String(e.message || e);
      addFinding(vpName, this.screen, "g-console", "pageerror", t.slice(0, 300));
      console.log("  ⛔ pageerror:", t.slice(0, 200));
    });
  }
  async frames() {
    return this.page.evaluate(() => window.__neonx?.game?.debug?.frames ?? -1).catch(() => -1);
  }
  /** wait for n rendered frames (real rAF), bounded by wall time */
  async waitFrames(n = 2, maxMs = 25000) {
    const f0 = await this.frames();
    if (f0 < 0) { await sleep(400); return; }
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(150);
      if ((await this.frames()) >= f0 + n) return;
    }
  }
  async shot(name) {
    const file = path.join(this.dir, `${String(++this.n).padStart(2, "0")}-${name}.png`);
    try {
      await this.page.screenshot({ path: file, captureBeyondViewport: false });
      shots.push({ viewport: this.vpName, screen: name, file });
      console.log("  📸", path.relative(OUT, file));
    } catch (e) {
      console.log("  ⚠️  screenshot", name, "failed:", String(e.message).slice(0, 80));
    }
    return file;
  }
  async audit(name, { shot = true } = {}) {
    this.screen = name;
    if (shot) await this.shot(name);
    let res = [];
    try {
      res = await this.page.evaluate(AUDIT_FN, { phone: this.vp.phone });
    } catch (e) {
      addFinding(this.vpName, name, "walk", "audit", "audit threw: " + String(e.message).slice(0, 200));
      return;
    }
    for (const r of res) addFinding(this.vpName, name, r.rule, r.sel, r.text, r.nums);
    const errs = res.filter((r) => SEVERITY[r.rule] === "error").length;
    console.log(`  audit ${name}: ${res.length} finding(s), ${errs} error(s)`);
  }
  /* --- interaction --- */
  async clickText(selector, text, { exact = false } = {}) {
    const ok = await this.page.evaluate(({ selector, text, exact }) => {
      const els = [...document.querySelectorAll(selector)];
      const b = els.find((x) => {
        const t = (x.textContent || "").trim();
        return exact ? t === text : t.includes(text);
      });
      if (!b) return false;
      b.click();
      return true;
    }, { selector, text, exact });
    if (!ok) addFinding(this.vpName, this.screen, "walk", selector, `no element with text "${text}"`);
    return ok;
  }
  /** pointerdown-driven chrome (#gearBtn, #tcMore, .qdRow, .phBtn): a real
      touch tap on phones, a synthetic pointerdown elsewhere */
  async tapEl(selector, textFilter) {
    const rect = await this.page.evaluate(({ selector, textFilter }) => {
      const els = [...document.querySelectorAll(selector)];
      const el = textFilter ? els.find((e) => (e.textContent || "").includes(textFilter)) : els[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }, { selector, textFilter });
    if (!rect) { addFinding(this.vpName, this.screen, "walk", selector, `missing (${textFilter || ""})`); return false; }
    if (this.vp.phone) {
      try { await this.page.touchscreen.tap(rect.x, rect.y); return true; } catch {}
    }
    await this.page.evaluate(({ selector, textFilter }) => {
      const els = [...document.querySelectorAll(selector)];
      const el = textFilter ? els.find((e) => (e.textContent || "").includes(textFilter)) : els[0];
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
    }, { selector, textFilter });
    return true;
  }
  async waitFor(fn, ms, label) {
    try { await this.page.waitForFunction(fn, { timeout: ms }); return true; }
    catch { addFinding(this.vpName, this.screen, "walk", label, `timed out waiting for ${label}`); return false; }
  }
}

/* ---------------- the walkthrough ---------------- */
async function walkthrough(S, url) {
  const { page, vp, vpName } = S;
  console.log(`\n=== ${vpName} ${vp.width}×${vp.height}${vp.phone ? " (touch)" : ""} ===`);
  await page.goto(debugUrl(url), { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 180000 });
  await sleep(1500);

  const touch = await page.evaluate(() => ({
    isTouch: !!window.__neonx?.game?.isTouch,
    bodyTouch: document.body.classList.contains("touch"),
    coarse: matchMedia("(pointer:coarse)").matches,
    ontouch: "ontouchstart" in window,
  }));
  console.log("  touch detection:", JSON.stringify(touch));
  if (vp.phone && !touch.isTouch)
    addFinding(vpName, "menu", "touch-layout", "Game.isTouch", `touch layout did not engage under emulation: ${JSON.stringify(touch)}`);
  if (!vp.phone && touch.isTouch)
    addFinding(vpName, "menu", "touch-layout", "Game.isTouch", "desktop viewport resolved as touch");

  await S.audit("menu");

  /* ---- garage ---- */
  await S.clickText("button", "GARAGE");
  await S.waitFor(() => document.querySelector(".carCard"), 10000, ".carCard");
  await sleep(1200); // car previews render off-screen
  await S.audit("garage");
  const cars = await page.evaluate(() =>
    [...document.querySelectorAll(".carCard:not(.locked)")].map((c) => (c.querySelector("h3")?.firstChild?.textContent || c.textContent).trim().split(/\s+/)[0]));
  for (const name of cars) {
    await page.evaluate((name) => {
      [...document.querySelectorAll(".carCard:not(.locked)")]
        .find((c) => (c.querySelector("h3")?.textContent || "").includes(name))?.click();
    }, name);
    await sleep(700);
    await S.audit(`garage-car-${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`);
  }
  for (const pi of [2, 5]) {
    const ok = await page.evaluate((pi) => { const d = document.querySelectorAll(".paintDot")[pi]; if (!d) return false; d.click(); return true; }, pi);
    if (ok) { await sleep(600); await S.audit(`garage-paint-${pi}`); }
  }
  await S.clickText("button", "DONE", { exact: true });
  await sleep(300);

  /* ---- settings ---- */
  await S.clickText("button", "SETTINGS");
  await S.waitFor(() => document.querySelector(".panel"), 10000, "settings panel");
  await sleep(300);
  await S.audit("settings");
  const scrollable = await page.evaluate(() => {
    const p = document.querySelector(".panel");
    if (!p) return null;
    const can = p.scrollHeight > p.clientHeight + 4;
    if (can) p.scrollTop = p.scrollHeight;
    return { can, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight };
  });
  console.log("  settings panel:", JSON.stringify(scrollable));
  if (scrollable?.can) { await sleep(300); await S.audit("settings-scrolled"); }
  await page.evaluate(() => { const p = document.querySelector(".panel"); if (p) p.scrollTop = 0; });
  const changed = await page.evaluate(() => {
    const done = {};
    const cb = document.querySelector('.panel input[type="checkbox"]');
    if (cb) { cb.click(); done.toggle = cb.closest(".row")?.querySelector("label")?.textContent?.trim(); }
    // segmented control if the UI has one, else the first <select>
    const seg = document.querySelector('.panel .seg button, .panel [role="radiogroup"] button, .panel .segmented button');
    if (seg) {
      const opts = [...seg.parentElement.querySelectorAll("button")];
      const other = opts.find((b) => !b.classList.contains("sel") && b.getAttribute("aria-pressed") !== "true") || opts[1] || opts[0];
      other.click();
      done.segmented = other.textContent.trim();
    } else {
      const sel = document.querySelector(".panel select");
      if (sel) {
        const ix = (sel.selectedIndex + 1) % sel.options.length;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, sel.options[ix].value);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        done.select = `${sel.closest(".row")?.querySelector("label")?.textContent?.trim()} → ${sel.options[ix].text}`;
      }
    }
    const rng = document.querySelector('.panel input[type="range"]');
    if (rng) {
      const v = (Number(rng.min) + Number(rng.max)) / 2;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(rng, String(v));
      rng.dispatchEvent(new Event("input", { bubbles: true }));
      done.slider = `${rng.closest(".row")?.querySelector("label")?.textContent?.trim()} = ${v}`;
    }
    return done;
  });
  console.log("  settings changed:", JSON.stringify(changed));
  await sleep(500);
  await S.audit("settings-changed");
  await S.clickText("button", "DONE", { exact: true });
  await sleep(300);

  /* ---- controls ---- */
  await S.clickText("button", "CONTROLS");
  await S.waitFor(() => [...document.querySelectorAll("h2")].some((h) => h.textContent.includes("CONTROLS")), 10000, "controls panel");
  await sleep(300);
  await S.audit("controls");
  await S.clickText("button", "BACK", { exact: true });
  await sleep(300);
  await S.audit("menu-back");

  /* ---- DRIVE ---- */
  await S.clickText("button", "DRIVE");
  // the loading screen is transient; grab it if it is still up after a beat
  await sleep(700);
  if (await page.evaluate(() => !!document.querySelector(".loadRoot"))) await S.audit("loading");
  const loaded = await S.waitFor(() => window.__neonx?.game?.loaded && !document.querySelector(".loadRoot"), 240000, "world load");
  if (!loaded) return;
  await sleep(1500);
  await page.evaluate(() => { window.__neonx.setInput({ th: 0.75 }); window.__neonx.simStep(4); });
  await S.waitFrames(2);
  await S.audit("drive-hud");
  await page.evaluate(() => window.__neonx.setInput(null));

  /* ---- touch drawer (phone) ---- */
  if (vp.phone) {
    const moreVisible = await page.evaluate(() => { const m = document.getElementById("tcMore"); return !!m && getComputedStyle(m).display !== "none"; });
    if (!moreVisible) addFinding(vpName, "drive-hud", "touch-layout", "#tcMore", "the ⋯ button is not shown on a touch viewport");
    else {
      await S.tapEl("#tcMore");
      let open = await S.waitFor(() => document.querySelector("#tcDrawer.open"), 3000, "#tcDrawer.open").catch(() => false);
      if (!open) {
        await page.evaluate(() => document.getElementById("tcMore")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2, isPrimary: true })));
        open = await S.waitFor(() => document.querySelector("#tcDrawer.open"), 3000, "#tcDrawer.open (synthetic)");
      }
      await sleep(400);
      await S.audit("drawer");
      // close by tapping the road
      await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 3, isPrimary: true })));
      await sleep(300);
    }
  }

  /* ---- pause ---- */
  if (vp.phone) await S.tapEl("#gearBtn");
  else await page.keyboard.press("Escape");
  await S.waitFor(() => document.querySelector(".menuRoot.paused"), 5000, "pause menu");
  await sleep(300);
  await S.audit("pause");

  /* ---- stats ---- */
  await S.clickText("button", "STATS", { exact: true });
  await S.waitFor(() => document.querySelector(".statsGrid"), 5000, "stats panel");
  await sleep(300);
  await S.audit("stats");
  await S.clickText("button", "BACK", { exact: true });
  await S.waitFor(() => document.querySelector(".menuRoot.paused"), 5000, "pause after stats");

  /* ---- resume ---- */
  await S.clickText("button", "RESUME", { exact: true });
  await S.waitFor(() => !document.querySelector(".menuRoot") && window.__neonx.game.running, 5000, "resume");
  await page.evaluate(() => { window.__neonx.setInput({ th: 0.5 }); window.__neonx.simStep(1.5); window.__neonx.setInput(null); });
  await S.waitFrames(2);
  await S.audit("resume");

  /* ---- photo mode ---- */
  if (vp.phone) {
    await S.tapEl("#tcMore");
    await S.waitFor(() => document.querySelector("#tcDrawer.open"), 3000, "drawer for photo");
    await S.tapEl(".qdRow", "PHOTO");
  } else {
    await page.keyboard.press("o");
  }
  const inPhoto = await S.waitFor(() => window.__neonx.state().photo, 5000, "photo mode");
  if (inPhoto) {
    await S.waitFrames(2);
    await S.audit("photo");
    if (vp.phone) await S.tapEl(".phBtn", "EXIT");
    else await page.keyboard.press("o");
    await S.waitFor(() => !window.__neonx.state().photo, 5000, "photo exit");
  }

  /* ---- exit to menu ---- */
  if (vp.phone) await S.tapEl("#gearBtn");
  else await page.keyboard.press("Escape");
  await S.waitFor(() => document.querySelector(".menuRoot.paused"), 5000, "pause before exit");
  await S.clickText("button", "MAIN MENU");
  await S.waitFor(() => document.querySelector(".menuTitle") && !document.querySelector(".paused"), 5000, "main menu after exit");
  await sleep(300);
  await S.audit("menu-after-exit");
}

/* ---------------- camera sweep + chase pitch (desktop) ---------------- */
const CAM_NAMES = ["CHASE", "COCKPIT", "HOOD", "DASHCAM", "CONSOLE", "BACKSEAT"];
async function cameraSweep(S) {
  const { page } = S;
  console.log("\n--- camera sweep ---");
  await S.clickText("button", "DRIVE");
  await S.waitFor(() => window.__neonx?.game?.loaded && window.__neonx.game.running, 240000, "drive for cameras");
  await page.evaluate(() => {
    const n = window.__neonx;
    n.toCorridor(-180, 70, 1); // the four-lane straight
    n.setInput({ th: 0.5 });
    n.simStep(1);
  });
  for (let i = 0; i < CAM_NAMES.length; i++) {
    await page.evaluate((i) => { window.__neonx.setCam(i); window.__neonx.simStep(0.4); }, i);
    await S.waitFrames(2);
    await S.audit(`cam-${CAM_NAMES[i].toLowerCase()}`);
  }

  /* chase pitch over a standing-start launch. The deterministic trace steps
     the sim and the chase branch of updateCamera at a fixed 60 Hz; the "real"
     trace samples whatever frames the box actually renders. */
  const trace = await page.evaluate(() => {
    const n = window.__neonx, g = n.game;
    n.setInput(null);
    n.toCorridor(-200, 0, 1);
    n.setCam(0);
    const dir = new g.camera.position.constructor();
    const pitch = () => { g.camera.getWorldDirection(dir); return Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI; };
    for (let i = 0; i < 120; i++) g.updateCamera(1 / 60); // settle on the parked car
    const rows = [];
    n.setInput({ th: 1 });
    const N = 6 * 60;
    for (let i = 0; i < N; i++) {
      n.simStep(1 / 60);
      g.updateCamera(1 / 60);
      rows.push({ t: +(i / 60).toFixed(3), pitch: pitch(), camY: g.camera.position.y, carY: g.car.y, kmh: Math.abs(g.car.u) * 3.6 });
    }
    n.setInput(null);
    return rows;
  });
  const stats = (rows) => {
    let maxDown = 0, maxUp = 0, maxD = 0, sumD2 = 0, nD = 0, maxCamDy = 0;
    for (let i = 0; i < rows.length; i++) {
      maxDown = Math.min(maxDown, rows[i].pitch);
      maxUp = Math.max(maxUp, rows[i].pitch);
      if (i > 0) {
        const d = rows[i].pitch - rows[i - 1].pitch;
        maxD = Math.max(maxD, Math.abs(d)); sumD2 += d * d; nD++;
        maxCamDy = Math.max(maxCamDy, Math.abs(rows[i].camY - rows[i - 1].camY));
      }
    }
    return { samples: rows.length, restPitch: rows[0]?.pitch, maxPitchDown: maxDown, maxPitchUp: maxUp, maxFrameDelta: maxD, rmsFrameDelta: nD ? Math.sqrt(sumD2 / nD) : 0, maxCamDy };
  };
  const sim = stats(trace);
  console.log("  chase pitch (60 Hz sim):", JSON.stringify(Object.fromEntries(Object.entries(sim).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(3) : v]))));

  // real rendered frames: relaunch and sample for a wall-clock window
  await page.evaluate(() => { const n = window.__neonx; n.toCorridor(-200, 0, 1); n.setCam(0); n.setInput(null); });
  await S.waitFrames(3, 20000);
  await page.evaluate(() => window.__neonx.setInput({ th: 1 }));
  const real = [];
  const t0 = Date.now();
  let lastF = -1;
  while (Date.now() - t0 < 20000 && real.length < 400) {
    const s = await page.evaluate(() => {
      const g = window.__neonx.game;
      const d = new g.camera.position.constructor();
      g.camera.getWorldDirection(d);
      return { f: g.debug.frames, pitch: Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI, camY: g.camera.position.y, kmh: Math.abs(g.car.u) * 3.6, t: performance.now() / 1000 };
    });
    if (s.f !== lastF) { lastF = s.f; real.push(s); }
    await sleep(40);
  }
  await page.evaluate(() => window.__neonx.setInput(null));
  const rs = stats(real);
  console.log(`  chase pitch (real frames, ${real.length} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s):`,
    JSON.stringify(Object.fromEntries(Object.entries(rs).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(3) : v]))));
  const chase = { sim, real: rs, simTrace: trace, realTrace: real };
  writeFileSync(path.join(OUT, "chase-pitch.json"), JSON.stringify(chase, null, 1));
  if (sim.maxPitchDown < -25)
    addFinding(S.vpName, "cam-chase", "chase-pitch", "camera", `chase pitches down ${sim.maxPitchDown.toFixed(1)}° during launch`, sim);
  if (sim.maxFrameDelta > 0.5)
    addFinding(S.vpName, "cam-chase", "chase-jitter", "camera", `chase pitch moves up to ${sim.maxFrameDelta.toFixed(2)}°/frame at 60 Hz (rms ${sim.rmsFrameDelta.toFixed(3)}°)`, sim);
  return chase;
}

/* ---------------- mountain drive-through (desktop) ---------------- */
async function mountainDrive(S) {
  const { page } = S;
  console.log("\n--- mountain road drive-through ---");
  const info = await page.evaluate(() => {
    const g = window.__neonx.game;
    const mt = g.world.routes.mtn, c = g.terrain.corridor;
    const MTN = { divergeZ: -1968, mergeZ: -1644 };
    // the diverge node carries the real z; prefer it
    const div = g.world.routes.nodes.find((n) => n.name === "mtn-diverge");
    const mrg = g.world.routes.nodes.find((n) => n.name === "mtn-merge");
    return { len: mt.len, divergeZ: div?.mainZ ?? MTN.divergeZ, mergeZ: mrg?.mainZ ?? MTN.mergeZ, LOOP: c.LOOP, Z0: c.Z0, Z1: c.Z1 };
  });
  console.log("  route:", JSON.stringify(info));
  const startZ = info.divergeZ + info.LOOP - 160;
  await page.evaluate((z) => {
    const n = window.__neonx;
    n.setInput(null);
    n.setCam(3); // dashcam
    n.toCorridor(z, 55, 99); // rightmost lane, ahead of the seam and the gore
    n.simStep(0.2);
  }, startZ);
  await S.waitFrames(2);
  await S.audit("mtn-approach");

  const STEP = 0.1;
  const log = [];
  let phase = "deck-in", sim = 0, lastS = null, sinceProgress = 0, prev = null;
  let maxDy = 0, maxDyAt = null, resets = 0, collisions = 0, offroad = 0, completed = false, stall = null, drops = 0;
  const milestones = { entrance: false, mid: false, exit: false };
  const shotPair = async (name) => {
    await page.evaluate(() => window.__neonx.setCam(3));
    await S.waitFrames(2);
    await S.audit(`mtn-${name}-dashcam`);
    await page.evaluate(() => window.__neonx.setCam(0));
    await S.waitFrames(2);
    await S.audit(`mtn-${name}-chase`);
    await page.evaluate(() => window.__neonx.setCam(3));
  };
  for (;;) {
    const st = await page.evaluate(({ STEP, phase, info }) => {
      const n = window.__neonx, g = n.game;
      const mt = g.world.routes.mtn, c = g.terrain.corridor;
      const s0 = n.state();
      const hit = mt.project(s0.x, s0.z, 24);
      let ph = phase;
      if (ph === "deck-in" && hit && hit.s > 2 && hit.s < mt.len - 2) ph = "pass";
      if (ph === "pass" && hit && hit.s > mt.len - 5) ph = "deck-out";
      if (ph === "pass" && !hit) ph = "deck-out"; // fell off the projection window
      let tx, tz, vTarget;
      if (ph === "pass") {
        const sl = Math.min(mt.len - 0.5, hit.s + 7);
        const w = mt.worldOf(sl, mt.laneOffset(0, sl));
        tx = w.x; tz = w.z; vTarget = 42;
      } else {
        const zc = c.wrapZ ? c.wrapZ(s0.z) : s0.z;
        const zl = zc + 12;
        const nl = c.lanes(zl);
        const w = c.worldOf(zl, c.laneOffset(nl - 1, zl));
        tx = w.x; tz = w.z; vTarget = ph === "deck-in" ? 55 : 60;
      }
      let dh = Math.atan2(tx - s0.x, tz - s0.z) - s0.h;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      const kmh = s0.kmh;
      n.setInput({
        th: kmh < vTarget ? 0.8 : 0.05,
        br: kmh > vTarget + 12 ? 0.6 : 0,
        st: Math.max(-1, Math.min(1, dh * 2.4)),
      });
      const crashes0 = g.stats.crashes;
      n.simStep(STEP);
      const s1 = n.state();
      const h1 = mt.project(s1.x, s1.z, 24);
      const surf = g.world.routes.surfaceAt(s1.x, s1.z, 2);
      const deckY = c.heightAt(s1.x, s1.z, 2);
      const roadY = surf ? surf.y : deckY;
      let hw = null;
      if (h1) { const w = mt.halfWidths(h1.s); hw = { L: w.hwL, R: w.hwR }; }
      return {
        phase: ph, t: null, x: s1.x, y: s1.y, z: s1.z, h: s1.h, kmh: s1.kmh,
        s: h1 ? h1.s : null, lat: h1 ? h1.lat : null, hw,
        onMountain: s1.onMountain, surface: surf ? surf.edgeId : null, roadY, deckY,
        dy: roadY == null ? null : s1.y - roadY,
        crashes: g.stats.crashes - crashes0, slope: s1.slope,
      };
    }, { STEP, phase, info });
    sim += STEP;
    st.t = +sim.toFixed(2);
    phase = st.phase;
    if (prev) {
      const jump = Math.hypot(st.x - prev.x, st.z - prev.z);
      const stepY = Math.abs(st.y - prev.y);
      if (jump > 12) { resets++; st.reset = true; addFinding(S.vpName, "mountain", "mtn-reset", "car", `position jumped ${jump.toFixed(1)} m at t=${st.t}s (s=${f1(prev.s)})`, { t: st.t, from: [prev.x, prev.y, prev.z], to: [st.x, st.y, st.z] }); }
      else if (stepY > maxDy) { maxDy = stepY; maxDyAt = { t: st.t, s: st.s, from: prev.y, to: st.y, roadFrom: prev.roadY, roadTo: st.roadY }; }
      if (st.crashes > 0 || (prev.kmh - st.kmh > 25 && !st.reset)) {
        collisions++; st.collision = true;
        addFinding(S.vpName, "mountain", "mtn-collision", "car",
          `impact at t=${st.t}s ${st.kmh.toFixed(0)} km/h (was ${prev.kmh.toFixed(0)}) x=${f1(st.x)} y=${f2(st.y)} z=${f1(st.z)} s=${f1(st.s)} lat=${f2(st.lat)} phase=${phase}`,
          { t: st.t, crashes: st.crashes, kmhBefore: prev.kmh, kmhAfter: st.kmh });
      }
    }
    if (phase === "pass" && st.hw && st.lat != null) {
      const out = st.lat > st.hw.L + 0.8 || st.lat < -st.hw.R - 0.8;
      if (out) { offroad++; st.offroad = true; }
      if (out && offroad === 1) addFinding(S.vpName, "mountain", "mtn-offroad", "car", `left the pavement at s=${f1(st.s)} lat=${f2(st.lat)} (hw L ${f2(st.hw.L)} / R ${f2(st.hw.R)})`, { t: st.t });
    }
    if (st.dy != null && st.dy < -2) { drops++; st.drop = true; if (drops === 1) addFinding(S.vpName, "mountain", "mtn-drop", "car", `car ${(-st.dy).toFixed(1)} m below the road at t=${st.t}s s=${f1(st.s)} x=${f1(st.x)} z=${f1(st.z)}`, { t: st.t, y: st.y, roadY: st.roadY }); }
    log.push(st);
    if (log.length % 50 === 0)
      console.log(`  t=${st.t.toFixed(1)}s ${phase} kmh=${st.kmh.toFixed(0)} s=${f1(st.s)} lat=${f2(st.lat)} y=${f2(st.y)} dy=${f2(st.dy)} z=${f1(st.z)}`);

    // milestones → photographs
    if (phase === "pass" && st.s != null) {
      if (!milestones.entrance && st.s > 8) { milestones.entrance = true; await shotPair("entrance"); }
      if (!milestones.mid && st.s > info.len / 2) { milestones.mid = true; await shotPair("mid"); }
      if (!milestones.exit && st.s > info.len - 30) { milestones.exit = true; await shotPair("exit"); }
    }
    // progress: arclength on the pass, z on the deck
    const prog = st.s != null && phase === "pass" ? st.s : st.z;
    if (lastS === null || Math.abs(prog - lastS) > 0.3) { lastS = prog; sinceProgress = 0; }
    else if ((sinceProgress += STEP) > 5) {
      stall = st;
      break;
    }
    if (phase === "deck-out" && st.z > info.mergeZ + 40 && st.deckY != null && Math.abs(st.y - st.deckY) < 1.5) { completed = true; break; }
    if (sim > 110) break;
    prev = st;
  }
  await page.evaluate(() => window.__neonx.setInput(null));

  let stallInfo = null;
  if (stall) {
    stallInfo = await page.evaluate(({ x, z }) => {
      const n = window.__neonx, g = n.game, c = g.terrain.corridor;
      const near = n.collidersNear(x, z);
      const r = (v) => Math.round(v * 100) / 100;
      return {
        lat: c.latAt(x, z), halfWidth: c.halfWidth(c.wrapZ ? c.wrapZ(z) : z),
        apronW: g.world.routes.apronW ? g.world.routes.apronW(c.wrapZ ? c.wrapZ(z) : z) : null,
        aabbs: near.aabbs.slice(0, 6).map((a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === "number" ? r(v) : v]))),
        obbs: near.obbs.slice(0, 6).map((o) => ({ x: r(o.x), z: r(o.z), hw: r(o.hw), hd: r(o.hd), y0: r(o.y0), y1: r(o.y1) })),
      };
    }, stall);
    addFinding(S.vpName, "mountain", "mtn-stall", "car",
      `stalled (no progress for 5 s sim) in phase ${stall.phase} at t=${stall.t}s: x=${f1(stall.x)} y=${f2(stall.y)} z=${f1(stall.z)} s=${f1(stall.s)} lat=${f2(stall.lat)} kmh=${stall.kmh.toFixed(0)} deck-lat=${f2(stallInfo.lat)} halfWidth=${f2(stallInfo.halfWidth)}`,
      { stall, near: stallInfo });
    await S.waitFrames(2);
    await shotPair("stall");
  }
  if (!completed && !stall)
    addFinding(S.vpName, "mountain", "mtn-incomplete", "car", `pass not completed within ${sim.toFixed(0)} s sim (phase ${phase}, s=${f1(log.at(-1)?.s)}, z=${f1(log.at(-1)?.z)})`);
  if (maxDy > 0.6)
    addFinding(S.vpName, "mountain", "mtn-height-step", "car", `max height step ${maxDy.toFixed(2)} m in ${STEP}s at s=${f1(maxDyAt?.s)}`, maxDyAt);
  // any milestone photograph the drive never reached: stage it so the report has the view
  for (const [k, s] of [["entrance", 12], ["mid", info.len / 2], ["exit", info.len - 30]]) {
    if (milestones[k]) continue;
    await page.evaluate((s) => { const n = window.__neonx; n.toMountain(s, 30, 0); n.setInput({ th: 0.2 }); n.simStep(0.3); n.setInput(null); }, s);
    await shotPair(k + "-staged");
  }
  const result = {
    completed, stall: stall ? { t: stall.t, phase: stall.phase, x: stall.x, y: stall.y, z: stall.z, s: stall.s, lat: stall.lat, kmh: stall.kmh, near: stallInfo } : null,
    simSeconds: +sim.toFixed(1), resets, collisions, offroadSteps: offroad, dropSteps: drops,
    maxHeightStep: { m: +maxDy.toFixed(3), perStep: STEP, at: maxDyAt }, route: info, steps: log,
  };
  writeFileSync(path.join(OUT, "mountain-log.json"), JSON.stringify(result, null, 1));
  console.log(`  mountain: completed=${completed} stall=${stall ? `${stall.phase}@t=${stall.t}s s=${f1(stall.s)}` : "no"} resets=${resets} collisions=${collisions} offroad=${offroad} drops=${drops} maxΔy=${maxDy.toFixed(2)} m/step sim=${sim.toFixed(1)} s`);
  return result;
}

/* ---------------- report ---------------- */
function writeReport(extra) {
  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity !== "error");
  const lines = [];
  lines.push(`# UI QA walkthrough — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Viewports: ${VIEWPORTS.join(", ")} · findings: **${errors.length} error(s)**, ${warns.length} warning(s) · screenshots: ${shots.length}`);
  lines.push("");
  for (const vp of VIEWPORTS) {
    const e = errors.filter((f) => f.viewport === vp), w = warns.filter((f) => f.viewport === vp);
    lines.push(`## ${vp} — ${e.length} error(s), ${w.length} warning(s)`);
    lines.push("");
    const byRule = {};
    for (const f of findings.filter((f) => f.viewport === vp)) (byRule[f.rule] ||= []).push(f);
    for (const [rule, fs] of Object.entries(byRule).sort((a, b) => (SEVERITY[a[0]] === "error" ? 0 : 1) - (SEVERITY[b[0]] === "error" ? 0 : 1))) {
      lines.push(`### ${rule} (${SEVERITY[rule]}) — ${fs.length}`);
      lines.push("");
      lines.push("| screen | element | detail | numbers |");
      lines.push("|---|---|---|---|");
      for (const f of fs.slice(0, 60)) {
        const nums = Object.entries(f.nums || {}).filter(([, v]) => typeof v !== "object").map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(2) : v}`).join(" ");
        lines.push(`| ${f.screen} | \`${f.sel}\` | ${String(f.text).replace(/\|/g, "\\|").slice(0, 120)} | ${nums.slice(0, 120)} |`);
      }
      if (fs.length > 60) lines.push(`| … | ${fs.length - 60} more | | |`);
      lines.push("");
    }
    lines.push("Screenshots:");
    lines.push("");
    for (const s of shots.filter((s) => s.viewport === vp)) lines.push(`- ${s.screen}: \`${s.file}\``);
    lines.push("");
  }
  if (extra.mountain) {
    const m = extra.mountain;
    lines.push("## Mountain road drive-through");
    lines.push("");
    lines.push(`- completed: **${m.completed}** · sim time ${m.simSeconds} s · resets ${m.resets} · collisions ${m.collisions} · off-road steps ${m.offroadSteps} · below-road steps ${m.dropSteps}`);
    lines.push(`- max height step: ${m.maxHeightStep.m} m per ${m.maxHeightStep.perStep} s${m.maxHeightStep.at ? ` at s=${f1(m.maxHeightStep.at.s)} (y ${f2(m.maxHeightStep.at.from)} → ${f2(m.maxHeightStep.at.to)}, road ${f2(m.maxHeightStep.at.roadFrom)} → ${f2(m.maxHeightStep.at.roadTo)})` : ""}`);
    if (m.stall) {
      lines.push(`- **stall**: phase ${m.stall.phase} at t=${m.stall.t}s, x=${f1(m.stall.x)} y=${f2(m.stall.y)} z=${f1(m.stall.z)} s=${f1(m.stall.s)} lat=${f2(m.stall.lat)} ${m.stall.kmh.toFixed(0)} km/h`);
      if (m.stall.near) {
        lines.push(`  - deck-frame lat ${f2(m.stall.near.lat)} (deck half-width ${f2(m.stall.near.halfWidth)}${m.stall.near.apronW != null ? `, apron ${f2(m.stall.near.apronW)}` : ""})`);
        lines.push(`  - colliders near: ${m.stall.near.aabbs.length} AABB, ${m.stall.near.obbs.length} OBB`);
        for (const a of m.stall.near.aabbs) lines.push(`    - AABB ${JSON.stringify(a)}`);
        for (const o of m.stall.near.obbs) lines.push(`    - OBB ${JSON.stringify(o)}`);
      }
    }
    lines.push(`- log: \`${path.join(OUT, "mountain-log.json")}\``);
    lines.push("");
  }
  if (extra.chase) {
    const c = extra.chase;
    const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(3) : v}`).join(" · ");
    lines.push("## Chase camera pitch, standing-start launch");
    lines.push("");
    lines.push(`- 60 Hz sim trace: ${fmt(c.sim)}`);
    lines.push(`- real rendered frames: ${fmt(c.real)}`);
    lines.push(`- trace: \`${path.join(OUT, "chase-pitch.json")}\``);
    lines.push("");
  }
  writeFileSync(path.join(OUT, "report.md"), lines.join("\n"));
  writeFileSync(path.join(OUT, "findings.json"), JSON.stringify({ when: new Date().toISOString(), viewports: VIEWPORTS, findings, shots, mountain: extra.mountain ? { ...extra.mountain, steps: undefined } : null, chase: extra.chase ? { sim: extra.chase.sim, real: extra.chase.real } : null }, null, 1));
}

function printTable() {
  console.log("\n=== findings ===");
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(pad("viewport", 11) + pad("screen", 22) + pad("rule", 16) + pad("sev", 8) + pad("element", 34) + "detail / numbers");
  const order = (f) => (f.severity === "error" ? 0 : 1);
  for (const f of [...findings].sort((a, b) => order(a) - order(b) || a.viewport.localeCompare(b.viewport) || a.screen.localeCompare(b.screen))) {
    const nums = Object.entries(f.nums || {}).filter(([, v]) => typeof v !== "object").map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(1) : v}`).join(" ");
    console.log(pad(f.viewport, 11) + pad(f.screen, 22) + pad(f.rule, 16) + pad(f.severity, 8) + pad(f.sel, 34) + (f.text ? f.text.slice(0, 70) + " " : "") + nums.slice(0, 80));
  }
}

/* ---------------- main ---------------- */
async function main() {
  const { url, child } = await startDev();
  const cleanup = () => killDev(child);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
  let browser;
  const extra = {};
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
        "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", "--window-size=1440,900",
      ],
      protocolTimeout: 600000,
    });
    for (const vpName of VIEWPORTS) {
      const vp = VIEWPORTS_ALL[vpName];
      // an isolated context per viewport: the profile in localStorage must not
      // carry the settings one pass changed into the next
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      if (vp.phone) {
        await page.setUserAgent(IPHONE_UA);
        await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      } else {
        await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
      }
      const S = new Session(page, vpName, vp);
      try {
        await walkthrough(S, url);
        if (!vp.phone) {
          if (!SKIP_CAMS) { try { extra.chase = await cameraSweep(S); } catch (e) { addFinding(vpName, "cameras", "walk", "cameraSweep", String(e.message).slice(0, 300)); console.log("  camera sweep failed:", e.message); } }
          if (!SKIP_MTN) {
            try {
              if (SKIP_CAMS) { await S.clickText("button", "DRIVE"); await S.waitFor(() => window.__neonx?.game?.loaded && window.__neonx.game.running, 240000, "drive for mountain"); }
              extra.mountain = await mountainDrive(S);
            } catch (e) { addFinding(vpName, "mountain", "walk", "mountainDrive", String(e.message).slice(0, 300)); console.log("  mountain drive failed:", e.message); }
          }
        }
      } catch (e) {
        addFinding(vpName, S.screen, "walk", "walkthrough", String(e.message).slice(0, 300));
        console.log("  ⛔ walkthrough aborted:", e.message);
        try { await S.shot("aborted"); } catch {}
      }
      const pageErrs = await page.evaluate(() => window.__neonx?.state?.().errors ?? []).catch(() => []);
      for (const e of pageErrs) addFinding(vpName, "engine", "g-console", "__neonx.errors", String(e).slice(0, 300));
      await ctx.close().catch(() => {});
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    cleanup();
  }
  printTable();
  writeReport(extra);
  const hard = findings.filter((f) => f.severity === "error");
  console.log(`\nreport: ${path.join(OUT, "report.md")}\nfindings: ${path.join(OUT, "findings.json")}\nshots: ${path.join(OUT, "shots")}`);
  if (hard.length) {
    console.log(`\n❌ ${hard.length} hard finding(s) (rules a/b/d/g, touch-layout, walk, mtn-*)`);
    process.exit(1);
  }
  console.log(`\n✅ UI QA clean (${findings.length} warning(s))`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
