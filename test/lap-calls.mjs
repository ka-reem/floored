/* Draw-call meter for the map-transform lane: parks the car at a handful of
   fixed z stations (the same ones before and after), lets the renderer run,
   and reads renderer.info accumulated across whole frames — autoReset off,
   reset at a frame boundary, sampled a few frames later and divided by the
   frames elapsed. The per-render info the screenshot tour logs only ever sees
   the composite pass (1 call), which is useless as a budget number.

   Usage: node test/lap-calls.mjs --url http://localhost:3000 [--label before]
*/
import puppeteer from "puppeteer";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3000");
const LABEL = arg("--label", "run");

const STATIONS = [-1800, -1300, -900, -400, 160, 420, 700, 1100, 1450, 1850];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(4000);

console.log(`label=${LABEL}`);
for (const z of STATIONS) {
  await page.evaluate((z) => {
    const nx = window.__neonx;
    nx.toCorridor(z, 0);
    nx.setInput({ th: 0, br: 1 });
    nx.game.renderer.info.autoReset = false;
  }, z);
  await sleep(2500); // let culling settle at the new position
  const r = await page.evaluate(async () => {
    const nx = window.__neonx;
    const info = nx.game.renderer.info;
    // reset at a frame boundary, accumulate N whole frames, divide
    await new Promise((res) => requestAnimationFrame(res));
    info.reset();
    const f0 = nx.state().frames;
    const N = 3;
    await new Promise((res) => {
      const poll = () =>
        nx.state().frames >= f0 + N ? res() : setTimeout(poll, 120);
      poll();
    });
    const frames = nx.state().frames - f0;
    return {
      calls: Math.round(info.render.calls / frames),
      tris: Math.round(info.render.triangles / frames),
      frames,
    };
  });
  console.log(`  z=${z} calls/frame=${r.calls} tris/frame=${r.tris} (over ${r.frames} frames)`);
}
await browser.close();
console.log("done");
