/* Does the GAME actually run out of the static export?
 *
 * `npm run build:static` exiting 0 proves the build compiled. It does not
 * prove a single chunk resolves, that a model path survived the export, or
 * that the caching rules in public/_headers land on the right files. This
 * does, by serving out/ through test/lib/cf-assets-server.mjs — which
 * implements Cloudflare Workers' documented static-asset routing — and then
 * driving the real game in it with a real browser.
 *
 * Three things are checked, in order of how badly they would hurt:
 *
 *   1. HEADERS. Every immutable rule must land ONLY on stamped/hashed asset
 *      paths. If `/` or any HTML route ever picked up `immutable`, Cloudflare
 *      would pin an old app at the edge and in every player's browser with no
 *      way to bust it. That is the one failure here with no recovery, so it
 *      is asserted first and asserted from the shipped file, not from prose.
 *   2. THE NETWORK LOG. Every response the page pulls from our own origin is
 *      recorded. Any 404 is a lost asset — a static export is exactly where
 *      those appear, and they are invisible in a build log.
 *   3. THE GAME. Menu → DRIVE → wait for the staged loader → a lap of the
 *      corridor by teleport, checking the car is on the deck at each station.
 *      No console errors, no page errors.
 *
 * Usage: node test/static-export-check.mjs [--keep-open]
 *        (build first: npm run build:static)
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";
import { serveExport, headerRulesOf, applyHeaders } from "./lib/cf-assets-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "out");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const fail = (m) => {
  errors.push(m);
  console.log("  ⛔", m);
};
const ok = (m) => console.log("  ✓", m);

if (!existsSync(path.join(OUT, "index.html"))) {
  console.error("out/index.html missing — run `npm run build:static` first.");
  process.exit(2);
}

/* ---------------------------------------------------------------- 1. headers
   The effective Cache-Control for a path, computed from the shipped
   public/_headers on top of the Workers default. */
const rules = headerRulesOf(OUT);
const ccOf = (p) =>
  applyHeaders(rules, p, { "Cache-Control": "public, max-age=0, must-revalidate" })[
    "Cache-Control"
  ];

console.log("→ _headers");
{
  /* MUST be immutable: content-hashed or ?v=<build>-stamped, so the URL
     changes whenever the bytes can. */
  const immutable = [
    "/_next/static/chunks/main-app-abc123.js",
    "/models/player/volvo-s90-body-lite.glb",
    "/assets/pbr/road.ktx2",
    "/hdri/night.hdr",
  ];
  /* MUST NOT be immutable: HTML and anything that names a build without
     carrying its hash. These are what a deploy has to be able to replace. */
  const mutable = [
    "/",
    "/index.html",
    "/404.html",
    "/_not-found",
    "/manifest.webmanifest",
    "/index.txt",
    "/__next._full.txt",
    "/og.png",
    "/icon.svg",
    "/apple-icon.png",
    "/_next/zEiBDSDh_ImM08IvNDdvW/rsc.txt",
  ];
  for (const p of immutable) {
    const cc = ccOf(p);
    if (!/immutable/.test(cc)) fail(`${p} is not immutable (${cc})`);
  }
  for (const p of mutable) {
    const cc = ccOf(p);
    if (/immutable/.test(cc) || /max-age=(?!0\b)\d{3,}/.test(cc))
      fail(`${p} is cached hard (${cc}) — a deploy could not replace it`);
  }
  if (!errors.length)
    ok(
      `immutable on ${immutable.length} hashed/stamped prefixes, ` +
        `revalidate on all ${mutable.length} HTML/entry paths`
    );
}

/* --------------------------------------------------------------- 2 + 3. run */
const srv = await serveExport(OUT);
console.log(`→ serving ${path.relative(ROOT, OUT)} at ${srv.url} (Workers asset routing)`);

/* The 404 route, before the browser: this is what a crawler or a stale link
   gets, and it must be the exported 404 page at status 404 — matching what
   Vercel answers today. */
{
  const r = await fetch(`${srv.url}/definitely-not-a-route`);
  const body = await r.text();
  if (r.status !== 404) fail(`unknown path answered ${r.status}, expected 404`);
  else if (!/<html/i.test(body)) fail("404 response is not the exported 404 page");
  else ok(`unknown path → 404.html at status 404 (${body.length} bytes)`);
  const h = await fetch(`${srv.url}/_headers`);
  if (h.status !== 404) fail(`_headers is being served (${h.status}) — it must not be`);
  else ok("_headers is parsed, not served");
}

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--window-size=1280,800",
    "--mute-audio",
  ],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 590000,
});

const page = await browser.newPage();

/* The network log. Only OUR origin counts — posthog and va.vercel-scripts.com
   are third parties this sandbox's proxy blocks anyway, and a blocked third
   party says nothing about the export. */
const net = [];
const ownOrigin = (u) => u.startsWith(srv.url + "/") || u === srv.url;
page.on("response", (r) => {
  const u = r.url();
  if (!ownOrigin(u)) return;
  const rec = { url: u.slice(srv.url.length), status: r.status() };
  net.push(rec);
  /* Print a miss the moment it happens — a 404 four minutes into a load is
     otherwise invisible until the run ends, and the runs are long. */
  if (rec.status >= 400)
    console.log(`  ${knownMiss(rec.url) ? "⚠️ " : "⛔"} ${rec.status} ${rec.url}`);
});
/* KNOWN, EXPLAINED misses. A 404 listed here is reported as a warning rather
   than a failure, so this stays usable as a gate; anything NOT listed fails.
   Keep the list at zero entries if you can. */
const KNOWN_404 = [
  [
    "/_vercel/insights/script.js",
    "<Analytics /> in app/layout.tsx injects Vercel Web Analytics, which only " +
      "exists on Vercel. Harmless on Cloudflare (it is answered by the 404 page, " +
      "still a free static asset) but it logs one console error per load. " +
      "Delete that line, or render it only when process.env.VERCEL is set, and " +
      "then delete this entry.",
  ],
];
const knownMiss = (u) => KNOWN_404.find(([p]) => p === u);

const failedReq = [];
let tearingDown = false;
page.on("requestfailed", (r) => {
  if (!ownOrigin(r.url())) return;
  const err = r.failure()?.errorText || "";
  /* ERR_ABORTED is a CANCELLED request, not a missing one: the browser closing
     mid-stream, or the fetch after a 404 body. It says nothing about whether
     the asset is in the export, and a 20 MB game always has something in
     flight when the run ends. */
  if (err.includes("ERR_ABORTED") || tearingDown) return;
  failedReq.push(`${r.url().slice(srv.url.length)} — ${err}`);
});

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (t.includes("favicon")) return;
  /* The browser reports a 404 on a script tag as a bare "Failed to load
     resource" with no URL in the text, so it cannot be matched to a path.
     While a known miss is outstanding, that message is its. */
  if (KNOWN_404.length && /Failed to load resource.*404/.test(t)) return;
  /* Third parties this box cannot reach. Not the export's doing. */
  if (
    t.includes("ERR_TUNNEL_CONNECTION_FAILED") ||
    t.includes("ERR_PROXY_CONNECTION_FAILED") ||
    t.includes("va.vercel-scripts.com") ||
    t.includes("posthog")
  )
    return;
  consoleErrors.push(t);
  console.log("  ⛔ console.error:", t.slice(0, 240));
});
page.on("pageerror", (e) => {
  consoleErrors.push(String(e.message || e));
  console.log("  ⛔ pageerror:", String(e.message || e).slice(0, 300));
});

console.log("→ loading the game from the export");
/* ?debug=1, via the same helper every other harness uses: window.__neonx is
   gated behind it in a PRODUCTION build (game/debug.ts), and the export is a
   production build. Without it the run waits five minutes on a hook that is
   never going to appear and reads as "the game did not boot". */
await page.goto(debugUrl(srv.url + "/"), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
ok("window.__neonx — the bundle booted");
await sleep(1500);

await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  if (!b) throw new Error("no DRIVE button on the menu");
  b.click();
});
console.log("  DRIVE clicked, waiting for the staged loader…");
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
ok("game.loaded — the world built from exported assets");
await sleep(3000);

/* A lap of the corridor. Stations spread over the whole loop so every chunk
   of the world streams in; the car must land on the deck at each one, which
   is the cheap proof that the terrain/model assets actually arrived. */
console.log("→ lap");
const lap = [];
for (const z of [-1900, -1300, -700, -200, 200, 700, 1100, 1400, 1900]) {
  const r = await page.evaluate(async (z) => {
    const c = window.__neonx.game.terrain.corridor;
    const p = c.worldOf(z, c.laneOffset(1, z));
    window.__neonx.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, 40);
    window.__neonx.setInput({ th: 0.6 });
    return { deckY: p.y };
  }, z);
  await sleep(1400);
  const st = await page.evaluate(() => window.__neonx.state());
  const dy = st.y - r.deckY;
  lap.push({ z, dy, kmh: st.kmh, npcs: st.npcs });
  if (Math.abs(dy) > 1.2) fail(`z=${z}: car is off the deck (Δy ${dy.toFixed(2)} m)`);
}
console.log(
  "  " +
    lap.map((l) => `z${l.z}:${l.kmh.toFixed(0)}km/h`).join("  ") +
    `  (npcs ${lap.at(-1).npcs})`
);
if (lap.every((l) => l.kmh < 1)) fail("the car never moved anywhere on the lap");
else ok(`${lap.length} stations driven, car on the deck at every one`);

const st = await page.evaluate(() => window.__neonx.state());
console.log(`  final: ${st.chunksVisible}/${st.chunksTotal} chunks, ${st.npcs} npcs`);

await page.screenshot({ path: path.join(ROOT, "test", "artifacts", "static-export-lap.png") }).catch(() => {});

/* The 404 page, in a second tab: this is the frame a crawler or a stale link
   actually gets, and it is worth looking at rather than trusting. */
{
  const p404 = await browser.newPage();
  await p404.setViewport({ width: 1280, height: 800 });
  await p404.goto(srv.url + "/definitely-not-a-route", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(1200);
  await p404
    .screenshot({ path: path.join(ROOT, "test", "artifacts", "static-export-404.png") })
    .catch(() => {});
  await p404.close();
}

if (process.argv.includes("--keep-open")) {
  console.log(`\n(--keep-open) serving at ${srv.url}; ctrl-c to stop`);
} else {
  tearingDown = true;
  await browser.close();
  await srv.close();
}

/* ------------------------------------------------------------ the verdict */
const bad = net.filter((r) => r.status >= 400);
const redirects = net.filter((r) => r.status >= 300 && r.status < 400);
console.log(
  `\n→ network: ${net.length} responses from the export, ` +
    `${redirects.length} redirects, ${bad.length} errors`
);
const byStatus = {};
for (const r of net) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
console.log("  " + JSON.stringify(byStatus));
for (const r of bad) {
  const known = knownMiss(r.url);
  if (known) console.log(`  ⚠️  known 404 ${r.url}\n     ${known[1]}`);
  else fail(`${r.status} ${r.url}`);
}
for (const f of failedReq) fail(`request failed: ${f}`);
for (const c of consoleErrors) errors.push(`console: ${c}`);

if (errors.length) {
  console.log(`\n❌ ${errors.length} problem(s):`);
  for (const e of errors.slice(0, 30)) console.log("  -", e.slice(0, 400));
  process.exit(1);
}
console.log("\n✅ the game runs from out/: no 404s, no console errors, lap driven");
process.exit(0);
