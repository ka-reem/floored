/* Batch slide generator — a story list in, fifty finished sets out.

   tools/tiktok-slides.mjs makes ONE set from ONE spec. Overnight the owner
   wants "100 tiktok posts or whatever u think is ideal maybe 50", varied, so
   he can "pick and choose myself in the morning". Hand-writing fifty specs is
   the wrong shape; this reads a STORY LIST and does the rest:

     stories.json   [{ id, angle, caption, hashtags, slides:[...] }]
     frame index    every PNG under the frame dirs, tagged from its filename

   A slide's `img` is either a path, or a QUERY like "@toll night orbit" — words
   that must all appear in a frame's filename (hero-toll-plaza.png,
   lib-kaze-toll-side-night.png ...). Queries are resolved with a per-story
   "no repeats" rule so a set never shows the same picture twice, which was the
   owner's first complaint ("all 6 of the car photos are the same").

   Output: <out>/<id>/slide-NN.png + caption.txt, one contact sheet per set,
   and INDEX.md listing every set with its hook — the thing he reads first.

   Usage: node tools/tiktok-batch.mjs --stories stories.json --out dir/
            [--frames dirA,dirB] [--only id1,id2]
*/
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > -1 ? process.argv[i + 1] : d; };
const STORIES = arg("stories");
const OUT = arg("out", "/tmp/claude-0/batch");
const SCRATCH = "/tmp/claude-0/-home-user-racing-game/d557af8b-cf5b-5327-b452-a82bf20b5727/scratchpad";
const FRAME_DIRS = arg("frames", [
  "test/artifacts/hero",
  path.join(SCRATCH, "lib"),
  path.join(SCRATCH, "vision"),
].join(",")).split(",").filter(Boolean);
const ONLY = arg("only", "");
if (!STORIES) { console.error("need --stories"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

/* ---------- frame index ---------- */
const frames = [];
for (const d of FRAME_DIRS) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!/\.(png|webp|jpg)$/i.test(f)) continue;
    const tags = f.toLowerCase().replace(/\.(png|webp|jpg)$/i, "").split(/[-_]+/);
    frames.push({ file: path.join(d, f), tags });
  }
}
console.log(`frame index: ${frames.length} frames from ${FRAME_DIRS.length} dirs`);

function resolve(query, used) {
  if (!query.startsWith("@")) return query;
  const want = query.slice(1).toLowerCase().split(/\s+/).filter(Boolean);
  const hits = frames.filter((fr) => want.every((w) => fr.tags.some((t) => t.includes(w))));
  const fresh = hits.filter((h) => !used.has(h.file));
  const pick = (fresh.length ? fresh : hits)[0];
  if (!pick) throw new Error(`no frame matches "${query}"`);
  used.add(pick.file);
  return pick.file;
}

/* ---------- per-set contact sheet ---------- */
async function sheet(dir, files, out) {
  const TW = 300, TH = 533, GAP = 8;
  const comps = [];
  for (let i = 0; i < files.length; i++) {
    const buf = await sharp(path.join(dir, files[i])).resize(TW, TH, { fit: "cover" }).toBuffer();
    comps.push({ input: buf, top: 0, left: i * (TW + GAP) });
  }
  await sharp({ create: { width: files.length * (TW + GAP), height: TH, channels: 4, background: { r: 10, g: 12, b: 18, alpha: 1 } } })
    .composite(comps).png().toFile(out);
}

/* ---------- run ---------- */
const stories = JSON.parse(readFileSync(STORIES, "utf8"));
const only = ONLY ? new Set(ONLY.split(",")) : null;
const index = ["# Overnight sets\n", "| set | angle | slides | hook |", "|---|---|---|---|"];
let made = 0, failed = 0;
for (const st of stories) {
  if (only && !only.has(st.id)) continue;
  const used = new Set();
  let spec;
  try {
    spec = {
      caption: st.caption, hashtags: st.hashtags,
      slides: await Promise.all(st.slides.map(async (s) => {
        const image = resolve(s.img ?? s.image, used);
        /* DRIVER-VIEW FRAMES CROP FROM THE TOP. A dashcam/cockpit/hood frame is
           half dashboard: cover-cropping it from the centre keeps the wheel
           and the headlight bloom and throws away the windscreen — the one
           part with a road in it. Anchoring at the top keeps the scene and
           drops the speedo, which also removes the HUD leak. Orbit/drone/
           chase frames are centred on the car and stay centred. */
        const tags = path.basename(image).toLowerCase();
        const driverView = /dashcam|cockpit|console|hood|tunnel-in|toll-plaza|pov/.test(tags) && !/orbit|drone|chase/.test(tags);
        const driving = /^hero-/.test(tags) || driverView;
        /* Cover-fitting a 16:9 source to 1080x1440 scales by HEIGHT, so the
           whole height survives and only the sides are cropped — a vertical
           anchor changes nothing. The crop has to happen in SOURCE pixels
           first: driver views keep the windscreen band (7%..62% of the
           height), every hero driving frame loses its top 7% where the HUD
           clock leaks. Orbit/drone frames were already banner-cropped. */
        let crop = s.crop;
        if (!crop && driving) {
          const m = await sharp(image).metadata();
          const top = Math.round(m.height * 0.07);
          const h = Math.round(m.height * (driverView ? 0.55 : 0.93));
          crop = { left: 0, top, width: m.width, height: h };
        }
        return { ...s, image, ...(crop ? { crop } : {}) };
      })),
    };
  } catch (e) { console.log(`  ✗ ${st.id}: ${e.message}`); failed++; continue; }
  const dir = path.join(OUT, st.id);
  mkdirSync(dir, { recursive: true });
  const specPath = path.join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec, null, 1));
  try {
    execFileSync("node", ["tools/tiktok-slides.mjs", "--spec", specPath, "--out", dir], { stdio: "pipe" });
  } catch (e) { console.log(`  ✗ ${st.id}: compositor failed\n${String(e.stderr).slice(0, 400)}`); failed++; continue; }
  const files = readdirSync(dir).filter((f) => /^slide-\d+\.png$/.test(f)).sort();
  await sheet(dir, files, path.join(dir, "sheet.png"));
  const hook = st.slides[0].hook ?? st.slides[0].body ?? "";
  /* per-set meta, so INDEX.md can be rebuilt from every set on disk rather
     than only the sets in THIS run — the batch is grown across several story
     files overnight and an index that only knew the last file was useless */
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: st.id, angle: st.angle ?? "", hook, n: files.length }));
  console.log(`  ✓ ${st.id}  (${files.length})  ${hook.slice(0, 60)}`);
  made++;
}
for (const id of readdirSync(OUT).sort()) {
  const m = path.join(OUT, id, "meta.json");
  if (existsSync(m)) { const j = JSON.parse(readFileSync(m, "utf8")); index.push(`| ${j.id} | ${j.angle} | ${j.n} | ${j.hook} |`); }
}
writeFileSync(path.join(OUT, "INDEX.md"), index.join("\n") + "\n");
console.log(`\n${made} sets made, ${failed} failed -> ${OUT}/INDEX.md`);
