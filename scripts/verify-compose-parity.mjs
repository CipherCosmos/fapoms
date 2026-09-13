#!/usr/bin/env node
/**
 * DOES A SERVICE ADDED TO ONE STACK SILENTLY NEVER REACH THE OTHER?
 *
 * `docker-compose.yml` (local dev) and `deploy/docker-compose.prod.yml` (the real deployment)
 * describe the same application twice, by hand, in two files nothing keeps in sync. LiveKit
 * shipped in dev and was never added to prod — caught only because `main.ts` happens to check
 * for it at startup and skip it deliberately, which is a comment noticing the gap, not a check
 * that would catch the next one. This is that check.
 *
 * Comparing YAML directly would mean re-implementing Compose's own env-var interpolation,
 * anchors and `!reset` overrides to get a service list Compose itself already knows how to
 * produce correctly — so this shells out to `docker compose … config --services` and diffs
 * its answer instead of parsing the files itself.
 *
 * A raw diff would fail on every run: dev has no reverse proxy or migration-runner container,
 * prod has no service for a React Native app. Those are real, deliberate differences, not the
 * bug this exists to catch — so each side of the diff is checked against an explicit, reasoned
 * allowlist below. Anything NOT on it is a genuine surprise: either a service that needs wiring
 * into the other stack, or a deliberate new difference that belongs on this list with its own
 * reason, not a silent pass.
 *
 * `deploy/aws/docker-compose.aws-full.yml` and `docker-compose.localports.yml` are excluded on
 * purpose: neither is a standalone stack. The first is an overlay `-f`-layered on top of the
 * prod file for AWS's self-hosted geocoder/router/antivirus extras (see `deploy/aws/bootstrap.sh`);
 * the second overrides ports on top of the dev file with Compose's `!reset` tag. Comparing either
 * against a full stack would just be comparing a patch against the thing it patches.
 *
 * Usage:
 *   node scripts/verify-compose-parity.mjs
 */
import { execFileSync } from 'node:child_process';

const DEV_FILE = 'docker-compose.yml';
const PROD_FILE = 'deploy/docker-compose.prod.yml';

/** Present in dev, deliberately absent from prod — with the reason it is fine that way. */
const EXPECTED_DEV_ONLY = {
  livekit: 'voice-call server; main.ts already skips wiring it when unconfigured in prod',
  mobile: 'the React Native app; nothing to containerize — it ships as a built APK, not a service',
};

/** Present in prod, deliberately absent from dev. */
const EXPECTED_PROD_ONLY = {
  'db-migrate': 'prod runs migrations as a one-shot job; a dev checkout runs them by hand',
  'backend-worker': 'prod splits API and background-worker processes; dev runs one process for both',
  clamav: 'prod-only malware scanning; dev accepts the tradeoff for iteration speed',
  caddy: "prod's reverse proxy and TLS terminator; a dev checkout is reached directly, unproxied",
};

function servicesOf(file) {
  const out = execFileSync('docker', ['compose', '-f', file, 'config', '--services'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

let dev, prod;
try {
  dev = servicesOf(DEV_FILE);
  prod = servicesOf(PROD_FILE);
} catch (err) {
  console.error(`Could not run "docker compose config" — is Docker installed and running? (${err.message})`);
  process.exit(1);
}

const onlyInDev = [...dev].filter((s) => !prod.has(s)).sort();
const onlyInProd = [...prod].filter((s) => !dev.has(s)).sort();

const unexpectedDevOnly = onlyInDev.filter((s) => !(s in EXPECTED_DEV_ONLY));
const unexpectedProdOnly = onlyInProd.filter((s) => !(s in EXPECTED_PROD_ONLY));

console.log(`${DEV_FILE}: ${dev.size} services. ${PROD_FILE}: ${prod.size} services.\n`);

for (const s of onlyInDev) {
  const known = EXPECTED_DEV_ONLY[s];
  console.log(`  dev only  : ${s}${known ? ` — ${known}` : '  ⚠ not on the allowlist'}`);
}
for (const s of onlyInProd) {
  const known = EXPECTED_PROD_ONLY[s];
  console.log(`  prod only : ${s}${known ? ` — ${known}` : '  ⚠ not on the allowlist'}`);
}

if (unexpectedDevOnly.length === 0 && unexpectedProdOnly.length === 0) {
  console.log('\nEvery difference between the two stacks is accounted for.');
  process.exit(0);
}

console.error('\nUnexpected service-list drift between dev and prod:');
if (unexpectedDevOnly.length) {
  console.error(`  in ${DEV_FILE} but not ${PROD_FILE}: ${unexpectedDevOnly.join(', ')}`);
}
if (unexpectedProdOnly.length) {
  console.error(`  in ${PROD_FILE} but not ${DEV_FILE}: ${unexpectedProdOnly.join(', ')}`);
}
console.error(
  '\nEither wire the missing service into the stack that lacks it, or — if this difference is ' +
  'deliberate — add it to EXPECTED_DEV_ONLY/EXPECTED_PROD_ONLY in this script with the reason.',
);
process.exit(1);
