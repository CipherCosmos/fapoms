#!/usr/bin/env node
/**
 * The reorganization gate: regenerate every snapshot and compare it with the committed one.
 *
 *   npm run reorg:snapshot   → rewrite docs/reorganization/snapshots/* (only when a change is intended)
 *   npm run reorg:verify     → fail with a diff if anything the snapshots cover has changed
 *
 * A pure file move must pass `reorg:verify` untouched. See docs/reorganization/PLAN.md §3.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'docs', 'reorganization', 'snapshots');
const CHECKS = [
  ['G1', 'backend-routes.txt', 'snapshot-backend-routes.mjs'],
  ['G3', 'entity-schema.txt', 'snapshot-schema.cjs'],
  ['G4', 'web-routes.txt', 'snapshot-web-routes.mjs'],
  ['G5', 'shared-exports.txt', 'snapshot-shared-exports.mjs'],
];

const write = process.argv.includes('--write');
mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const [id, file, script] of CHECKS) {
  const now = execFileSync(process.execPath, [join(HERE, script)], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const path = join(OUT, file);
  if (write) { writeFileSync(path, now); console.log(`${id} ${file}: written (${now.split('\n')[0].replace(/^# /, '')})`); continue; }
  if (!existsSync(path)) { console.log(`${id} ${file}: MISSING — run npm run reorg:snapshot`); failed++; continue; }
  const was = readFileSync(path, 'utf8');
  if (was === now) { console.log(`${id} ${file}: unchanged`); continue; }
  failed++;
  const a = was.split('\n'), b = now.split('\n');
  const sa = new Set(a), sb = new Set(b);
  console.log(`${id} ${file}: CHANGED`);
  for (const l of a) if (!sb.has(l)) console.log(`  - ${l}`);
  for (const l of b) if (!sa.has(l)) console.log(`  + ${l}`);
}
if (failed) {
  console.log(`\n${failed} snapshot(s) changed. If the change is intended, explain it in the PR and run npm run reorg:snapshot.`);
  process.exit(1);
}
