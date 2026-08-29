#!/usr/bin/env node
// Recorded-audio asset check. Asserts that every sample file referenced by
// game/audio.ts's SAMPLE_FILES manifest exists under public/assets/audio and
// is a decodable mono PCM WAV (header sniff — no AudioContext in node):
// RIFF/WAVE magic, PCM format tag, 1 channel, sane sample rate, and a data
// chunk long enough to be real audio rather than a truncated download.
//
// Usage: node test/audio-assets-check.mjs
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const AUDIO_DIR = join(ROOT, 'public', 'assets', 'audio');

// ---- pull the manifest straight out of game/audio.ts ------------------------
const src = readFileSync(join(ROOT, 'game', 'audio.ts'), 'utf8');
const block = src.match(/const SAMPLE_FILES[^{]*\{([\s\S]*?)\};/);
if (!block) {
  console.error('FAIL: SAMPLE_FILES manifest not found in game/audio.ts');
  process.exit(1);
}
const entries = [...block[1].matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
if (entries.length < 20) {
  console.error(`FAIL: manifest parsed only ${entries.length} entries — regex drift?`);
  process.exit(1);
}

// ---- WAV header sniff -------------------------------------------------------
function sniffWav(path) {
  const buf = readFileSync(path);
  if (buf.length < 44) return 'file shorter than a WAV header';
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return 'missing RIFF magic';
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return 'missing WAVE magic';
  let off = 12;
  let fmt = null;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        tag: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      dataLen = Math.min(len, buf.length - off - 8);
    }
    off += 8 + len + (len % 2);
  }
  if (!fmt) return 'no fmt chunk';
  if (fmt.tag !== 1) return `not PCM (format tag ${fmt.tag})`;
  if (fmt.channels !== 1) return `${fmt.channels} channels, expected mono`;
  if (fmt.rate !== 22050 && fmt.rate !== 44100) return `odd sample rate ${fmt.rate}`;
  if (fmt.bits !== 16) return `${fmt.bits}-bit, expected 16`;
  if (dataLen <= 0) return 'no data chunk';
  const dur = dataLen / (fmt.rate * 2);
  // floor is low because several Kenney impact one-shots are genuinely
  // ~0.1-0.2s long; anything under this is a truncated/empty file.
  if (dur < 0.09) return `only ${dur.toFixed(3)}s of audio — truncated?`;
  return { rate: fmt.rate, dur };
}

// Loops that must keep their original 44.1k data (seam-exact playback).
const MUST_44K = new Set(['eng0', 'eng1', 'eng2', 'eng3', 'eng4', 'skid']);

let failed = false;
let total = 0;
for (const [key, rel] of entries) {
  const p = join(AUDIO_DIR, rel);
  let size;
  try {
    size = statSync(p).size;
  } catch {
    console.error(`FAIL: ${rel} (key "${key}") is missing`);
    failed = true;
    continue;
  }
  total += size;
  const res = sniffWav(p);
  if (typeof res === 'string') {
    console.error(`FAIL: ${rel}: ${res}`);
    failed = true;
    continue;
  }
  if (MUST_44K.has(key) && res.rate !== 44100) {
    console.error(`FAIL: ${rel}: loop must stay 44.1k, found ${res.rate}`);
    failed = true;
    continue;
  }
  console.log(`  ok ${rel.padEnd(24)} ${res.rate}Hz ${res.dur.toFixed(2)}s ${(size / 1024).toFixed(0)}K`);
}

const MB = 1024 * 1024;
console.log(`\n${entries.length} referenced samples, ${(total / MB).toFixed(2)} MB committed`);
if (total > 2.5 * MB) {
  console.error('FAIL: recorded-audio set exceeds its 2.5 MB budget');
  failed = true;
}
if (!failed) console.log('OK: all referenced samples exist and sniff as valid mono PCM WAV');
process.exit(failed ? 1 : 0);
