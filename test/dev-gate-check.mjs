/* The developer-settings gate, end to end.

   Three settings rows are not in a public build (lib/build.ts's
   SHOW_DEV_SETTINGS): device tier, imported cabin and test mode. Hiding a
   control is only safe if the value behind it stops applying too — otherwise
   a player who once forced `mobile-base`, or left test mode on, is stuck in a
   state with nothing on screen to undo it. And it is only reversible if the
   stored value is left ALONE, so `?debug=1` still shows what the developer
   set. This script proves both against the real page, plus:

     - the public settings screen shows the 13 rows it is supposed to and none
       of the developer three, and ADVANCED holds the other 7;
     - clicking the graphics preset a fresh profile is ALREADY on changes
       nothing — defaultSettings() and applyPresetDefaults() have to agree
       about what HIGH means (they disagreed about motion blur once).

   The gate is evaluated per page load from the URL, so `?debug=0` on a dev
   server is exactly the public build's answer and this needs no production
   build to run.

   Usage: node test/dev-gate-check.mjs --url http://localhost:3161 */
import puppeteer from "puppeteer";

const a = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const URL_ = a("--url", "http://localhost:3161");
const KEY = "neonx.profile.v3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fails = [];
const ok = [];
const check = (cond, what) => (cond ? ok : fails).push(what);

/* what a developer left behind before the flag went off */
const SEEDED = { tierOverride: "mobile-base", cabin: "donor", testMode: true, vol: 0.5 };

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  protocolTimeout: 400000,
});

async function open_(debug, seed) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument((k, s) => {
    try {
      localStorage.clear();
      if (s) localStorage.setItem(k, JSON.stringify({ settings: s }));
    } catch { /* ignore */ }
  }, KEY, seed);
  await page.goto(`${URL_}/?debug=${debug}`, { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForFunction(() => document.querySelector(".sign-row"), { timeout: 300000 });
  await sleep(800);
  return page;
}
const clickText = async (page, t) => {
  await page.evaluate((x) => {
    const b = [...document.querySelectorAll("button")].find((e) => (e.textContent || "").trim().includes(x));
    b?.click();
  }, t);
  await sleep(500);
};
const rowNames = (page) =>
  page.$$eval(".sign-body > .sign-cols .sign-srow .name", (ns) => ns.map((n) => n.firstChild?.textContent?.trim() || ""));
const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), KEY);

/* ---------- 1. the public build ---------- */
{
  const page = await open_(0, SEEDED);
  await clickText(page, "SETTINGS");
  const names = await rowNames(page);
  for (const n of ["Device tier", "Imported cabin", "Test mode"])
    check(!names.includes(n), `public build hides "${n}"`);
  for (const n of ["Traction control", "Rival car", "Clean run", "Speed units", "Traffic density",
    "Time of day", "Day/night cycle", "Rain", "Volume", "Graphics quality", "Field of view", "Dashcam filter"])
    check(names.includes(n), `public build keeps "${n}"`);
  check(names.length === 13, `public screen is 13 rows (saw ${names.length}: ${names.join(", ")})`);

  /* the stored developer values are IGNORED, not honoured */
  const live = await page.evaluate(() => ({
    tier: window.__neonx?.game?.renderTier,
    test: window.__neonx?.game?.testMode,
  }));
  check(live.tier !== "mobile-base", `stored tierOverride is ignored (tier resolved to ${live.tier})`);
  check(live.test === false, "stored testMode resolves false with no row to turn it off");

  /* ADVANCED holds the other seven, in place */
  await clickText(page, "ADVANCED");
  const adv = await page.$$eval(".sign-adv .sign-srow .name", (ns) => ns.map((n) => n.firstChild?.textContent?.trim()));
  for (const n of ["Draw distance", "Motion blur", "Fog / haze", "Rival indicators", "First-run hints",
    "New town", "Reset everything"])
    check(adv.includes(n), `ADVANCED holds "${n}"`);
  check((await rowNames(page)).length === 13, "the public set stays on screen while ADVANCED is open");

  /* change something and leave: the panel writes the profile on DONE */
  await page.click(".sign-adv .sign-toggle");
  await sleep(200);
  await clickText(page, "DONE");
  await sleep(400);
  const p = await stored(page);
  check(p?.settings?.tierOverride === "mobile-base", "tierOverride survives a public-build save");
  check(p?.settings?.cabin === "donor", "cabin survives a public-build save");
  check(p?.settings?.testMode === true, "testMode survives a public-build save");
  check(p?.settings?.mblur === true, "the ADVANCED row the test flipped was saved (proof the save ran)");
  await page.close();
}

/* ---------- 2. the same profile behind ?debug=1 ---------- */
{
  const page = await open_(1, SEEDED);
  await clickText(page, "SETTINGS");
  const names = await rowNames(page);
  for (const n of ["Device tier", "Imported cabin", "Test mode"])
    check(names.includes(n), `?debug=1 shows "${n}"`);
  const vals = await page.evaluate(() => ({
    tier: document.querySelector('select[aria-label="Device tier"]')?.value,
    cabin: document.querySelector('select[aria-label="Imported cabin"]')?.value,
    test: document.querySelector('input[aria-label="Test mode"]')?.checked,
    liveTier: window.__neonx?.game?.renderTier,
    liveTest: window.__neonx?.game?.testMode,
  }));
  check(vals.tier === "mobile-base", `device tier reads back as the developer left it (${vals.tier})`);
  check(vals.cabin === "donor", `imported cabin reads back as the developer left it (${vals.cabin})`);
  check(vals.test === true, "test mode reads back as the developer left it");
  check(vals.liveTier === "mobile-base", "…and applies: the override is honoured behind ?debug=1");
  check(vals.liveTest === true, "…and applies: test mode is honoured behind ?debug=1");
  await page.close();
}

/* ---------- 3. the preset a fresh profile is already on changes nothing ---------- */
{
  const page = await open_(0, null);
  await clickText(page, "SETTINGS");
  const before = await page.evaluate(() => ({ ...window.__neonx.game.settings }));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.sign-seg[aria-label="Graphics quality"] button')]
      .find((x) => x.textContent.trim() === "HIGH");
    b?.click();
  });
  await sleep(300);
  const after = await page.evaluate(() => ({ ...window.__neonx.game.settings }));
  const diff = Object.keys(after).filter((k) => after[k] !== before[k]);
  check(before.preset === "high", "a fresh profile is on HIGH");
  check(diff.length === 0, `clicking the preset already selected changes nothing (changed: ${diff.join(", ") || "none"})`);
  await page.close();
}

await browser.close();
for (const o of ok) console.log("  ok   " + o);
for (const f of fails) console.log("  FAIL " + f);
console.log(`\n${ok.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
