#!/usr/bin/env node
/**
 * G2 — the compiled backend actually boots, and serves exactly the endpoints G1 says it has.
 *
 * Moving providers and modules between folders can compile cleanly and still fail at runtime:
 * Nest resolves dependencies when it boots, not when tsc runs. This starts `dist/main.js`,
 * waits for /api/v1/health, collects every "Mapped {path, METHOD} route" line Nest logs, and
 * compares that set with the committed G1 snapshot (method + path only). Then it stops the app.
 *
 * It needs a migrated Postgres and a Redis, supplied through the usual env vars — CI's database
 * job provides both. NEVER point it at a real deployment's database: the app starts its schedulers
 * and queue workers when it boots.
 *
 *   node scripts/reorg/boot-check.mjs           (run from the repo root, after `npm run build:backend`)
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = process.env.BOOT_CHECK_PORT || '3999';
const TIMEOUT_MS = Number(process.env.BOOT_CHECK_TIMEOUT_MS || 180_000);

const expected = new Set(
  readFileSync(join(ROOT, 'docs/reorganization/snapshots/backend-routes.txt'), 'utf8')
    .split('\n').filter((l) => /^[A-Z]+\s+\//.test(l))
    .map((l) => { const [m, p] = l.trim().split(/\s+/); return `${m} ${p}`; }),
);

const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT,
  STORAGE_DRIVER: process.env.STORAGE_DRIVER || 'local',
  JWT_SECRET: process.env.JWT_SECRET || 'boot-check-only-not-a-real-secret-0123456789',
  DB_MIGRATIONS_RUN: 'false', // the job migrates explicitly; the boot check must not
};
const child = spawn(process.execPath, ['dist/main.js'], { cwd: join(ROOT, 'packages/backend'), env });

const mapped = new Set();
let log = '';
const onData = (buf) => {
  const s = buf.toString();
  log += s;
  for (const m of s.matchAll(/Mapped \{([^,]+), ([A-Z]+)\}/g)) mapped.add(`${m[2]} ${m[1]}`);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);

let exited = null;
child.on('exit', (code) => { exited = code; });

const stop = () => { if (exited === null) child.kill('SIGTERM'); };
const fail = (msg) => {
  console.error(`G2 FAILED: ${msg}\n--- last 60 log lines ---\n${log.split('\n').slice(-60).join('\n')}`);
  stop();
  process.exit(1);
};

const started = Date.now();
let healthy = false;
while (Date.now() - started < TIMEOUT_MS) {
  if (exited !== null) fail(`the process exited with code ${exited} before becoming healthy`);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`);
    if (r.status < 500) { healthy = true; break; }
  } catch { /* not listening yet */ }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!healthy) fail(`not healthy after ${TIMEOUT_MS / 1000}s`);

const missing = [...expected].filter((k) => !mapped.has(k)).sort();
const extra = [...mapped].filter((k) => !expected.has(k)).sort();
stop();
console.log(`G2 booted in ${((Date.now() - started) / 1000).toFixed(1)}s; ${mapped.size} routes mapped, ${expected.size} expected`);
if (missing.length || extra.length) {
  for (const k of missing) console.log(`  - not served at runtime: ${k}`);
  for (const k of extra) console.log(`  + served but not in G1:  ${k}`);
  process.exit(1);
}
console.log('G2 runtime route table matches G1');
