/* Morning review page — every overnight set on one scrolling page.

   The owner picks by looking, so the page is contact sheets and hooks, not
   prose: one row per set (its 4-6 slides at thumbnail size, the hook, the
   angle), grouped by angle, with the video posters at the top. Sheets are
   inlined as base64 so the page is one self-contained HTML the Artifact tool
   can publish.

   Usage: node tools/tiktok-review.mjs --batch /tmp/claude-0/batch \
            [--video /path/to/clips] --out /tmp/claude-0/review.html
*/
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > -1 ? process.argv[i + 1] : d; };
const BATCH = arg("batch", "/tmp/claude-0/batch");
const VIDEO = arg("video", "");
const OUT = arg("out", "/tmp/claude-0/review.html");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function b64(file, width) {
  const buf = await sharp(file).resize({ width }).webp({ quality: 74 }).toBuffer();
  return "data:image/webp;base64," + buf.toString("base64");
}

const sets = [];
for (const id of readdirSync(BATCH).sort()) {
  const dir = path.join(BATCH, id);
  const spec = path.join(dir, "spec.json"), sheet = path.join(dir, "sheet.png");
  if (!existsSync(spec) || !existsSync(sheet)) continue;
  const s = JSON.parse(readFileSync(spec, "utf8"));
  const first = s.slides[0] || {};
  const angle = (readFileSync(path.join(BATCH, "INDEX.md"), "utf8").split("\n").find((l) => l.includes(`| ${id} |`)) || "").split("|")[2]?.trim() || "";
  sets.push({ id, angle, hook: first.hook || first.body || "", n: s.slides.length, caption: s.caption || "", tags: (s.hashtags || []).join(" "), sheet: await b64(sheet, 1600) });
}

const clips = [];
if (VIDEO && existsSync(VIDEO)) {
  for (const f of readdirSync(VIDEO).sort()) {
    if (!/\.(png|webp|jpg)$/i.test(f)) continue;
    clips.push({ name: f.replace(/\.(png|webp|jpg)$/i, ""), img: await b64(path.join(VIDEO, f), 900) });
  }
}

const groups = {};
for (const s of sets) (groups[s.angle.split(" ")[0] || "other"] ||= []).push(s);

const html = `<title>Floored Content Night</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;600&family=JetBrains+Mono:wght@400&display=swap">
<style>
:root{--bg:#f3f1ec;--panel:#ffffff;--ink:#17181c;--mute:#6b6f7a;--edge:#dcd8cf;--sod:#c8511f;--pill:#17181c;--pillink:#fff}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0b0d12;--panel:#12151c;--ink:#e9ecf2;--mute:#8a94a8;--edge:#242a36;--sod:#f0a94a;--pill:#e9ecf2;--pillink:#0b0d12}}
:root[data-theme="dark"]{--bg:#0b0d12;--panel:#12151c;--ink:#e9ecf2;--mute:#8a94a8;--edge:#242a36;--sod:#f0a94a;--pill:#e9ecf2;--pillink:#0b0d12}
body{background:var(--bg);color:var(--ink);font-family:"Archivo","Helvetica Neue",Arial,sans-serif;margin:0;padding-block:28px 90px;padding-inline:clamp(16px,3vw,40px)}
h1{font-family:"Anton","Impact","Arial Narrow",sans-serif;font-weight:400;font-size:clamp(40px,7vw,72px);line-height:.95;margin:0;text-transform:uppercase;letter-spacing:.01em;text-wrap:balance}
.sub{color:var(--mute);font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:12px 0 8px}
.how{max-width:64ch;line-height:1.5;margin:0 0 28px;font-size:15px}
.how b{color:var(--sod)}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 34px}
nav a{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;color:var(--ink);text-decoration:none;border:1px solid var(--edge);padding:6px 10px;border-radius:999px;background:var(--panel)}
nav a:focus-visible,summary:focus-visible{outline:2px solid var(--sod);outline-offset:2px}
h2{font-family:"Anton",sans-serif;font-weight:400;font-size:28px;text-transform:uppercase;letter-spacing:.02em;margin:44px 0 14px;display:flex;align-items:baseline;gap:12px}
h2 .n{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--mute);letter-spacing:.06em}
.clips{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}
.clip img{width:100%;aspect-ratio:9/16;object-fit:cover;display:block;border:1px solid var(--edge);background:#000}
.clip div{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--mute);margin-top:6px}
.set{margin:0 0 34px;padding:14px;background:var(--panel);border:1px solid var(--edge)}
.set img{display:block;width:100%;max-width:1600px;background:#000}
.meta{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;margin:0 0 10px}
.id{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--pillink);background:var(--pill);padding:3px 8px}
.hook{font-family:"Anton",sans-serif;font-size:22px;text-transform:uppercase;letter-spacing:.01em}
.n{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--mute)}
details{margin-top:10px}summary{cursor:pointer;color:var(--mute);font-size:13px}
.cap{color:var(--ink);font-size:14px;max-width:70ch;line-height:1.55;margin:8px 0 0}
.tags{font-family:"JetBrains Mono",monospace;font-size:12px;color:var(--sod);margin:6px 0 0}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
</style>
<h1>Content night</h1>
<div class="sub">${sets.length} slide sets · ${clips.length} clips · built ${new Date().toISOString().slice(0,16).replace("T"," ")}Z</div>
<p class="how">Scroll, screenshot what you like, reply with the <b>set ids</b> (the black tags). Every set is 5–8 slides at 1080×1920; the captions and hashtags are under each strip. The clips are 7 s MP4s in the session scratchpad — the posters here are their first frame.</p>
<nav>${clips.length ? '<a href="#clips">clips</a>' : ""}${Object.keys(groups).map((g) => `<a href="#g-${esc(g)}">${esc(g)}</a>`).join("")}</nav>
${clips.length ? `<h2 id="clips">Clips <span class="n">· ${clips.length} · 7 s · 1080×1920</span></h2><div class="clips">${clips.map((c) => `<div class="clip"><img src="${c.img}" alt="${esc(c.name)}" loading="lazy"><div>${esc(c.name)}</div></div>`).join("")}</div>` : ""}
${Object.entries(groups).map(([g, list]) => `<h2 id="g-${esc(g)}">${esc(g)} <span class="n">· ${list.length}</span></h2>` + list.map((s) => `
<div class="set" id="${esc(s.id)}">
  <div class="meta"><span class="id">${esc(s.id)}</span><span class="hook">${esc(s.hook)}</span><span class="n">${s.n} slides · ${esc(s.angle)}</span></div>
  <img src="${s.sheet}" alt="${esc(s.hook)}" loading="lazy">
  <details><summary>caption + tags</summary><p class="cap">${esc(s.caption)}</p><p class="tags">${esc(s.tags)}</p></details>
</div>`).join("")).join("")}
`;
writeFileSync(OUT, html);
console.log(`${sets.length} sets, ${clips.length} clips -> ${OUT} (${(html.length / 1048576).toFixed(1)} MB)`);
