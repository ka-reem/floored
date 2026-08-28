/* Interaction sweep probe (desktop 1440x900, mouse). Audits click routing:
   head-unit panel (map/music/trip), dome light, hazards, signals, menus. */
import puppeteer from "puppeteer";

const URL = process.env.URL || "http://localhost:3101";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (o) => { results.push(o); console.log("RES " + JSON.stringify(o)); };

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    "--window-size=1440,900",
  ],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERR", String(e.message || e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") console.log("CONS-ERR", m.text().slice(0, 200)); });

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await sleep(400);

/* ---------- menu phase ---------- */
const menuButtons = await page.evaluate(() =>
  [...document.querySelectorAll("button")].map((b) => {
    const r = b.getBoundingClientRect();
    return { text: b.textContent.trim().slice(0, 40), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })
);
log({ phase: "menu", buttons: menuButtons });

async function realClick(x, y) {
  await page.mouse.move(x - 8, y - 8);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}
async function clickButtonByText(t) {
  const b = await page.evaluate((tt) => {
    const el = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(tt));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, vis: r.width > 0 && r.height > 0 };
  }, t);
  if (!b || !b.vis) return { found: false };
  await realClick(b.x, b.y);
  await sleep(300);
  return { found: true, at: [Math.round(b.x), Math.round(b.y)] };
}
const pageText = () => page.evaluate(() => document.body.innerText.slice(0, 3000));

// GARAGE
{
  const c = await clickButtonByText("GARAGE");
  const txt = await pageText();
  log({ probe: "menu.garage", click: c, sawGarage: /GARAGE/.test(txt) && /DONE/.test(txt) });
  // garage arrows / car select: enumerate clickable car cells
  const cells = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".garage *")].filter((e) => e.onclick || e.getAttribute("role") === "button");
    return els.length;
  });
  log({ probe: "menu.garage.cells", clickableCells: cells });
  // try selecting the second car if present
  const sel = await page.evaluate(() => {
    const root = document.body;
    const cards = [...root.querySelectorAll("div,li")].filter((e) => /SELECTED|SELECT|LOCKED/.test(e.textContent) && e.textContent.length < 200);
    return cards.slice(0, 6).map((e) => e.textContent.trim().slice(0, 60));
  });
  log({ probe: "menu.garage.cards", sample: sel });
  await clickButtonByText("DONE");
}
// SETTINGS spot checks
{
  const c = await clickButtonByText("SETTINGS");
  await sleep(300);
  const controls = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("select, input")].map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.closest("label,li,div")?.textContent?.trim().slice(0, 50) || "";
      return {
        tag: el.tagName, type: el.type || "", label,
        value: el.tagName === "SELECT" ? el.value : el.type === "checkbox" ? String(el.checked) : el.value,
        x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, visible: r.width > 0,
      };
    });
    return rows;
  });
  log({ probe: "menu.settings.controls", count: controls.length, sawSettings: /SETTINGS/.test(await pageText()) });
  // toggle up to 10 checkboxes/selects via real mouse and verify value change
  const toggles = [];
  for (const ctl of controls.filter((c2) => c2.visible).slice(0, 12)) {
    if (ctl.type === "checkbox") {
      await realClick(ctl.x, ctl.y);
      await sleep(120);
      const after = await page.evaluate((lx, ly) => {
        const el = document.elementFromPoint(lx, ly);
        const box = el && (el.matches("input") ? el : el.querySelector("input"));
        return box ? String(box.checked) : "?";
      }, ctl.x, ctl.y);
      toggles.push({ label: ctl.label, before: ctl.value, after, changed: after !== "?" && after !== ctl.value });
      await realClick(ctl.x, ctl.y); // restore
      await sleep(80);
    }
  }
  log({ probe: "menu.settings.toggles", toggles });
  await clickButtonByText("DONE");
  await clickButtonByText("BACK");
}
// CONTROLS
{
  const c = await clickButtonByText("CONTROLS");
  const txt = await pageText();
  log({ probe: "menu.controls", click: c, sawControls: /CONTROLS/.test(txt) });
  await clickButtonByText("BACK");
}

/* ---------- drive ---------- */
await clickButtonByText("DRIVE");
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 300000 });
await sleep(1000);

const baseInfo = await page.evaluate(() => {
  const g = window.__neonx.game;
  return {
    camMode: g.camMode, isTouch: g.isTouch, musicEnabled: g.music.enabled,
    running: g.running, loaded: g.loaded,
    cockpitModel: !!g.rig?.cockpitModel,
    donorScreen: !!g.rig?.cockpit?.donorScreen,
    scrMeshVisible: g.rig?.cockpit?.screenMesh?.visible,
    navPanelName: g.rig?.cockpit?.navPanel()?.name || "(procedural)",
    screenView: g.screenView,
    frames: g.debug?.frames,
  };
});
log({ phase: "driveBoot", ...baseInfo });

async function waitFrames(n = 2, timeout = 60000) {
  const f0 = await page.evaluate(() => window.__neonx.game.debug.frames);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = await page.evaluate(() => window.__neonx.game.debug.frames);
    if (f >= f0 + n) return true;
    await sleep(300);
  }
  return false;
}

/* Scan the canvas with the engine's own ray to build a client-px -> panel-px
   map for an arbitrary target object. */
async function scanObject(kind) {
  return await page.evaluate((kk) => {
    const g = window.__neonx.game;
    const cv = g.renderer.domElement;
    const r = cv.getBoundingClientRect();
    let obj = null;
    if (kk === "panel") obj = g.screenTarget();
    else if (kk === "dome") obj = g.cabinTarget(false);
    else if (kk === "hazard") obj = g.wheelTarget("hazard");
    else if (kk === "sigL") obj = g.wheelTarget && g.wheelTarget("l");
    else if (kk === "sigR") obj = g.wheelTarget && g.wheelTarget("r");
    if (!obj) return { obj: false };
    const hits = [];
    const step = 10;
    for (let y = r.top + 2; y < r.bottom - 2; y += step) {
      for (let x = r.left + 2; x < r.right - 2; x += step) {
        g.aimRayAt(x, y);
        const h = g.clickRay.intersectObject(obj, true)[0];
        if (h) hits.push({ x, y, u: h.uv ? h.uv.x : null, v: h.uv ? h.uv.y : null });
      }
    }
    return { obj: true, n: hits.length, hits: hits.slice(0, 4000) };
  }, kind);
}

/* find client coords whose engine-ray uv lands nearest a panel-canvas px */
function nearestTo(hits, px, py) {
  let best = null, bd = 1e9;
  for (const h of hits) {
    if (h.u == null) continue;
    const hx = h.u * 256, hy = (1 - h.v) * 160;
    const d = (hx - px) ** 2 + (hy - py) ** 2;
    if (d < bd) { bd = d; best = { ...h, panelX: hx, panelY: hy, dist: Math.sqrt(d) }; }
  }
  return best;
}

async function refine(x0, y0, px, py) {
  return await page.evaluate((x1, y1, tx, ty) => {
    const g = window.__neonx.game;
    const panel = g.screenTarget();
    if (!panel) return null;
    let best = null, bd = 1e9;
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
      const x = x1 + dx, y = y1 + dy;
      g.aimRayAt(x, y);
      const h = g.clickRay.intersectObject(panel, false)[0];
      if (!h || !h.uv) continue;
      const hx = h.uv.x * 256, hy = (1 - h.uv.y) * 160;
      const d = (hx - tx) ** 2 + (hy - ty) ** 2;
      if (d < bd) { bd = d; best = { x, y, panelX: hx, panelY: hy, dist: Math.sqrt(d) }; }
    }
    return best;
  }, x0, y0, px, py);
}

const getView = () => page.evaluate(() => window.__neonx.game.screenView);
const setView = (v) => page.evaluate((vv) => { window.__neonx.game.screenView = vv; }, v);
const getToast = () => page.evaluate(() => document.getElementById("toast")?.textContent || "");
const elAt = (x, y) => page.evaluate((a, b) => {
  const e = document.elementFromPoint(a, b);
  return e ? e.tagName + (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : "") : "none";
}, x, y);

for (const cam of [4, 3]) { // CONSOLE, then DASHCAM (POV)
  await page.evaluate((c) => window.__neonx.setCam(c), cam);
  await waitFrames(2);
  const camName = cam === 4 ? "CONSOLE" : "DASHCAM";
  const scan = await scanObject("panel");
  if (!scan.obj || !scan.n) {
    log({ probe: `panel.${camName}`, error: "no panel target or no ray hits", obj: scan.obj, n: scan.n || 0 });
    continue;
  }
  const uvNull = scan.hits.filter((h) => h.u == null).length;
  const corners = {
    minPX: Math.min(...scan.hits.map((h) => h.u * 256)), maxPX: Math.max(...scan.hits.map((h) => h.u * 256)),
    minPY: Math.min(...scan.hits.map((h) => (1 - h.v) * 160)), maxPY: Math.max(...scan.hits.map((h) => (1 - h.v) * 160)),
  };
  log({ probe: `panel.${camName}.scan`, rayHits: scan.n, uvNull, panelPxRange: corners });

  // targets in panel px
  const targets = {
    backMAP: [35, 16],       // BACK center (8..62 x 7..25)
    pill2TRIP: [203, 14],    // PILL2 center (190..216 x 6..22)
    pillMusic: [235, 14],    // PILL center
    center: [128, 80],
    toggle: [183, 135],      // BTN_X[1]=166 +17, BTN_Y=118 +17
    prev: [141, 135],
    next: [225, 135],
    volMinus: [132, 98],
    volPlus: [236, 98],
  };
  const found = {};
  for (const [name, [px, py]] of Object.entries(targets)) {
    const near = nearestTo(scan.hits, px, py);
    if (!near) { found[name] = null; continue; }
    const fine = await refine(near.x, near.y, px, py);
    found[name] = fine && fine.dist < 4 ? fine : { ...near, coarse: true };
  }
  log({ probe: `panel.${camName}.targets`, found: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v && { x: Math.round(v.x), y: Math.round(v.y), panelX: +v.panelX?.toFixed(1), panelY: +v.panelY?.toFixed(1), dist: +v.dist?.toFixed(1), coarse: !!v.coarse }])) });

  async function clickCase(name, view, target, expectView, extra) {
    await setView(view);
    const t = found[target];
    if (!t) { log({ probe: `click.${camName}.${name}`, error: "target unreachable on screen" }); return; }
    const el = await elAt(t.x, t.y);
    const before = await getView();
    await realClick(t.x, t.y);
    await sleep(250);
    const after = await getView();
    const toast = await getToast();
    const o = { probe: `click.${camName}.${name}`, at: [Math.round(t.x), Math.round(t.y)], panelPx: [t.panelX, t.panelY], domTarget: el, viewBefore: before, viewAfter: after, toast };
    if (expectView) o.pass = after === expectView;
    if (extra) Object.assign(o, await page.evaluate(extra));
    log(o);
  }

  // PRIORITY 1: music view -> "MAP" back button
  await clickCase("musicToMap_OWNER_BUG", "music", "backMAP", "map");
  await clickCase("tripToMap", "trip", "backMAP", "map");
  await clickCase("mapToMusic_center", "map", "center", "music");
  await clickCase("mapToTrip_pill2", "map", "pill2TRIP", "trip");
  await clickCase("mapToMusic_pill", "map", "pillMusic", "music");
  // transport
  await setView("music");
  const musicState0 = await page.evaluate(() => ({ wanted: window.__neonx.game.music.wanted, cabinVol: window.__neonx.game.music.cabinVol }));
  await clickCase("music_toggle", "music", "toggle", null);
  const musicState1 = await page.evaluate(() => ({ wanted: window.__neonx.game.music.wanted, cabinVol: window.__neonx.game.music.cabinVol }));
  await clickCase("music_volUp", "music", "volPlus", null);
  const musicState2 = await page.evaluate(() => ({ wanted: window.__neonx.game.music.wanted, cabinVol: window.__neonx.game.music.cabinVol }));
  log({ probe: `music.${camName}.state`, s0: musicState0, s1: musicState1, s2: musicState2 });
}

/* ---------- dome light / hazards / signals (in CONSOLE cam) ---------- */
await page.evaluate(() => window.__neonx.setCam(4));
await waitFrames(2);
for (const kind of ["dome", "hazard", "sigL", "sigR"]) {
  const scan = await scanObject(kind);
  if (!scan.obj) { log({ probe: `cabin.${kind}`, targetExists: false }); continue; }
  if (!scan.n) { log({ probe: `cabin.${kind}`, targetExists: true, rayHits: 0, note: "no screen pixel reaches it in CONSOLE cam" }); continue; }
  // centroid of hit zone
  const cx = scan.hits.reduce((a, h) => a + h.x, 0) / scan.hits.length;
  const cy = scan.hits.reduce((a, h) => a + h.y, 0) / scan.hits.length;
  const before = await page.evaluate(() => {
    const g = window.__neonx.game;
    return { dome: g.cabinKnob().on, sigL: g.car.sigL, sigR: g.car.sigR };
  });
  await realClick(cx, cy);
  await sleep(250);
  const after = await page.evaluate(() => {
    const g = window.__neonx.game;
    return { dome: g.cabinKnob().on, sigL: g.car.sigL, sigR: g.car.sigR };
  });
  const toast = await getToast();
  log({ probe: `cabin.${kind}`, targetExists: true, rayHits: scan.n, clickAt: [Math.round(cx), Math.round(cy)], before, after, toast });
  // reset hazards/signals
  await page.evaluate(() => { const g = window.__neonx.game; g.car.sigL = false; g.car.sigR = false; });
}

/* ---------- pause menu ---------- */
await page.keyboard.press("Escape");
await sleep(500);
const pauseButtons = await page.evaluate(() =>
  [...document.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().width > 0)
    .map((b) => b.textContent.trim().slice(0, 30))
);
log({ probe: "pause.buttons", pauseButtons, running: await page.evaluate(() => window.__neonx.game.running) });
const r1 = await clickButtonByText("RESUME");
await sleep(300);
log({ probe: "pause.resume", click: r1, running: await page.evaluate(() => window.__neonx.game.running) });

await browser.close();
console.log("DONE");
