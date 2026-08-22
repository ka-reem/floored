import puppeteer from "puppeteer";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true,
  args: ["--enable-unsafe-swiftshader","--use-gl=angle","--use-angle=swiftshader","--no-sandbox","--disable-dev-shm-usage","--mute-audio"],
  defaultViewport: { width: 1280, height: 800 }, protocolTimeout: 300000 });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e.message||e).slice(0,400)));
page.on("console", (m) => { if (m.type()==="error") console.log("CONSOLE.ERR:", m.text().slice(0,400)); });
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 60000 });
await page.evaluate(() => {
  window.__pr = { s: [], done: false, err: null };
  window.__neonx.game.load((r) => window.__pr.s.push(r.label + " " + r.frac))
    .then(() => window.__pr.done = true).catch(e => window.__pr.err = String(e && e.stack || e).slice(0,500));
});
for (let i=0;i<20;i++){
  await sleep(8000);
  const p = await page.evaluate(() => ({ last: window.__pr.s.at(-1), n: window.__pr.s.length, done: window.__pr.done, err: window.__pr.err }));
  console.log(i*8+"s", JSON.stringify(p));
  if (p.done || p.err) break;
}
await browser.close();
