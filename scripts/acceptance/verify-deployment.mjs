#!/usr/bin/env node
/**
 * THE ENVIRONMENT CHECKLIST, RUN AGAINST A DEPLOYMENT INSTEAD OF DESCRIBED.
 *
 * `docs/go-live-checklist.md` §3 is fifteen checks that had never been performed, on the stated
 * grounds that no route existed from the acceptance machine to either deployment. That is no
 * longer true, so this script exists to run them against ANY deployment given its URL — and, just
 * as importantly, to be honest about the ones it cannot run from outside.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER PROBES HERE
 *
 * The rest of `scripts/acceptance/` assumes the local rig: an API on loopback AND a PostgreSQL it
 * can open a socket to. Against a real deployment the database is not published — on the homeserver
 * Caddy binds 127.0.0.1:8080 and nothing else leaves the box — so every check that needs SQL has
 * to degrade to UNKNOWN with a reason rather than fail. A FAIL on an unreachable database says
 * "the deployment is broken" when what happened is "I could not see". Those are different
 * sentences and only one of them is true.
 *
 * So there are four outcomes here, not two:
 *
 *   PASS     the thing was OBSERVED. Not "it did not error" — observed.
 *   FAIL     the thing was observed to be wrong.
 *   UNKNOWN  it could not be seen from here. Carries the reason it could not.
 *   N/A      it does not apply to a live deployment at all (3.3).
 *
 * and each result also carries an EVIDENCE LEVEL, because "the API is up so the key must be set"
 * and "I read the key" are not the same claim:
 *
 *   DEPLOYMENT-VERIFIED  observed directly over the wire against this deployment.
 *   INFERRED             deduced from behaviour plus a property of the code the deployment runs.
 *                        Every inference here names the code path it rests on, and each was
 *                        checked against the build the deployment is ACTUALLY running (see 3.15) —
 *                        an inference from a boot assertion that was added after the running build
 *                        is worth nothing, and this script had exactly that trap in it once.
 *   UNKNOWN              not established.
 *
 * TWO TRAPS THIS SCRIPT IS BUILT AROUND
 *
 * 1. `login()` in `_lib.mjs` MUTATES THE ACCOUNT. If the principal has `mustChangePassword`, it
 *    rotates the password away and back so a rig run is re-runnable. Against a deployment you have
 *    been told not to change, that is an unannounced write to a real credential — and if the
 *    rotate-back leg fails, you have locked somebody out of production. `signIn()` below therefore
 *    does NOT rotate: it reports `mustChangePassword` as a finding and stops.
 *
 * 2. EICAR PROVES THE APP, NOT CLAMAV. `FileScanService.scanBuffer` catches the EICAR signature in
 *    process, BEFORE it looks at `CLAMAV_HOST`, deliberately so the wiring can be tested without a
 *    scanner. So an EICAR upload that is rejected tells you the guard fired and tells you NOTHING
 *    about whether ClamAV is reachable. The check that discriminates is a CLEAN file: with
 *    `FILE_SCAN_REQUIRED=true` and no reachable scanner the service throws 503; a 2xx means bytes
 *    really were streamed to clamd. 3.10 therefore runs the clean control and reads the EICAR
 *    result only alongside it.
 *
 * SAFETY
 *
 * Read-only by default. Everything that writes is behind an explicit opt-in, because this is aimed
 * at deployments somebody is deciding whether to trust rather than at a rig:
 *
 *   AC_EICAR=1         allow 3.10 to upload the EICAR string (one deliberate write, self-cleaning:
 *                      the scan runs in an interceptor BEFORE the handler, so a rejected upload
 *                      never reaches the object write or the row write and there is nothing to
 *                      clean up — the check verifies that rather than assuming it).
 *   AC_ALLOW_WRITES=1  allow 3.13 to create business records. OFF by default: completing an
 *                      assignment on a real deployment books real money and consumes a branch
 *                      permanently (a completed audit closes its branch, twice over).
 *
 * Failed sign-ins are bounded on purpose. There is no per-account lock (by design — it let anyone
 * lock out `admin`), but a failure increments the account's counter and at five fires an
 * "account locked" alert to real administrators, and the per-SOURCE brake blocks the caller's
 * address after LOGIN_IP_MAX_FAILURES (default 20) in a 15-minute window. So each account is tried
 * at most twice and the run stops trying entirely after MAX_LOGIN_FAILURES.
 *
 * USAGE
 *
 *   AC_API=https://host/api/v1 \
 *   AC_USERNAME=admin AC_PASSWORD='…' \
 *   node scripts/acceptance/verify-deployment.mjs
 *
 * Optional, each unlocking the checks it can serve:
 *   AC_ROLE_LOGINS='{"ADMIN":["admin","pw"],"OPERATIONS":["manager","pw"]}'   3.13 per-role landing
 *   AC_DEVELOPER_LOGIN='user:pw'     3.5 outbox health, 3.14 the log proxy
 *   AC_METRICS_TOKEN=…               3.6 queue gauges (a partial proxy for the repeat keys)
 *   AC_DB=1 + DB_HOST/DB_PORT/…      3.4 and 3.12 — only ever point this at a database you are
 *                                    allowed to read; it is never required.
 *   AC_EXPECT_COMMIT=<sha>           3.15 compares against this instead of the local HEAD.
 *
 * Exit code is 0 when nothing FAILED. UNKNOWN does not fail the run — an unrunnable check is a
 * reporting outcome, not a defect — but the summary states how many there were, because a
 * certification with nine UNKNOWNs is not a certification and should not read like one.
 */
import { execFileSync } from 'node:child_process';
import tls from 'node:tls';
import { URL } from 'node:url';
import { req, env } from './_lib.mjs';

const API = env.AC_API ?? 'http://127.0.0.1:8080/api/v1';
const ORIGIN = new URL(API).origin;
const EXPECT_COMMIT = env.AC_EXPECT_COMMIT ?? null;
const ALLOW_EICAR = env.AC_EICAR === '1';
const ALLOW_WRITES = env.AC_ALLOW_WRITES === '1';
const MAX_LOGIN_FAILURES = Number(env.AC_MAX_LOGIN_FAILURES ?? 8);

/** The EICAR test signature, assembled so this file is not itself quarantined by a scanner. */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', 'STANDARD', 'ANTIVIRUS', 'TEST', 'FILE!$H+H*'].join('-');

// ── results ────────────────────────────────────────────────────────────────────────────────────

const RESULTS = [];
const STATUS = { PASS: 'PASS', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN', NA: 'N/A' };

/**
 * Record one checklist row.
 *
 * `observed` is what was actually seen on the wire, not a restatement of the check — a line that
 * says "health endpoints OK" is worth nothing to somebody deciding whether to believe this.
 * `classification` is required on a FAIL and must say which of the three it is, because "the
 * product is broken", "the box is misconfigured" and "my probe is wrong" lead three different
 * people to do three different things.
 */
function record(id, title, status, evidence, observed, classification = null) {
  RESULTS.push({ id, title, status, evidence, observed, classification });
  const tag = status === STATUS.PASS ? 'PASS   ' : status === STATUS.FAIL ? 'FAIL   ' : status === STATUS.NA ? 'N/A    ' : 'UNKNOWN';
  console.log(`${tag} ${id}  ${title}   [${evidence}]`);
  for (const line of String(observed).split('\n')) console.log(`         ${line}`);
  if (classification) console.log(`         → classified: ${classification}`);
  console.log('');
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

let loginFailures = 0;

/**
 * Sign in WITHOUT rotating anything. See trap 1 in the header.
 *
 * Returns `{ token, user }` on success, or `{ error, status, code }` describing exactly why not,
 * so an unreachable admin surface can be reported as the finding it is instead of throwing and
 * taking the rest of the run with it.
 */
async function signIn(username, password) {
  if (loginFailures >= MAX_LOGIN_FAILURES) {
    return { error: `not attempted — ${loginFailures} failed sign-ins already this run, stopping short of the per-source brake`, status: null };
  }
  const r = await req('/auth/login', { method: 'POST', body: { username, password } });
  if (r.status === 429) return { error: 'throttled for the whole budget', status: 429 };
  const token = r.body?.data?.accessToken ?? r.body?.accessToken;
  if (!token) {
    loginFailures++;
    return { error: r.msg ?? `HTTP ${r.status}`, status: r.status, code: r.body?.code ?? null };
  }
  const user = r.body?.data?.user ?? null;
  if (user?.mustChangePassword) {
    // Deliberately not rotating. The rig helper would; against a deployment that is a write.
    return { token, user, mustChangePassword: true };
  }
  return { token, user };
}

/** Does this route exist in the running build? 404 means the code does not declare it. */
async function routeExists(path) {
  const r = await req(path);
  return { exists: r.status !== 404, status: r.status, msg: r.msg };
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow' });
  return { status: r.status, headers: r.headers, text: r.status < 400 ? await r.text() : '' };
}

// ── 3.1 Environment configuration ──────────────────────────────────────────────────────────────

/**
 * The remote environment cannot be read. What CAN be read is which boot assertions the process
 * survived, and that is a real signal: `assertProductionSafeConfig` in main.ts THROWS when
 * NODE_ENV=production and any of its checks fail, so a serving API proves every one of them.
 *
 * The whole chain hangs on NODE_ENV actually being `production`, which is itself observable:
 * Swagger is mounted when `NODE_ENV !== 'production' || ENABLE_API_DOCS === 'true'`, so a 404 on
 * `/api/docs` that is answered BY THE BACKEND (a Nest error body with a correlationId, not the
 * proxy's own 404) means the mount did not happen, which means NODE_ENV is production.
 */
async function check31() {
  const docs = await fetchText(`${ORIGIN}/api/docs`);
  let body = null;
  try { body = JSON.parse((await fetch(`${ORIGIN}/api/docs`)).status < 400 ? '{}' : await (await fetch(`${ORIGIN}/api/docs`)).text()); } catch { /* not JSON */ }
  const backendAnswered = body?.correlationId != null && body?.code === 'NOT_FOUND';
  const prod = docs.status === 404 && backendAnswered;

  const metrics = await req('/metrics');
  // MetricsAuthGuard returns true when METRICS_TOKEN is unset, so a 401 proves it IS set.
  const metricsTokenSet = metrics.status === 401;

  const inferred = prod
    ? [
        'JWT_SECRET set, not a burned default, >= 32 chars',
        'DB_SYNCHRONIZE is not "true"',
        'CORS_ORIGINS set',
        'PII_ENCRYPTION_KEY set and well-formed',
        'DB_PASSWORD set and not a known default',
        'STORAGE_DRIVER=s3',
        'FILE_SCAN_REQUIRED=true',
        'MINIO_ROOT_PASSWORD not the shipped default (s3 + non-AWS endpoint)',
      ]
    : [];

  const unseen = ['FAPOMS_RUNTIME_PASSWORD', 'FAPOMS_MIGRATION_PASSWORD', 'DB_ADMIN_URL', 'DB_MIGRATIONS_RUN', 'CLAMAV_HOST'];

  const observed = [
    `GET /api/docs -> ${docs.status}${backendAnswered ? ' (Nest 404 body, so the backend answered)' : ''}`,
    `NODE_ENV=production: ${prod ? 'PROVEN by the Swagger mount not happening' : 'NOT established'}`,
    `GET /api/v1/metrics -> ${metrics.status} (${metricsTokenSet ? 'METRICS_TOKEN is set' : 'METRICS_TOKEN may be unset — the guard is a no-op without it'})`,
    prod ? `INFERRED from assertProductionSafeConfig surviving boot:\n  - ${inferred.join('\n  - ')}` : '',
    `NOT OBSERVABLE from outside: ${unseen.join(', ')}`,
  ].filter(Boolean).join('\n');

  // Required keys remain unseen, so this cannot be a PASS however good the inference is.
  record('3.1 ', 'Environment configuration', STATUS.UNKNOWN, prod ? 'INFERRED (partial)' : 'UNKNOWN', observed);
}

// ── 3.2 Both repair migrations applied ─────────────────────────────────────────────────────────

/**
 * Nothing exposes the `migrations` table, so this is inferred from the grants the migrations add.
 * `ReconcileRolePermissions3` is the only thing that puts `SYSTEM:APPROVE:PLATFORM` on ADMIN, and
 * without it no destructive request can be approved by anybody at all.
 */
async function check32(admin) {
  if (!admin?.token) {
    return record('3.2 ', 'Both repair migrations applied', STATUS.UNKNOWN, 'UNKNOWN',
      `needs an authenticated ADMIN to read GET /users/roles — ${admin?.error ?? 'no admin credential supplied'}`);
  }
  const r = await req('/users/roles', { token: admin.token });
  if (r.status !== 200) {
    return record('3.2 ', 'Both repair migrations applied', STATUS.UNKNOWN, 'UNKNOWN',
      `GET /users/roles -> ${r.status} ${r.msg ?? ''} — the grant table could not be read`);
  }
  const roles = r.body?.data ?? r.body ?? [];
  const keyOf = (p) => String(p?.key ?? p?.name ?? p).toUpperCase();
  const byName = Object.fromEntries(roles.map((x) => [String(x.name).toUpperCase(), (x.permissions ?? []).map(keyOf)]));
  const adminGrants = byName.ADMIN ?? [];
  const hasApprove = adminGrants.includes('SYSTEM:APPROVE:PLATFORM');
  const spot = {
    ADMIN: ['SYSTEM:APPROVE:PLATFORM', 'OCR:CREATE:ORGANIZATION', 'ORGANIZATION:DELETE:ORGANIZATION'],
    DEVELOPER: ['SYSTEM:VIEW:PLATFORM', 'SYSTEM:EDIT:PLATFORM'],
    OPERATIONS: ['ASSAYER:VIEW:ORGANIZATION', 'DOCUMENT:VIEW:ORGANIZATION', 'REFERENCE_DATA:VIEW:ORGANIZATION'],
    DESK_OPERATOR: ['ASSAYER:VIEW:ORGANIZATION', 'DOCUMENT:VIEW:ORGANIZATION', 'VALIDATION:VIEW:ORGANIZATION'],
  };
  const missing = [];
  for (const [role, keys] of Object.entries(spot)) {
    const held = byName[role];
    if (!held) continue;
    for (const k of keys) if (!held.includes(k)) missing.push(`${role} lacks ${k}`);
  }
  const observed = [
    `roles read: ${Object.keys(byName).join(', ')}`,
    `ADMIN holds ${adminGrants.length} grants; SYSTEM:APPROVE:PLATFORM ${hasApprove ? 'PRESENT' : 'MISSING'}`,
    missing.length ? `missing spot-checked grants:\n  - ${missing.join('\n  - ')}` : 'all spot-checked grants present',
    'BackfillTenantOwnership2 has no HTTP probe — its effect (organization_id backfill) is not reported by any endpoint',
  ].join('\n');
  if (missing.length) {
    return record('3.2 ', 'Both repair migrations applied', STATUS.FAIL, 'DEPLOYMENT-VERIFIED', observed,
      'environment defect — the repair migration has not been applied to this database');
  }
  record('3.2 ', 'Both repair migrations applied', STATUS.PASS, 'INFERRED', observed);
}

// ── 3.3 Migrations from empty ──────────────────────────────────────────────────────────────────

function check33() {
  record('3.3 ', 'Migrations from empty', STATUS.NA, 'UNKNOWN',
    [
      '`npm run verify:migrations` builds a database from nothing and drops it again.',
      'It must NOT be pointed at a live deployment: it needs an administrative DB_ADMIN_URL, and',
      'the equivalent runtime-role verifier explicitly says "point it at a disposable PostgreSQL,',
      'never at a deployment". This belongs on a throwaway database on that host, run by somebody',
      'with a shell there — not on the serving one, and not from here.',
    ].join('\n'));
}

// ── 3.4 Runtime database identity ──────────────────────────────────────────────────────────────

/**
 * The ten assertions live in RUNTIME_ASSERTIONS and are run two ways: `assertDatabaseIdentity()`
 * before Nest starts (fatal in production) and `StartupChecksService` at bootstrap. NEITHER is
 * exposed over HTTP — `getLastResults()` exists and no controller consumes it — so the only signal
 * a running deployment gives is that it booted at all, and that signal only exists if the build it
 * is running HAS the pre-Nest assertion. Check that before believing it.
 */
async function check34(runningBuild, db) {
  if (db?.ok) {
    const rows = await db.query(
      `SELECT current_user AS who,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super,
              (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner = current_user) AS owned`);
    const r = rows?.[0];
    if (r) {
      const ok = r.who === 'fapoms_runtime' && r.super === false && Number(r.owned) === 0;
      return record('3.4 ', 'Runtime database identity', ok ? STATUS.PASS : STATUS.FAIL,
        'DEPLOYMENT-VERIFIED',
        `connected as ${r.who}; superuser=${r.super}; tables owned in public=${r.owned}`,
        ok ? null : 'environment defect — the API is connecting as the wrong database identity');
    }
  }
  const assertionInBuild = runningBuild?.hasRuntimeIdentityAssertion;
  const observed = [
    'No endpoint reports the database identity; the ten assertions are boot-log only.',
    `The running build ${assertionInBuild === true ? 'DOES' : assertionInBuild === false ? 'DOES NOT' : 'may or may not'} contain the pre-Nest assertDatabaseIdentity() gate.`,
    assertionInBuild === false
      ? 'So "it booted" proves NOTHING here: that gate was added after the build this deployment runs.'
      : assertionInBuild === true
        ? 'A production boot would therefore have refused to start had any assertion failed — but that is an inference about the boot, not an observation of the identity.'
        : '',
    'No database connection was available, so the identity itself was not read.',
  ].filter(Boolean).join('\n');
  record('3.4 ', 'Runtime database identity', STATUS.UNKNOWN, 'UNKNOWN', observed);
}

// ── 3.5 Worker replica running ─────────────────────────────────────────────────────────────────

async function check35(dev) {
  const route = await routeExists('/admin/outbox/health');
  if (!route.exists) {
    return record('3.5 ', 'Worker replica running', STATUS.UNKNOWN, 'UNKNOWN',
      [
        'GET /api/v1/admin/outbox/health -> 404: the route is not declared in the running build,',
        'so the one surface that would report outbox drain does not exist here at all.',
        'Detecting the worker behaviourally means completing an assignment and watching for a',
        'payable — a real write to a real deployment, which this run did not perform.',
      ].join('\n'));
  }
  if (!dev?.token) {
    return record('3.5 ', 'Worker replica running', STATUS.UNKNOWN, 'UNKNOWN',
      `the route exists (HTTP ${route.status}) but it is DEVELOPER-only and @RoleOnly() — ${dev?.error ?? 'no DEVELOPER credential supplied'}`);
  }
  const r = await req('/admin/outbox/health', { token: dev.token });
  if (r.status !== 200) {
    return record('3.5 ', 'Worker replica running', STATUS.UNKNOWN, 'UNKNOWN', `GET /admin/outbox/health -> ${r.status} ${r.msg ?? ''}`);
  }
  const d = r.body?.data ?? r.body;
  // A drained outbox is the evidence. A backlog whose oldest entry keeps ageing is a stopped worker.
  const stalled = (d.pending ?? 0) > 0 && (d.oldestPendingAgeSeconds ?? 0) > 300;
  record('3.5 ', 'Worker replica running', stalled ? STATUS.FAIL : STATUS.PASS, 'DEPLOYMENT-VERIFIED',
    `pending=${d.pending} deadLettered=${d.deadLettered} retrying=${d.retrying} oldestPendingAgeSeconds=${d.oldestPendingAgeSeconds}`,
    stalled ? 'environment defect — events are queued and ageing, which is what an api-only deployment looks like' : null);
}

// ── 3.6 Schedules registered ───────────────────────────────────────────────────────────────────

/**
 * The seven `bull:*:repeat` keys live in Redis and nothing reports them over HTTP. `/metrics`
 * carries `queue_jobs{queue,state}` for six queues, which is a partial proxy at best: a live
 * repeatable shows as a delayed job carrying the next tick, and three of the seven schedules
 * (audit-seal, retention, geo-precision) are not sampled by the metrics service at all.
 */
async function check36() {
  const token = env.AC_METRICS_TOKEN;
  if (!token) {
    return record('3.6 ', 'Schedules registered (seven bull:*:repeat keys)', STATUS.UNKNOWN, 'UNKNOWN',
      [
        'Requires Redis (ZCARD/KEYS on bull:*:repeat). No Redis route from here.',
        'No HTTP endpoint reports repeat schedules; /api/v1/metrics is the nearest proxy and needs',
        'AC_METRICS_TOKEN. Even with it, audit-seal, retention and geo-precision are not sampled,',
        'so three of the seven could not be confirmed by that route either.',
      ].join('\n'));
  }
  const r = await fetch(`${API}/metrics`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status !== 200) {
    return record('3.6 ', 'Schedules registered (seven bull:*:repeat keys)', STATUS.UNKNOWN, 'UNKNOWN', `GET /metrics -> ${r.status}`);
  }
  const text = await r.text();
  const delayed = [...text.matchAll(/queue_jobs\{queue="([^"]+)",state="delayed"\}\s+(\d+)/g)].map((m) => `${m[1]}=${m[2]}`);
  record('3.6 ', 'Schedules registered (seven bull:*:repeat keys)', STATUS.UNKNOWN, 'INFERRED (partial)',
    [
      `delayed-job gauges (a live repeatable carries one): ${delayed.join(' ') || 'none reported'}`,
      'This is a proxy for six queues only. The seven repeat keys themselves were not read;',
      'audit-seal, retention and geo-precision have no HTTP observability at all.',
    ].join('\n'));
}

// ── 3.7 Health endpoints ───────────────────────────────────────────────────────────────────────

async function check37() {
  const h = await req('/health');
  const ready = await req('/health/ready');
  const b = ready.body ?? {};
  const allUp = ready.status === 200 && b.database === 'up' && b.redis === 'up' && b.realtime === 'ok';
  const observed = [
    `GET /health -> ${h.status} ${JSON.stringify(h.body)}`,
    `GET /health/ready -> ${ready.status} ${JSON.stringify(b)}`,
    allUp ? 'database, redis and realtime all report up.' : 'one or more dependencies are not up.',
  ].join('\n');
  record('3.7 ', 'Health endpoints', allUp ? STATUS.PASS : STATUS.FAIL, 'DEPLOYMENT-VERIFIED', observed,
    allUp ? null : 'environment defect — a declared dependency is down');
}

// ── 3.8 Proxy and TLS ──────────────────────────────────────────────────────────────────────────

function peerCertificate(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 15000 }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      const error = socket.authorizationError;
      socket.end();
      resolve({ cert, authorized, error });
    });
    socket.on('error', (e) => resolve({ error: e.message }));
    socket.on('timeout', () => { socket.destroy(); resolve({ error: 'TLS handshake timed out' }); });
  });
}

async function check38() {
  const url = new URL(API);
  if (url.protocol !== 'https:') {
    return record('3.8 ', 'Proxy and TLS', STATUS.FAIL, 'DEPLOYMENT-VERIFIED',
      `the deployment is being addressed over ${url.protocol}//, so there is no edge certificate to validate`,
      'environment defect — no TLS at the edge');
  }
  const { cert, authorized, error } = await peerCertificate(url.hostname);
  if (!cert?.subject) {
    return record('3.8 ', 'Proxy and TLS', STATUS.FAIL, 'DEPLOYMENT-VERIFIED', `could not read a certificate: ${error}`, 'environment defect');
  }
  const now = Date.now();
  const expires = new Date(cert.valid_to).getTime();
  const days = Math.round((expires - now) / 86400000);
  const h = await fetch(`${API}/health`);
  const via = h.headers.get('via') ?? '(no Via header)';
  const hsts = h.headers.get('strict-transport-security') ?? '(none)';
  const ok = authorized === true && expires > now;
  const observed = [
    `subject CN=${cert.subject.CN}; issuer ${cert.issuer?.O ?? '?'} ${cert.issuer?.CN ?? ''}`,
    `valid ${cert.valid_from} -> ${cert.valid_to} (${days} days remaining)`,
    `chain validated by the system trust store: ${authorized}${error ? ` (${error})` : ''}`,
    `edge: Via: ${via}; Strict-Transport-Security: ${hsts}`,
  ].join('\n');
  record('3.8 ', 'Proxy and TLS', ok ? STATUS.PASS : STATUS.FAIL, 'DEPLOYMENT-VERIFIED', observed,
    ok ? null : 'environment defect — the edge certificate is not valid');
}

// ── 3.9 Storage ────────────────────────────────────────────────────────────────────────────────

/**
 * Nothing reports the bucket over HTTP. But `S3StorageService.onModuleInit` does a HeadBucket and
 * THROWS on anything that is not a missing-bucket, which fails module init — so an API that serves
 * requests has a reachable bucket. CORS and encryption are `logger.warn` on failure, precisely so
 * community MinIO can boot without server-side encryption, so those stay unknown from here. That
 * is the question the checklist asks to be recorded rather than assumed.
 */
async function check39(storageDriverIsS3) {
  const h = await req('/health');
  const serving = h.status === 200;
  const observed = [
    `the API is serving requests (GET /health -> ${h.status}).`,
    storageDriverIsS3
      ? 'STORAGE_DRIVER=s3 is inferred from assertProductionSafeConfig, which is fatal otherwise.'
      : 'STORAGE_DRIVER could not be established.',
    serving && storageDriverIsS3
      ? 'S3StorageService.onModuleInit HeadBuckets and throws on any error but a missing bucket, so a'
        + '\nserving API means the bucket IS reachable.'
      : '',
    'CORS and server-side encryption are logged as warnings and never fail boot, so neither can be',
    'read from here. On community MinIO server-side encryption cannot be provided at all — whether',
    'the host volume is encrypted instead is a question for somebody with a shell on that box.',
  ].filter(Boolean).join('\n');
  record('3.9 ', 'Storage', STATUS.UNKNOWN, serving && storageDriverIsS3 ? 'INFERRED (partial)' : 'UNKNOWN', observed);
}

// ── 3.10 Malware scanning ──────────────────────────────────────────────────────────────────────

/**
 * See trap 2. The clean control is the check; EICAR on its own cannot distinguish a working
 * ClamAV from no ClamAV at all.
 */
async function check310(admin) {
  if (!admin?.token) {
    return record('3.10', 'Malware scanning (EICAR)', STATUS.UNKNOWN, 'UNKNOWN',
      `every upload route requires a JWT — ${admin?.error ?? 'no credential supplied'}. FILE_SCAN_REQUIRED=true is separately INFERRED from the production boot assertion.`);
  }
  if (!ALLOW_EICAR) {
    return record('3.10', 'Malware scanning (EICAR)', STATUS.UNKNOWN, 'UNKNOWN',
      'not run: this is the one deliberate write and it is opt-in. Re-run with AC_EICAR=1 to perform it.');
  }

  const post = async (name, type, bytes) => {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type }), name);
    const r = await fetch(`${API}/feedback/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: form });
    let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, body: j };
  };

  const clean = await post('control.pdf', 'application/pdf', '%PDF-1.4\n% clean control file for deployment certification\n');
  const infected = await post('eicar.pdf', 'application/pdf', EICAR);

  const rejected = infected.status === 400 && String(infected.body?.code ?? '') === 'UPLOAD_REJECTED';
  const scannerReachable = clean.status < 400;
  const scannerMissing = clean.status === 503;

  const observed = [
    `EICAR upload   -> ${infected.status} ${infected.body?.code ?? ''} ${String(infected.body?.message ?? '').slice(0, 120)}`,
    `clean control  -> ${clean.status} ${String(clean.body?.message ?? '').slice(0, 120)}`,
    rejected
      ? 'the EICAR upload was REJECTED. Note this alone proves only the in-process guard fired:'
        + '\nFileScanService catches EICAR before it ever looks at CLAMAV_HOST.'
      : 'the EICAR upload was NOT rejected.',
    scannerMissing
      ? 'the clean control returned 503, which is what FILE_SCAN_REQUIRED=true does when NO scanner'
        + '\nis reachable. So ClamAV is NOT reachable on this deployment.'
      : scannerReachable
        ? 'the clean control was accepted, so bytes really were streamed to clamd: ClamAV IS reachable.'
        : `the clean control returned ${clean.status}, which settles neither way.`,
    rejected
      ? 'Nothing was stored: the scan runs in FileScanInterceptor BEFORE the handler, so the rejected'
        + '\nupload never reached saveFile() or documentService.create() — there is no object and no row'
        + '\nto clean up. The 400 is itself the evidence that the handler never ran.'
      : '',
  ].filter(Boolean).join('\n');

  if (rejected && scannerReachable) {
    return record('3.10', 'Malware scanning (EICAR)', STATUS.PASS, 'DEPLOYMENT-VERIFIED', observed);
  }
  if (rejected && scannerMissing) {
    return record('3.10', 'Malware scanning (EICAR)', STATUS.FAIL, 'DEPLOYMENT-VERIFIED', observed,
      'environment defect — CLAMAV_HOST is unset or the sidecar is down; every real upload 503s while only EICAR is caught');
  }
  record('3.10', 'Malware scanning (EICAR)', rejected ? STATUS.UNKNOWN : STATUS.FAIL, 'DEPLOYMENT-VERIFIED', observed,
    rejected ? null : 'product defect — an EICAR upload was accepted');
}

// ── 3.11 Backups ───────────────────────────────────────────────────────────────────────────────

function check311() {
  record('3.11', 'Backups exist, off-box, restored once', STATUS.UNKNOWN, 'UNKNOWN',
    [
      'Not observable over HTTP by any means. `deploy/restore.sh --drill` hardcodes podman and',
      'homeserver paths and must be run ON the box; whether a backup has ever been restored is a',
      'fact about that host and its off-box target, not about the API.',
      'This one cannot be closed from outside and should not be marked done until somebody with a',
      'shell there runs the drill and says so.',
    ].join('\n'));
}

// ── 3.12 Audit protections live ────────────────────────────────────────────────────────────────

async function check312(db) {
  if (db?.ok) {
    const trig = await db.query(
      `SELECT c.relname AS tbl, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relname IN ('audit_events','audit_chain') ORDER BY 1,2`);
    const names = (trig ?? []).map((r) => `${r.tbl}.${r.tgname}`);
    const ok = names.some((n) => n.startsWith('audit_events')) && names.some((n) => n.startsWith('audit_chain'));
    return record('3.12', 'Audit protections live', ok ? STATUS.PASS : STATUS.FAIL, 'DEPLOYMENT-VERIFIED',
      `triggers found: ${names.join(', ') || 'NONE'}`,
      ok ? null : 'environment defect — the append-only triggers are absent on this database');
  }
  record('3.12', 'Audit protections live', STATUS.UNKNOWN, 'UNKNOWN',
    [
      'Needs SQL: the immutability and TRUNCATE triggers on audit_events/audit_chain, and an UPDATE',
      'refused as the runtime role. No database route from here.',
      'Nothing the API exposes answers it either — there is no endpoint that reports triggers, table',
      'ownership or the runtime role\'s privileges, and the boot-time assertions that DO check exactly',
      'this are written to the boot log and to no HTTP surface.',
    ].join('\n'));
}

// ── 3.13 Smoke the business loop ───────────────────────────────────────────────────────────────

/**
 * Split deliberately. Signing in and reading the landing route is read-only and safe; completing an
 * assignment books real money on a real deployment and permanently consumes a branch, so the write
 * half stays behind AC_ALLOW_WRITES and is otherwise reported as not run, with the reason.
 */
async function check313() {
  let logins = {};
  try { logins = JSON.parse(env.AC_ROLE_LOGINS ?? '{}'); } catch { logins = {}; }
  const names = Object.keys(logins);
  if (names.length === 0) {
    return record('3.13', 'Smoke the business loop', STATUS.UNKNOWN, 'UNKNOWN',
      [
        'The read-only half (sign in as each role, confirm the landing it is given) needs one',
        'credential per role and none were supplied — AC_ROLE_LOGINS was empty.',
        'The write half (complete one assignment, watch the payable appear) was NOT run and is not',
        'enabled by default: it books real money against a real deployment and permanently consumes',
        'a project-branch, because a completed audit closes its branch to further assignments.',
      ].join('\n'));
  }
  const lines = [];
  let failures = 0;
  let signedIn = 0;
  for (const role of names) {
    const [u, p] = logins[role];
    const s = await signIn(u, p);
    if (!s.token) {
      failures++;
      // 401 and 403 say different things. The status check runs BEFORE the password compare, so a
      // 403 means the account exists and is disabled/suspended whatever password you sent, while a
      // 401 cannot distinguish "wrong password" from "no such account".
      const shape = s.status === 403 ? 'account exists but is not active' : s.status === 401 ? 'wrong password, or no such account — the two are indistinguishable here' : '';
      lines.push(`${role.padEnd(16)} ${u}: SIGN-IN REFUSED — HTTP ${s.status} ${s.error}${shape ? ` (${shape})` : ''}`);
      continue;
    }
    signedIn++;
    if (s.mustChangePassword) lines.push(`${role.padEnd(16)} ${u}: signed in but mustChangePassword is set (NOT rotated by this script)`);
    const me = await req('/users/me', { token: s.token });
    const roles = (me.body?.data?.roles ?? me.body?.roles ?? []).map((r) => r.name ?? r).join(',');
    lines.push(`${role.padEnd(16)} ${u}: signed in; /users/me -> ${me.status}; roles=${roles || '(none reported)'}`);
  }
  lines.push(ALLOW_WRITES
    ? 'AC_ALLOW_WRITES=1 was set but the write half is not implemented here by design — use business-loop.mjs, which cancels what it opens.'
    : 'write half deliberately NOT run: completing an assignment books real money and consumes a branch permanently.');

  /**
   * A refused sign-in is only a defect if the credential was real.
   *
   * Set AC_CREDS_ARE_AUTHORITATIVE=1 when the passwords supplied were ISSUED for this deployment.
   * Without it the script assumes they may be documented defaults or guesses, and a refusal then
   * says nothing about the deployment — rotating the shipped password is correct operation, not a
   * fault, and reporting it as one would turn good hygiene into a red row. That is a harness
   * limitation, so it is an UNKNOWN classified as a test defect, never an environment defect.
   */
  const authoritative = env.AC_CREDS_ARE_AUTHORITATIVE === '1';
  if (failures && !authoritative) {
    lines.push('These credentials were NOT declared authoritative (AC_CREDS_ARE_AUTHORITATIVE is unset),');
    lines.push('so a refusal is read as "this run does not hold a working credential" and not as a fault.');
    return record('3.13', 'Smoke the business loop (read-only half)', STATUS.UNKNOWN, 'DEPLOYMENT-VERIFIED',
      lines.join('\n'), 'test defect (harness limitation) — no issued credential for this deployment was available');
  }
  record('3.13', 'Smoke the business loop (read-only half)', failures ? STATUS.FAIL : signedIn ? STATUS.UNKNOWN : STATUS.UNKNOWN,
    'DEPLOYMENT-VERIFIED (read-only half only)', lines.join('\n'),
    failures ? 'environment defect — an issued credential for a role that must sign in was refused' : null);
}

// ── 3.14 The log proxy is running ──────────────────────────────────────────────────────────────

async function check314(dev) {
  const route = await routeExists('/admin/logs/services');
  if (!route.exists) {
    return record('3.14', 'The log proxy is running', STATUS.FAIL, 'DEPLOYMENT-VERIFIED',
      'GET /api/v1/admin/logs/services -> 404: the Service Logs surface is not declared in the running build',
      'environment defect — the deployment predates the log-proxy wiring');
  }
  if (!dev?.token) {
    return record('3.14', 'The log proxy is running', STATUS.UNKNOWN, 'UNKNOWN',
      [
        `the route exists (unauthenticated probe -> HTTP ${route.status}, i.e. it is declared and guarded).`,
        `It is DEVELOPER-only and ADMIN cannot reach it — ${dev?.error ?? 'no DEVELOPER credential supplied'}.`,
        'Whether a dockerproxy container is actually up is only answerable through this surface: a 503',
        'naming "Cannot reach the Docker log proxy" is what an absent proxy looks like.',
      ].join('\n'));
  }
  const r = await req('/admin/logs/services', { token: dev.token });
  const msg = String(r.msg ?? '');
  if (r.status === 503 && /Docker log proxy/i.test(msg)) {
    return record('3.14', 'The log proxy is running', STATUS.FAIL, 'DEPLOYMENT-VERIFIED', `GET /admin/logs/services -> 503 ${msg}`,
      'environment defect — the dockerproxy container is not running');
  }
  if (r.status !== 200) {
    return record('3.14', 'The log proxy is running', STATUS.UNKNOWN, 'UNKNOWN', `GET /admin/logs/services -> ${r.status} ${msg}`);
  }
  const services = r.body?.data?.services ?? [];
  const running = services.filter((s) => s.running).map((s) => s.containerName ?? s.name);
  record('3.14', 'The log proxy is running', running.length ? STATUS.PASS : STATUS.FAIL, 'DEPLOYMENT-VERIFIED',
    `${services.length} services reported; running: ${running.join(', ') || 'NONE'}`,
    running.length ? null : 'environment defect — the proxy answered but reports no running containers');
}

// ── 3.15 The deployment is serving the commit you think it is ──────────────────────────────────

/**
 * Nothing in the product reports its build, and there is no shell on the remote container, so this
 * fingerprints what is actually being served two independent ways:
 *
 *   FRONTEND  the SPA is static and public. Its chunks are content-hashed, so their bytes ARE the
 *             build. Fetch every chunk the app references and grep for string literals that a known
 *             commit introduced; presence brackets the build from below, absence from above. The
 *             asset's Last-Modified is a third, independent datum.
 *   BACKEND   route existence. A route a later commit ADDED answers 404 on an older build and 401
 *             on a newer one, and the two are trivially distinguishable without any credential.
 *
 * Both are reported, because they are separate containers and can drift apart.
 */
const MARKERS = [
  // [what to grep for, the commit that introduced it, human note]
  ['showing nothing rather than a partial or misleading view', '41f60beb', 'LoadFailure.tsx — "say when a screen failed to load"'],
  ['Nothing is published at', 'fcaca208', 'NotFound.tsx — "show a 404 instead of redirecting"'],
  ['This record could not be loaded', '4b4cfa14', 'AssayerRecord — origin/main + origin/test tip'],
  ['PostLoginRedirect', '4b4cfa14', 'PostLoginRedirect.tsx — new file at origin tip'],
];

/** Is `commit` an ancestor of `of`? Answers false when either is unknown to this checkout. */
function isAncestor(commit, of) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, of], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * Was the code introduced at `commit` in the build this deployment is running?
 *
 * The rule is one-directional and safe: if the build is missing a marker from commit M, then it is
 * also missing everything that landed at or after M. So a feature whose introducing commit is at or
 * after ANY absent marker is definitively absent. Anything else is left null rather than guessed —
 * this is exactly the inference that was wrong once, and a wrong "yes" here silently upgrades an
 * UNKNOWN into a PASS.
 */
function featureInRunningBuild(introducedAt, fingerprint) {
  if (!fingerprint) return null;
  for (const f of fingerprint.markers) {
    if (!f.present && isAncestor(f.commit, introducedAt)) return false;
  }
  return null;
}

async function check315(fp) {
  const { markers: found, chunkCount, lastModified, outbox, control, expected } = fp;

  const newestPresent = found.filter((f) => f.present).map((f) => f.commit);
  const absent = found.filter((f) => !f.present).map((f) => f.commit);
  const drifted = absent.length > 0;

  const observed = [
    `frontend chunks fetched: ${chunkCount}; Last-Modified on the entry chunk: ${lastModified ?? '(none)'}`,
    ...found.map((f) => `  marker from ${f.commit} — ${f.present ? 'PRESENT' : 'absent '}  (${f.note})`),
    `backend route probe: /admin/outbox/health -> ${outbox.status} (${outbox.exists ? 'declared' : 'NOT declared in the running build'}); control /users/me -> ${control.status}`,
    `markers present from: ${newestPresent.join(', ') || 'none'}; absent from: ${absent.join(', ') || 'none'}`,
    expected ? `expected build: ${expected}` : 'expected build: (not determined)',
    'method: content-fingerprinting of the served, content-hashed SPA chunks against string literals',
    'unique to known commits, plus backend route-existence probing. No container exec was used.',
  ].join('\n');

  record('3.15', 'The deployment is serving the commit you think it is', drifted ? STATUS.FAIL : STATUS.PASS,
    'DEPLOYMENT-VERIFIED', observed,
    drifted ? 'environment defect — the deployment is running an older build than the branch being certified' : null);
}

/** Fetch and fingerprint the running build. Read-only; runs before the checks that depend on it. */
async function fingerprintBuild() {
  const idx = await fetchText(`${ORIGIN}/`);
  const chunkNames = new Set();
  for (const m of idx.text.matchAll(/\/assets\/([A-Za-z0-9_.-]+\.js)/g)) chunkNames.add(m[1]);
  // The entry chunk names the lazy ones; one hop is enough to reach the whole graph.
  const seeds = [...chunkNames];
  const bodies = [];
  let lastModified = null;
  for (const name of seeds) {
    const r = await fetchText(`${ORIGIN}/assets/${name}`);
    if (!lastModified) lastModified = r.headers?.get('last-modified') ?? null;
    bodies.push(r.text);
    for (const m of r.text.matchAll(/assets\/([A-Za-z0-9_.-]+\.js)/g)) chunkNames.add(m[1]);
  }
  for (const name of chunkNames) {
    if (seeds.includes(name)) continue;
    const r = await fetchText(`${ORIGIN}/assets/${name}`);
    bodies.push(r.text);
  }
  const haystack = bodies.join('\n');
  const markers = MARKERS.map(([needle, commit, note]) => ({ commit, note, present: haystack.includes(needle) }));

  // Backend: a route added after the frontend's apparent build point.
  const outbox = await routeExists('/admin/outbox/health');
  const control = await routeExists('/users/me');

  let expected = EXPECT_COMMIT;
  if (!expected) {
    try { expected = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { expected = null; }
  }

  return { markers, chunkCount: chunkNames.size, lastModified, outbox, control, expected };
}

// ── optional database access ───────────────────────────────────────────────────────────────────

/**
 * Deliberately opt-in and deliberately timeboxed. `_lib.mjs` builds a pool pointed at the LOCAL rig
 * by default, and a script that quietly connects to whatever is on 127.0.0.1:5432 while claiming to
 * certify a remote deployment writes rows to one database and reads another — the README calls this
 * out as the thing that will waste your afternoon. So: nothing connects unless AC_DB=1 says so.
 */
async function openDatabase() {
  if (env.AC_DB !== '1') return { ok: false, why: 'AC_DB was not set to 1, so no database connection was attempted' };
  try {
    const { sql } = await import('./_lib.mjs');
    const probe = Promise.race([
      sql('SELECT 1 AS ok'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 8s')), 8000)),
    ]);
    await probe;
    return { ok: true, query: async (q, p) => sql(q, p) };
  } catch (e) {
    return { ok: false, why: `could not connect: ${e.message}` };
  }
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nFAPOMS deployment certification — docs/go-live-checklist.md §3`);
  console.log(`target: ${API}`);
  console.log(`mode:   read-only${ALLOW_EICAR ? ' + EICAR upload' : ''}${ALLOW_WRITES ? ' + business writes' : ''}\n`);

  // Fingerprint the running build FIRST. 3.4 depends on it: whether "the API booted" proves
  // anything about the database identity turns entirely on whether the gate that would have
  // stopped the boot is even present in the build being served.
  const fp = await fingerprintBuild();

  let hasRuntimeIdentityAssertion = null;
  try {
    // The oldest commit touching the symbol is the one that introduced it.
    const out = execFileSync('git', ['log', '--reverse', '--format=%H', '-S', 'assertDatabaseIdentity', '--', 'packages/backend/src/main.ts'], { encoding: 'utf8' }).trim();
    const introducedAt = out.split('\n')[0];
    if (introducedAt) hasRuntimeIdentityAssertion = featureInRunningBuild(introducedAt, fp);
  } catch { hasRuntimeIdentityAssertion = null; }

  const admin = env.AC_USERNAME && env.AC_PASSWORD
    ? await signIn(env.AC_USERNAME, env.AC_PASSWORD)
    : { error: 'AC_USERNAME/AC_PASSWORD not supplied' };
  if (admin.token) console.log(`signed in as ${env.AC_USERNAME}\n`);
  else console.log(`NOT signed in: ${admin.error}\n`);

  let dev = { error: 'AC_DEVELOPER_LOGIN not supplied' };
  if (env.AC_DEVELOPER_LOGIN) {
    const i = env.AC_DEVELOPER_LOGIN.indexOf(':');
    dev = await signIn(env.AC_DEVELOPER_LOGIN.slice(0, i), env.AC_DEVELOPER_LOGIN.slice(i + 1));
  }

  const db = await openDatabase();
  if (!db.ok) console.log(`database: ${db.why}\n`);

  await check31();
  const prodInferred = RESULTS.find((r) => r.id === '3.1 ')?.evidence?.startsWith('INFERRED');
  await check32(admin);
  check33();
  await check34({ hasRuntimeIdentityAssertion }, db);
  await check35(dev);
  await check36();
  await check37();
  await check38();
  await check39(Boolean(prodInferred));
  await check310(admin);
  check311();
  await check312(db);
  await check313();
  await check314(dev);
  await check315(fp);

  // ── summary ──
  const count = (s) => RESULTS.filter((r) => r.status === s).length;
  console.log('─'.repeat(100));
  console.log('  #     check                                              status   evidence');
  console.log('─'.repeat(100));
  for (const r of RESULTS) {
    console.log(`  ${r.id}  ${r.title.slice(0, 48).padEnd(50)} ${r.status.padEnd(8)} ${r.evidence}`);
  }
  console.log('─'.repeat(100));
  console.log(`  ${count(STATUS.PASS)} PASS   ${count(STATUS.FAIL)} FAIL   ${count(STATUS.UNKNOWN)} UNKNOWN   ${count(STATUS.NA)} N/A   of ${RESULTS.length}`);
  if (count(STATUS.UNKNOWN) > 0) {
    console.log(`\n  ${count(STATUS.UNKNOWN)} checks could not be run from here. An UNKNOWN is not a pass, and a certification`);
    console.log('  carrying this many of them is not a certification — it is a list of what is still owed.');
  }
  console.log('');

  try { const { pool } = await import('./_lib.mjs'); await pool.end(); } catch { /* never connected */ }
  process.exit(count(STATUS.FAIL) ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
