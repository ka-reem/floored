#!/usr/bin/env node
/* Renders the share card app/layout.tsx points og:image / twitter:image at:
   public/og.png, 1200×630, the night palette from app/globals.css with the
   sodium-orange road deck. A static PNG rather than an opengraph-image route
   so scrapers get a plain cached file; re-run this after changing the copy.

     node tools/build-og-image.mjs

   Headless Chromium via puppeteer (already a devDependency for the test
   scripts); no GL flags needed, it is plain CSS. The Latin face is whatever
   sans the box has (DejaVu/Liberation on CI, Segoe/Helvetica on a laptop) and
   the JP line needs a CJK font installed — the fallback list covers Linux
   (IPA, WenQuanYi, Noto), macOS (Hiragino) and Windows (Meiryo/Yu Gothic). */
import { writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import sharp from "sharp";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "og.png");
const MAX_BYTES = 300 * 1024;

const HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#05060c}
  .card{position:relative;width:1200px;height:630px;overflow:hidden;
    background:radial-gradient(120% 90% at 50% 112%, #171d3d 0%, #0a0d1c 48%, #05060c 100%);
    font-family:"DejaVu Sans","Liberation Sans","Segoe UI",system-ui,sans-serif;color:#eef3ff}
  /* sodium glow on the horizon */
  .haze{position:absolute;left:0;right:0;top:300px;height:140px;
    background:linear-gradient(180deg, rgba(255,150,40,0) 0%, rgba(255,140,30,0.22) 70%, rgba(255,160,60,0.45) 100%)}
  /* road deck: perspective plane with edge lines */
  .deck{position:absolute;left:50%;top:400px;width:1800px;height:230px;margin-left:-900px;
    background:linear-gradient(180deg,#2a2731 0%,#17161c 60%,#0d0d12 100%);
    transform-origin:50% 0;transform:perspective(520px) rotateX(58deg);
    box-shadow:0 -40px 90px rgba(255,150,40,0.28)}
  .deck::before,.deck::after{content:"";position:absolute;top:0;bottom:0;width:10px;
    background:linear-gradient(180deg, rgba(255,175,70,0.2), rgba(255,175,70,0.95))}
  .deck::before{left:calc(50% - 300px)} .deck::after{left:calc(50% + 290px)}
  /* centre lane dashes */
  .dash{position:absolute;left:50%;top:400px;width:1800px;height:230px;margin-left:-900px;
    transform-origin:50% 0;transform:perspective(520px) rotateX(58deg);
    background:repeating-linear-gradient(180deg, rgba(255,235,190,0.9) 0 34px, rgba(0,0,0,0) 34px 70px);
    -webkit-mask:linear-gradient(90deg,transparent calc(50% - 5px),#000 calc(50% - 5px),#000 calc(50% + 5px),transparent calc(50% + 5px));
    mask:linear-gradient(90deg,transparent calc(50% - 5px),#000 calc(50% - 5px),#000 calc(50% + 5px),transparent calc(50% + 5px))}
  /* street lights: sodium orbs receding */
  .lamp{position:absolute;border-radius:50%;background:radial-gradient(circle,#ffe6b0 0%,#ffb347 35%,rgba(255,150,40,0) 70%)}
  .vignette{position:absolute;inset:0;background:radial-gradient(90% 80% at 50% 45%, rgba(5,6,12,0) 55%, rgba(5,6,12,0.75) 100%)}
  .text{position:absolute;left:0;right:0;top:112px;text-align:center}
  .kicker{font-size:21px;letter-spacing:0.62em;color:#7fd8ff;text-shadow:0 0 18px rgba(95,141,255,0.55);margin-left:0.62em}
  .title{margin-top:20px;font-size:84px;font-weight:700;letter-spacing:0.1em;line-height:1;margin-left:0.1em;white-space:nowrap;
    color:#f6f8ff;text-shadow:0 0 28px rgba(140,178,255,0.45),0 0 70px rgba(95,141,255,0.25)}
  .rule{width:220px;height:3px;margin:26px auto 0;background:linear-gradient(90deg,rgba(255,170,60,0),#ffab3c,rgba(255,170,60,0));box-shadow:0 0 18px rgba(255,160,50,0.8)}
  .jp{margin-top:20px;font-family:"IPAPGothic","IPAGothic","WenQuanYi Zen Hei","Noto Sans CJK JP","Hiragino Sans","Meiryo","Yu Gothic",sans-serif;
    font-size:42px;letter-spacing:0.36em;margin-left:0.36em;color:#ffb85c;text-shadow:0 0 22px rgba(255,150,40,0.6)}
  .foot{position:absolute;left:0;right:0;bottom:36px;text-align:center;font-size:20px;letter-spacing:0.34em;margin-left:0.34em;color:#a6b3d6}
  .corner{position:absolute;width:44px;height:44px;border:2px solid rgba(140,178,255,0.55)}
  .tl{left:34px;top:34px;border-right:0;border-bottom:0}.tr{right:34px;top:34px;border-left:0;border-bottom:0}
  .bl{left:34px;bottom:34px;border-right:0;border-top:0}.br{right:34px;bottom:34px;border-left:0;border-top:0}
</style></head>
<body><div class="card">
  <div class="haze"></div>
  <div class="deck"></div>
  <div class="dash"></div>
  <div class="lamp" style="left:150px;top:372px;width:16px;height:16px"></div>
  <div class="lamp" style="left:262px;top:380px;width:22px;height:22px"></div>
  <div class="lamp" style="left:916px;top:380px;width:22px;height:22px"></div>
  <div class="lamp" style="left:1034px;top:372px;width:16px;height:16px"></div>
  <div class="vignette"></div>
  <div class="corner tl"></div><div class="corner tr"></div><div class="corner bl"></div><div class="corner br"></div>
  <div class="text">
    <div class="kicker">SHUTOKO · NIGHT DRIVE</div>
    <div class="title">FLOORED</div>
    <div class="rule"></div>
    <div class="jp">首都高ナイトドライブ</div>
  </div>
  <div class="foot">PROCEDURAL TOKYO · SIM TIRE PHYSICS · RAIN · TRAFFIC</div>
</div></body></html>`;

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(HTML, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const raw = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } });

  // Re-encode at max deflate; fall back to a 256-colour palette only if the
  // full-colour file would blow the share-card size that scrapers tolerate.
  let out = await sharp(raw).png({ compressionLevel: 9, effort: 10 }).toBuffer();
  if (out.length > MAX_BYTES) {
    out = await sharp(raw)
      .png({ palette: true, colors: 256, dither: 0.6, compressionLevel: 9, effort: 10 })
      .toBuffer();
  }
  writeFileSync(OUT, out);
  console.log(`wrote ${path.relative(ROOT, OUT)} — ${(statSync(OUT).size / 1024).toFixed(0)} KB`);
} finally {
  await browser.close();
}
