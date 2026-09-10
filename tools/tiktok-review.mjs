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
<style>
:root{--bg:#0b0d12;--ink:#e7ecf4;--mute:#8a94a8;--sod:#f0a94a;--edge:#232833}
body{background:var(--bg);color:var(--ink);font-family:"Barlow","Helvetica Neue",Arial,sans-serif;margin:0;padding:24px 20px 80px}
h1{font-family:"Barlow Condensed","Arial Narrow",sans-serif;font-size:44px;margin:0 0 4px;letter-spacing:.01em}
.sub{color:var(--mute);font-family:ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:26px}
h2{font-family:"Barlow Condensed",sans-serif;font-size:26px;text-transform:uppercase;letter-spacing:.04em;color:var(--sod);border-bottom:1px solid var(--edge);padding-bottom:6px;margin:44px 0 14px}
.set{margin:0 0 30px}
.set img{display:block;width:100%;max-width:1600px;border:1px solid var(--edge);background:#000}
.meta{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;margin:6px 0 8px}
.id{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--mute)}
.hook{font-family:"Barlow Condensed",sans-serif;font-size:24px;font-weight:600}
.n{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--mute)}
details{margin-top:6px}summary{cursor:pointer;color:var(--mute);font-size:13px}
.cap{color:var(--mute);font-size:14px;max-width:70ch;line-height:1.5;margin:6px 0 0}
.tags{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--sod)}
.clips{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.clip img{width:100%;border:1px solid var(--edge)}
.clip div{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--mute);margin-top:4px}
.pick{display:inline-block;margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--mute)}
</style>
<h1>Content night</h1>
<div class="sub">${sets.length} slide sets · ${clips.length} clip posters · screenshot the slides you like, reply with the set ids</div>
${clips.length ? `<h2>Videos (posters — the MP4s are in the scratchpad)</h2><div class="clips">${clips.map((c) => `<div class="clip"><img src="${c.img}" alt="${esc(c.name)}"><div>${esc(c.name)}</div></div>`).join("")}</div>` : ""}
${Object.entries(groups).map(([g, list]) => `<h2>${esc(g)} <span class="n">· ${list.length}</span></h2>` + list.map((s) => `
<div class="set" id="${esc(s.id)}">
  <div class="meta"><span class="id">${esc(s.id)}</span><span class="hook">${esc(s.hook)}</span><span class="n">${s.n} slides · ${esc(s.angle)}</span></div>
  <img src="${s.sheet}" alt="${esc(s.hook)}">
  <details><summary>caption + tags</summary><p class="cap">${esc(s.caption)}</p><p class="tags">${esc(s.tags)}</p></details>
</div>`).join("")).join("")}
`;
writeFileSync(OUT, html);
console.log(`${sets.length} sets, ${clips.length} clips -> ${OUT} (${(html.length / 1048576).toFixed(1)} MB)`);
