/* scratch: verify the POV shield rects + capture head-unit zooms, A/B */
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
const OUT = process.argv[2] || "/tmp/shots";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const browser = await puppeteer.launch({ headless: true,
  args: ["--enable-unsafe-swiftshader","--use-gl=angle","--use-angle=swiftshader","--no-sandbox","--disable-dev-shm-usage","--mute-audio"],
  defaultViewport: { width: 1280, height: 800 }, protocolTimeout: 300000 });
const page = await browser.newPage();
page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e.message||e).slice(0,300)));
page.on("console", (m) => { if (m.type()==="error" && !m.text().includes("favicon") && !m.text().includes("WebSocket")) errs.push("CONSOLE: " + m.text().slice(0,300)); });
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 60000 });
await page.evaluate(() => { window.__neonx.game.load(() => {}); });
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 240000 });
await page.evaluate(() => { const b=[...document.querySelectorAll("button")].find(x=>x.textContent.includes("DRIVE")); b?.click(); });
await sleep(2500);
const dump = () => {
  const g = window.__neonx.game, u = g.post.povMat.uniforms, m = g.post.mbMat.uniforms;
  const r = (a) => a.map(v => [ +v.x.toFixed(3), +v.y.toFixed(3) ]);
  return { cam: g.camMode,
    povMin: r(u.uPanMin.value), povMax: r(u.uPanMax.value), povStr: u.uPanStr.value.slice(),
    mbMin: r(m.uPanMin.value), mbStr: m.uPanStr.value.slice(),
    donorScreen: !!g.rig.cockpit.donorScreen,
    panelIsDonor: g.rig.cockpit.navPanel() === g.rig.cockpit.donorScreen };
};
const CLIP = { x: 836, y: 508, width: 210, height: 250 };
await page.evaluate(() => { const nx = window.__neonx; nx.toCorridor(-1300, 100, 1); nx.setInput({ th: 0.4 }); nx.setCam(3); });
await sleep(2500);
console.log("POV  :", JSON.stringify(await page.evaluate(dump)));
await page.screenshot({ path: path.join(OUT, "pov-full.png") });
await page.screenshot({ path: path.join(OUT, "pov-zoom-on.png"), clip: CLIP });
await page.evaluate(() => { window.__povTune.screenShield = 0; });
await sleep(1500);
await page.screenshot({ path: path.join(OUT, "pov-zoom-off.png"), clip: CLIP });
await page.evaluate(() => { window.__povTune.screenShield = 0.92; });
await page.evaluate(() => window.__neonx.setCam(0));
await sleep(1200);
console.log("CHASE:", JSON.stringify(await page.evaluate(dump)));
await page.evaluate(() => { window.__neonx.setCam(3); window.__neonx.game.rig.cockpitModel?.setActive(false); });
await sleep(2000);
console.log("POV/procedural:", JSON.stringify(await page.evaluate(dump)));
await page.screenshot({ path: path.join(OUT, "pov-procedural.png") });
await browser.close();
for (const e of errs.slice(0,10)) console.log(e);
console.log("errors:", errs.length);
