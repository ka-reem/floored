#!/usr/bin/env node
// Asset size budget check. Walks the committed asset dirs and fails (exit 1)
// when they exceed the budgets. public/assets-staging is intentionally NOT
// scanned — it is a gitignored staging area, not shipped.
//
// Usage: node test/size-budget.mjs
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// ---- budgets (bytes) --------------------------------------------------------
// Critical path: everything the game needs before the player can drive.
const CRITICAL_BUDGET_MB = 15;
// Critical + lazy-loaded: everything committed under the asset dirs.
const TOTAL_BUDGET_MB = 30;

// Dirs on the critical path (loaded at or before first drivable frame).
const CRITICAL_DIRS = ['public/assets', 'public/models'];
// Dirs whose contents are lazy-loaded (async after first paint, alt variants).
// assets/audio decodes on the first user gesture; assets/lens fetches only
// when the desktop film-look enables — neither blocks the first drivable
// frame, so they count against the total budget, not the critical one.
const LAZY_DIRS = [
  'public/hdri', 'public/assets/audio', 'public/assets/lens',
  // HD NPC bodyshells stream in ~8s after the first drivable frame, desktop
  // tier only (traffic.ts hdFleet gate) — never on the critical path.
  'public/models/cars-hd',
];
// Subtrees of CRITICAL_DIRS that are actually lazy (listed above) — skipped
// while summing the critical walk so they are not double-counted.
const CRITICAL_SKIP = new Set([
  'public/assets/audio', 'public/assets/lens', 'public/models/cars-hd',
]);
// -----------------------------------------------------------------------------

const MB = 1024 * 1024;

function walkSize(dir, skip) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (skip && skip.has(relative(ROOT, p))) continue;
    if (entry.isDirectory()) total += walkSize(p, skip);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

function report(dirs, skip) {
  let sum = 0;
  for (const d of dirs) {
    const abs = join(ROOT, d);
    if (!existsSync(abs)) {
      console.log(`  ${d.padEnd(28)} (absent)`);
      continue;
    }
    const size = walkSize(abs, skip);
    sum += size;
    console.log(`  ${d.padEnd(28)} ${(size / MB).toFixed(2).padStart(8)} MB`);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = join(abs, entry.name);
      if (skip && skip.has(relative(ROOT, sub))) continue;
      console.log(
        `    ${relative(ROOT, sub).padEnd(28)} ${(walkSize(sub, skip) / MB).toFixed(2).padStart(6)} MB`,
      );
    }
  }
  return sum;
}

console.log('Critical-path asset dirs:');
const critical = report(CRITICAL_DIRS, CRITICAL_SKIP);
console.log('Lazy-loaded asset dirs:');
const lazy = report(LAZY_DIRS);
const total = critical + lazy;

console.log('');
console.log(
  `Critical: ${(critical / MB).toFixed(2)} MB / ${CRITICAL_BUDGET_MB} MB budget`,
);
console.log(
  `Total:    ${(total / MB).toFixed(2)} MB / ${TOTAL_BUDGET_MB} MB budget`,
);

let failed = false;
if (critical > CRITICAL_BUDGET_MB * MB) {
  console.error(`FAIL: critical-path assets exceed ${CRITICAL_BUDGET_MB} MB`);
  failed = true;
}
if (total > TOTAL_BUDGET_MB * MB) {
  console.error(`FAIL: total committed assets exceed ${TOTAL_BUDGET_MB} MB`);
  failed = true;
}
if (!failed) console.log('OK: within budget');
process.exit(failed ? 1 : 0);
