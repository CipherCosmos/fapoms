#!/usr/bin/env node
/**
 * FAPOMS production acceptance — reliability: does one event produce exactly one business effect?
 *
 * The other acceptance scripts ask whether the happy path works and whether authorization holds.
 * This one asks the questions that only have answers on a real deployment, under duplication and
 * partial failure:
 *
 *   1. A domain event delivered TWICE must book money ONCE, and the second delivery must not
 *      become a poison pill that jams the relay behind it. (`outbox.relay.ts`, `unique-violation.ts`)
 *   2. The thing that drains the outbox is the WORKER replica. An api-only deployment silently
 *      stops relaying events; that trap is only visible if you stop the worker and watch.
 *   3. A refused mutation must leave a truthful trace. The success-shaped audit row rides the
 *      business transaction and dies with it; the refusal is written out of band so it survives.
 *   4. Six simultaneous presses of one button are one business event, not six.
 *   5. What the outbox's own operational surface shows, and who may see it.
 *
 * Everything it creates through the product is prefixed ACC-REL so a later run can tell its own
 * leftovers apart from seeded data and from the other acceptance scripts' rows.
 *
 * Destructive-probe rule: `audit_events` is never TRUNCATEd or DELETEd from, and any SQL probe
 * that could remove data runs inside a transaction that is always rolled back. See
 * docs/incident-2026-09-09-audit-truncate.md for why that rule exists.
 */
/**
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * SAFETY CLASSIFICATION: DESTRUCTIVE — STOPS CONTAINERS
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THE MOST DANGEROUS SCRIPT HERE. It does not only write; it takes the deployment apart.
 * containers  : `docker stop` and `docker start` on the WORKER container (AC_WORKER, default
 *               deploy-backend-worker-1) to prove an api-only deployment drains no outbox. While
 *               it is stopped NOTHING is processed: no payables, no audit sealing, no retention.
 *               It also runs redis-cli inside the Redis container to read Bull's repeat keys.
 * api writes  : creates assignments tagged ACC-REL and completes them, which books real money.
 * destructive : SQL probes that could remove data run inside a transaction that is ALWAYS rolled
 *               back, and audit_events is never TRUNCATEd or DELETEd from. That rule is the
 *               lesson of docs/incident-2026-09-09-audit-truncate.md.
 * gate        : none of its own — it does not use _lib.mjs. DO NOT run it against a deployment
 *               anybody is using.
 *
 * The full table for every script here is in scripts/acceptance/README.md.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// `pg` lives in the workspace, not beside this script.
const require = createRequire(
  process.env.AC_REPO ? `${process.env.AC_REPO}/package.json`
    : '/Users/deepstacker/WorkSpace/dupcq/gssAutomation/package.json');
const { Client } = require('pg');

const API = process.env.AC_API || 'http://127.0.0.1:8080/api/v1';
const PW = process.env.AC_PASSWORD;
const WORKER = process.env.AC_WORKER || 'deploy-backend-worker-1';
const REDIS_CT = process.env.AC_REDIS || 'deploy-redis-1';
const DBC = {
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 55432),
  user: process.env.DB_USERNAME || 'fapoms', password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
};

/** The relay's own constants, mirrored so the waits are derived rather than guessed. */
const GRACE_MS = 30_000;        // FAST_PATH_GRACE_MS in outbox.relay.ts
const TICK_MS = 60_000;         // PersistenceModule.CRON = '* * * * *'
const REDELIVERY_BUDGET_MS = Number(process.env.AC_REDELIVERY_MS || 180_000);
const SILENCE_BUDGET_MS = Number(process.env.AC_SILENCE_MS || 2.25 * TICK_MS);

const results = [];
const notes = [];
let db;
/** Set the moment the worker is stopped, so the always-restart path knows it has work to do. */
let workerIsStopped = false;
/** Probe rows this run inserted into `outbox_events`, reported at the end rather than deleted. */
const probeRows = [];

const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  [${id}] ${detail}`);
};
const note = (text) => { notes.push(text); console.log(`  NOTE  ${text}`); };
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 74 - title.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (token, method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    retryAfter: Number(res.headers.get('retry-after')) || null,
    body: await res.json().catch(() => null),
  };
};

/**
 * `POST /auth/login` through the login throttle.
 *
 * Twenty logins a minute per IP (see main.ts, and the `trust proxy` note beside it) is a real
 * control, not an obstacle to route around — but every acceptance script in this campaign arrives
 * from the same host address, so a run can be refused for somebody else's logins. Waiting out a
 * 429 is the honest response; failing the whole suite on one would report a defect that is not there.
 */
const login = async (username, password) => {
  for (let attempt = 0; ; attempt++) {
    const r = await call(null, 'POST', '/auth/login', { username, password });
    if (r.status !== 429 || attempt >= 6) return r;
    const waitMs = Math.min((r.retryAfter ?? 0) * 1000 || 20_000 * (attempt + 1), 90_000);
    console.log(`  (login throttled for ${username}; waiting ${(waitMs / 1000).toFixed(0)}s — `
      + `another client is using the same per-IP budget)`);
    await sleep(waitMs);
  }
};

/** Sign in, clearing a forced rotation. Tries the campaign password first so re-runs are no-ops. */
const signIn = async (username, seedPw, changePath) => {
  let r = await login(username, PW);
  if (!r.body?.data?.accessToken) {
    r = await login(username, seedPw);
    if (!r.body?.data?.accessToken) throw new Error(`login failed for ${username}: HTTP ${r.status}`);
    const t = r.body.data.accessToken;
    const chg = await call(t, 'POST', changePath, { currentPassword: seedPw, newPassword: PW });
    if (chg.status >= 400) throw new Error(`rotate failed for ${username}: ${JSON.stringify(chg.body)}`);
    r = await login(username, PW);
    if (!r.body?.data?.accessToken) throw new Error(`login after rotation failed for ${username}: HTTP ${r.status}`);
  }
  return { token: r.body.data.accessToken, id: r.body.data.user.id, username, seedPw, changePath };
};

/**
 * Call as a persona, renewing the token if it has aged out.
 *
 * This suite deliberately spends minutes waiting — two relay ticks with the worker down, three
 * more for a redelivery — and an access token can expire inside one of those waits. A 401 then
 * means "this run's own token got old", which is not the same claim as 403 "the product refused
 * you". Reported as-is it turns REL-50/51 into a finding about authorization that is really a
 * finding about the clock, so the token is renewed once and the call repeated.
 */
const callAs = async (who, method, path, body) => {
  const r = await call(who.token, method, path, body);
  if (r.status !== 401) return r;
  const fresh = await signIn(who.username, who.seedPw, who.changePath);
  who.token = fresh.token;
  return call(who.token, method, path, body);
};

/**
 * Poll `probe` until it answers truthily or the budget runs out. Returns how long it took, which
 * is the number worth reporting: "eventually dispatched" and "dispatched in 41s" are different
 * claims about a one-minute relay.
 */
const until = async (probe, budgetMs, everyMs = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return { ok: true, ms: Date.now() - t0, value };
    if (Date.now() - t0 >= budgetMs) return { ok: false, ms: Date.now() - t0, value };
    await sleep(everyMs);
  }
};

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const redisCli = (...args) => { try { return docker('exec', REDIS_CT, 'redis-cli', ...args); } catch { return ''; } };

/**
 * What Bull actually has scheduled for the relay, rather than what the boot log claimed.
 *
 * The claim and the fact are different things here, and this run found them disagreeing. Every
 * cron in this system — the relay's drain, the audit seal, retention, the SLA scan — exists only
 * as two Redis keys: a member of `bull:<queue>:repeat`, and one delayed job carrying the next
 * firing. `ensureRepeatableSchedules` writes them once at boot and logs "registered"; nothing
 * re-checks afterwards. If those keys are lost, Bull's own re-scheduling is conditional on the
 * repeat member still existing (`nextRepeatableJob` does a ZSCORE and returns silently when it is
 * gone), so the schedule does not degrade — it ends, permanently and without a log line, until
 * somebody restarts the process.
 */
const relaySchedule = () => ({
  repeat: Number(redisCli('ZCARD', 'bull:outbox:repeat')) || 0,
  delayed: Number(redisCli('ZCARD', 'bull:outbox:delayed')) || 0,
});
const workerState = () => {
  try {
    return docker('inspect', '-f',
      '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}', WORKER);
  } catch { return 'absent/nohealth'; }
};
/** Restarting the worker is not optional and not conditional on the run succeeding. */
const ensureWorkerRunning = () => {
  if (!workerIsStopped) return;
  try {
    docker('start', WORKER);
    workerIsStopped = false;
    console.log(`\n  (worker ${WORKER} restarted)`);
  } catch (e) {
    console.error(`\n  !! COULD NOT RESTART ${WORKER}: ${e.message} — start it by hand.`);
  }
};

/**
 * Copy one outbox row back into the table as a fresh, due, undispatched event.
 *
 * `occurred_at` is put a second beyond FAST_PATH_GRACE_MS in the past so the relay's next tick
 * considers it immediately; a row younger than the grace is deliberately left alone (it would
 * otherwise race the in-process publish of an event that has only just committed).
 */
const redeliver = async (sourceOutboxId) => {
  const [row] = await q(
    `INSERT INTO outbox_events (id, event_name, payload, occurred_at, dispatched_at, attempts)
     SELECT gen_random_uuid(), event_name, payload,
            now() - interval '${(GRACE_MS / 1000) + 1} seconds', NULL, 0
       FROM outbox_events WHERE id = $1
     RETURNING id, event_name`, [sourceOutboxId]);
  if (!row) throw new Error(`no outbox row ${sourceOutboxId} to copy`);
  probeRows.push(row.id);
  return row;
};

const outboxRow = async (id) => (await q(
  `SELECT dispatched_at, failed_at, attempts, last_error FROM outbox_events WHERE id=$1`, [id]))[0];

const countsFor = async (assignmentId) => {
  const [c] = await q(
    `SELECT (SELECT count(*)::int FROM assayer_payables WHERE assignment_id=$1) AS payables,
            (SELECT count(*)::int FROM billing_entries  WHERE assignment_id=$1) AS entries`,
    [assignmentId]);
  return c;
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════

(async () => {
  db = new Client(DBC);
  await db.connect();
  console.log(`\n=== FAPOMS acceptance — reliability under duplication and partial failure ===`);
  console.log(`API ${API}   worker container ${WORKER} (${workerState()})\n`);

  const admin = await signIn('admin', 'admin123', '/users/me/change-password');
  const exec = await signIn('executive', 'admin123', '/users/me/change-password');
  console.log(`signed in: admin=${admin.id.slice(0, 8)} executive=${exec.id.slice(0, 8)}`);

  // ── 0. is the relay even scheduled? ─────────────────────────────────────────────────────────
  // Asked first, and asked of Redis rather than of the boot log, because everything below assumes
  // a relay that ticks. Without this the same symptom — an event that never gets dispatched —
  // reads as "redelivery is broken" when the truth is "nothing is scheduled to deliver anything".
  section('CHECK 0 — the relay is scheduled at all');
  const sched0 = relaySchedule();
  record('REL-01', sched0.repeat >= 1,
    `the outbox drain is a registered repeatable in Redis (bull:outbox:repeat holds ${sched0.repeat} `
    + `schedule(s))`);
  record('REL-02', sched0.delayed >= 1,
    `and a next tick is actually queued (bull:outbox:delayed holds ${sched0.delayed} job(s))`);
  if (sched0.repeat < 1 || sched0.delayed < 1) {
    note('the relay is NOT scheduled. Every check below that waits for an event to be relayed will '
      + 'fail, and the cause is the missing schedule, not the outbox. Restarting the worker '
      + 're-registers it — which is also the only thing that does.');
  }

  // ── fixture: one assignment of this run's own, taken to CHECKED_IN ──────────────────────────
  // Built first because three of the five checks need a freshly-booked assignment: the duplicate
  // submit is performed on it, the redelivery probe copies ITS booking event, and the duties
  // refusal is attempted against ITS payable. Using one fixture for all three also means the
  // "still exactly one payable" assertions are about a payable whose whole history this run saw.
  section('fixture');

  // An assayer may hold only one OPEN assignment per day, so a previous run's leftovers would be
  // refused as a double booking. Cancelled through the product, never deleted.
  const stale = await q(
    `SELECT id FROM assignments WHERE remarks LIKE 'ACC-REL%' AND is_active
        AND status IN ('PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS')`);
  for (const s of stale) {
    await callAs(exec, 'POST', `/assignments/${s.id}/cancel`,
      { reason: 'Reliability run: clearing an earlier run of this same probe.' });
  }
  if (stale.length) console.log(`cleared ${stale.length} open assignment(s) from an earlier run`);

  const today = new Date().toISOString().slice(0, 10);

  /**
   * Candidate (assayer, project branch) pairs, and why this is a search rather than a lookup.
   *
   * Which pair is legal is not this script's to decide. An appraiser too CLOSE to a branch is a
   * conflict of interest and that refusal is explicitly NOT overridable (`RULE_NOT_OVERRIDABLE`);
   * one too far needs a stated reason, which is. Straight-line distance is only a heuristic for
   * whatever distance the rule actually measures, and the threshold is a per-client setting, so
   * the fixture proposes pairs in turn and lets the API be the judge. Asserting a pair this script
   * merely believes should work is how a fixture starts reporting the product as broken because
   * the seed data moved.
   */
  const candidates = await q(
    `WITH pairs AS (
       SELECT a.id AS assayer_id, a.assayer_code, pb.id AS pb_id, pb.branch_id, b.name AS branch,
              p.id AS project_id, p.client_id, p.end_date,
              round((6371 * acos(least(1,
                cos(radians(a.latitude)) * cos(radians(b.latitude))
                  * cos(radians(b.longitude) - radians(a.longitude))
                + sin(radians(a.latitude)) * sin(radians(b.latitude)))))::numeric, 1) AS km
         FROM assayers a
         JOIN project_branches pb ON TRUE
         JOIN branches b ON b.id = pb.branch_id
         JOIN projects p ON p.id = pb.project_id
        WHERE a.lifecycle_status='ACTIVE' AND a.is_active AND a.assayer_code LIKE 'AS-%'
          AND a.latitude IS NOT NULL AND b.latitude IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM assignments x
                           WHERE x.project_branch_id = pb.id AND x.is_active
                             AND x.status IN ('PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS'))
          AND NOT EXISTS (SELECT 1 FROM assignments y
                           WHERE y.assayer_id = a.id AND y.is_active AND y.scheduled_date = CURRENT_DATE
                             AND y.status IN ('PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS'))
     )
     SELECT * FROM pairs ORDER BY (km >= 5) DESC, km ASC LIMIT 25`);
  if (candidates.length === 0) throw new Error('no free (assayer, project branch) pair to build a fixture from');

  if (candidates.every((c) => c.end_date && new Date(c.end_date) < new Date(today))) {
    note('every candidate project window is closed; widening them so work can be scheduled today '
      + '(the timeline rule itself is covered by business-loop.mjs E2E-00)');
    await q(`UPDATE projects SET end_date=$1 WHERE id = ANY($2::uuid[])`,
      ['2027-12-31', [...new Set(candidates.map((c) => c.project_id))]]);
  }

  let fx = null;
  const rejectedPairs = [];
  for (const c of candidates) {
    // Empanelment with this client satisfies the eligibility policy on merit rather than by
    // override, so a later refusal is never really "this assayer was never on the panel".
    await callAs(admin, 'PUT', `/assayers/${c.assayer_id}/empanelment/${c.client_id}`, { status: 'ACTIVE' });
    const base = {
      projectBranchId: c.pb_id, assayerId: c.assayer_id, proposedFee: 2500,
      scheduledDate: today, remarks: 'ACC-REL reliability probe',
    };
    let r = await callAs(exec, 'POST', '/assignments', base);
    if (r.status === 400 && r.body?.code === 'OVERRIDE_REASON_REQUIRED') {
      r = await callAs(exec, 'POST', '/assignments', {
        ...base,
        overrideReason: 'Reliability run: desk approved the travel for this probe assignment.',
      });
    }
    if (r.status < 400) { fx = { ...c, assignmentId: r.body.data.id }; break; }
    rejectedPairs.push(`${c.assayer_code}@${c.branch} ${c.km}km -> ${r.body?.code ?? r.status}`);
  }
  if (!fx) {
    throw new Error(`could not create a probe assignment from ${candidates.length} candidate pair(s): `
      + rejectedPairs.join('; '));
  }
  const asgId = fx.assignmentId;
  console.log(`fixture: assayer ${fx.assayer_code}  branch "${fx.branch}" (${fx.km}km)  date ${today}`);
  if (rejectedPairs.length) console.log(`  (skipped ${rejectedPairs.length} pair(s): ${rejectedPairs.join('; ')})`);

  // Payout details are mandatory at approval. Set through the product so the encrypted columns
  // round-trip as a real edit would, and so the duties refusal later is refused for the reason
  // under test rather than for missing banking.
  const payoutSetup = await callAs(admin, 'PUT', `/assayers/${fx.assayer_id}`, {
    bankAccountNumber: '50100234567890', ifscCode: 'HDFC0001234',
    bankName: 'HDFC Bank', panNumber: 'ABCPD1234E',
  });
  const [banked] = await q(
    `SELECT bank_account_number IS NOT NULL AS bank, ifsc_code IS NOT NULL AS ifsc,
            pan_number IS NOT NULL AS pan FROM assayers WHERE id=$1`, [fx.assayer_id]);
  if (!banked.bank || !banked.ifsc || !banked.pan) {
    throw new Error(`payout details did not persist (HTTP ${payoutSetup.status}) — the duties refusal `
      + `would then be refused for missing banking rather than for the reason under test`);
  }

  const asr = await signIn(fx.assayer_code, 'assayer123', '/assayers/me/change-password');
  await callAs(asr, 'POST', `/assignments/${asgId}/accept`, {});
  const [geo] = await q(`SELECT latitude, longitude FROM branches WHERE id=$1`, [fx.branch_id]);
  await callAs(asr, 'POST', `/assignments/${asgId}/check-in`, {
    latitude: Number(geo?.latitude ?? 18.52), longitude: Number(geo?.longitude ?? 73.86), accuracy: 12,
  });
  const [preState] = await q(`SELECT status, entity_version FROM assignments WHERE id=$1`, [asgId]);
  console.log(`fixture assignment ${asgId} is ${preState.status} at version ${preState.entity_version}`);
  if (!['ACCEPTED', 'CHECKED_IN'].includes(preState.status)) {
    throw new Error(`fixture did not reach ACCEPTED/CHECKED_IN (it is ${preState.status})`);
  }

  // ── 4. six simultaneous presses of one button ───────────────────────────────────────────────
  // Sent without a clientRequestId on purpose. The idempotency-record path only exists when the
  // caller supplies one, so omitting it tests the guard that has to hold for a raw API caller —
  // the version comparison plus the state machine — rather than the easy case.
  section('CHECK 4 (priority 4) — duplicate / concurrent submits');
  const shots = await Promise.all(Array.from({ length: 6 }, () =>
    call(exec.token, 'POST', `/assignments/${asgId}/complete`,
      { reason: 'Reliability run: six simultaneous completions of one assignment.' })));
  const codes = shots.map((s) => s.status);
  const ok2xx = codes.filter((c) => c < 400).length;

  const [afterRace] = await q(`SELECT status, entity_version FROM assignments WHERE id=$1`, [asgId]);
  record('REL-40', afterRace.status === 'COMPLETED',
    `six simultaneous completes leave the assignment COMPLETED (statuses ${codes.join(',')}; `
    + `DB status=${afterRace.status})`);

  const [{ c: completedAudits }] = await q(
    `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND event_type='ASSIGNMENT_COMPLETED'`,
    [asgId]);
  record('REL-41', completedAudits === 1,
    `and exactly one ASSIGNMENT_COMPLETED audit row, not six (${completedAudits}; ${ok2xx}/6 calls `
    + `returned 2xx, version ${preState.entity_version} -> ${afterRace.entity_version})`);

  record('REL-42', Number(afterRace.entity_version) === Number(preState.entity_version) + 1,
    `the row advanced by exactly one version, so five of the six wrote nothing `
    + `(${preState.entity_version} -> ${afterRace.entity_version})`);

  // The payable is booked by the worker off the event bus, so it arrives after the response.
  const booked = await until(async () => {
    const c = await countsFor(asgId);
    return c.payables > 0 ? c : null;
  }, 120_000);
  const raceCounts = booked.value ?? await countsFor(asgId);
  record('REL-43', raceCounts.payables === 1,
    `six completions book exactly one payable (payables=${raceCounts.payables}, `
    + `client lines=${raceCounts.entries}, booked ${(booked.ms / 1000).toFixed(0)}s after the race)`);
  if (raceCounts.payables !== 1) {
    throw new Error('the fixture did not book exactly one payable — the redelivery and duties '
      + 'checks below would be measuring the wrong thing');
  }

  // ── 1. a redelivered event must produce one business effect, and must not poison the relay ──
  section('CHECK 1 (priority 1) — outbox redelivery is safe');
  const [booking] = await q(
    `SELECT id, event_name FROM outbox_events
      WHERE event_name='assignment:status-changed'
        AND payload->>'assignmentId' = $1 AND payload->>'newState'='COMPLETED'
      ORDER BY occurred_at DESC LIMIT 1`, [asgId]);
  if (!booking) throw new Error(`no booking event on the outbox for assignment ${asgId}`);

  const beforeRedelivery = await countsFor(asgId);
  const dup = await redeliver(booking.id);
  console.log(`  inserted duplicate outbox row ${dup.id} (${dup.event_name}), due ${(GRACE_MS / 1000) + 1}s ago`);

  const relayed = await until(async () => {
    const r = await outboxRow(dup.id);
    return (r.dispatched_at || r.failed_at) ? r : null;
  }, REDELIVERY_BUDGET_MS);
  const dupRow = relayed.value ?? await outboxRow(dup.id);
  const schedNow = relaySchedule();

  record('REL-10', !!dupRow.dispatched_at,
    `the redelivered event is dispatched (dispatched_at=${dupRow.dispatched_at ? 'set' : 'NULL'} `
    + `after ${(relayed.ms / 1000).toFixed(0)}s, attempts=${dupRow.attempts}`
    + `${dupRow.dispatched_at ? '' : `; at that moment bull:outbox:repeat=${schedNow.repeat}, `
      + `delayed=${schedNow.delayed} — a zero there means the relay was never scheduled to run`})`);
  record('REL-11', dupRow.failed_at === null,
    `and it does not dead-letter — a duplicate is absorbed, not a poison pill `
    + `(failed_at=${dupRow.failed_at ? 'SET' : 'NULL'}, last_error=${dupRow.last_error ?? 'none'})`);

  // Give the subscriber's own asynchronous work (enqueue -> billing job) time to land before
  // counting, so a "still one" that is really "not yet two" cannot pass.
  await sleep(15_000);
  const afterRedelivery = await countsFor(asgId);
  record('REL-12', afterRedelivery.payables === 1 && afterRedelivery.entries === 1,
    `one event delivered twice is still one payable and one client line `
    + `(payables ${beforeRedelivery.payables}->${afterRedelivery.payables}, `
    + `entries ${beforeRedelivery.entries}->${afterRedelivery.entries})`);

  // The relay processes a batch in order; a row that threw would stop being marked and would take
  // its retry slot forever. Nothing else on the outbox may have been left behind by this probe.
  const [{ c: stuck }] = await q(
    `SELECT count(*)::int c FROM outbox_events
      WHERE dispatched_at IS NULL AND failed_at IS NULL
        AND occurred_at < now() - interval '5 minutes'`);
  record('REL-13', stuck === 0,
    `and the relay is not jammed behind it: ${stuck} event(s) older than 5 minutes are still undispatched`);

  // ── 3. a refused mutation must leave a truthful trace ───────────────────────────────────────
  section('CHECK 3 (priority 3) — audit rides the business transaction');
  const [payable] = await q(
    `SELECT id, status, payable_number, approved_by, approved_at
       FROM assayer_payables WHERE assignment_id=$1`, [asgId]);
  const [asgOwner] = await q(`SELECT created_by FROM assignments WHERE id=$1`, [asgId]);
  console.log(`  payable ${payable.payable_number} (${payable.status}); the assignment was booked `
    + `by ${asgOwner.created_by === exec.id ? 'executive' : asgOwner.created_by}`);

  const beforeApprovals = Number((await q(
    `SELECT count(*)::int c FROM audit_events
      WHERE entity_id=$1 AND event_type='PAYABLE_APPROVED' AND outcome='SUCCESS'`, [payable.id]))[0].c);

  // The refusal happens INSIDE the approval transaction, after the payable has been locked FOR
  // UPDATE — i.e. after work has been done. Everything that transaction did must unwind.
  const refusedApproval = await callAs(exec, 'POST', '/billing-engine/payouts/approve',
    { payableIds: [payable.id] });
  const reason = (refusedApproval.body?.data?.refused?.[0]?.reason
    ?? refusedApproval.body?.message ?? '').toString();

  const [p2] = await q(
    `SELECT status, approved_by, approved_at, destination_verified_at, destination_bank_account_number
       FROM assayer_payables WHERE id=$1`, [payable.id]);
  record('REL-30', p2.status === 'PENDING' && p2.approved_by === null && p2.approved_at === null,
    `the refused approval left the payable untouched (status ${payable.status}->${p2.status}, `
    + `approved_by=${p2.approved_by ?? 'NULL'}, approved_at=${p2.approved_at ?? 'NULL'})`);
  record('REL-31', p2.destination_verified_at === null && p2.destination_bank_account_number === null,
    `and the banking snapshot the approval would have frozen was not written `
    + `(destination_verified_at=${p2.destination_verified_at ?? 'NULL'}, `
    + `destination account=${p2.destination_bank_account_number ? 'SET' : 'NULL'})`);

  const denials = await q(
    `SELECT outcome, user_id, remarks, metadata FROM audit_events
      WHERE entity_id=$1 AND event_type='SEGREGATION_OF_DUTIES_REFUSED'`, [payable.id]);
  record('REL-32', denials.length === 1 && denials[0].outcome === 'DENIED' && denials[0].user_id === exec.id,
    `the refusal is recorded as SEGREGATION_OF_DUTIES_REFUSED / DENIED against the person who `
    + `tried it (${denials.length} row(s), outcome ${denials[0]?.outcome ?? 'none'}, `
    + `mode ${denials[0]?.metadata?.mode ?? '?'})`);
  record('REL-33', denials.length > 0 && !!denials[0].remarks && /approve its payout/i.test(denials[0].remarks),
    `and it says what was refused, not merely that something was: "${(denials[0]?.remarks ?? '').slice(0, 90)}"`);

  const [{ c: approvals }] = await q(
    `SELECT count(*)::int c FROM audit_events
      WHERE entity_id=$1 AND event_type='PAYABLE_APPROVED' AND outcome='SUCCESS'`, [payable.id]);
  record('REL-34', approvals === beforeApprovals && approvals === 0,
    `and NO success-shaped PAYABLE_APPROVED row was written by the attempt `
    + `(${beforeApprovals} before, ${approvals} after) — the success audit rides the transaction `
    + `and rolled back with it, the refusal did not`);

  // A refusal only means something if the same call would otherwise have succeeded. Without this
  // the three checks above would pass just as well against a payable that was broken anyway.
  const controlApprove = await callAs(admin, 'POST', '/billing-engine/payouts/approve',
    { payableIds: [payable.id] });
  const [p3] = await q(`SELECT status, approved_by FROM assayer_payables WHERE id=$1`, [payable.id]);
  record('REL-35', p3.status === 'APPROVED' && p3.approved_by === admin.id,
    `control: a DIFFERENT account approves the same payable, so the refusal was the duties rule `
    + `and not a broken payable (HTTP ${controlApprove.status}, status ${p3.status})`);
  if (!/approv|duti|booked|same (person|account|user)|segregation/i.test(reason) || /bank|ifsc|pan/i.test(reason)) {
    note(`the refusal message was "${reason}" — check it is about duties and not about banking`);
  }

  // ── 2. the worker is what processes the outbox ──────────────────────────────────────────────
  // The api replica pauses its queues locally at boot (main.ts, PROCESS_ROLE=api), so on a split
  // deployment nothing relays events when the worker is gone. An api-only deployment therefore
  // looks completely healthy and silently stops delivering domain events. This proves the trap is
  // real, and that THIS deployment does not have it.
  section('CHECK 2 (priority 2) — the worker is what processes the outbox');
  console.log(`  stopping ${WORKER} (currently ${workerState()})`);
  docker('stop', WORKER);
  workerIsStopped = true;
  record('REL-20', workerState().startsWith('exited'),
    `the worker replica is stopped (${workerState()})`);

  const orphan = await redeliver(booking.id);
  console.log(`  inserted due outbox row ${orphan.id} with no worker running; waiting `
    + `${(SILENCE_BUDGET_MS / 1000).toFixed(0)}s (~${(SILENCE_BUDGET_MS / TICK_MS).toFixed(1)} relay ticks)`);
  // Probed at both ends of the silence, not just once: the claim being made is that the API looked
  // healthy for the whole window, and one sample at the start cannot support it.
  const aliveBefore = await callAs(admin, 'GET', '/assignments?limit=1');
  await sleep(SILENCE_BUDGET_MS);
  const aliveAfter = await callAs(admin, 'GET', '/assignments?limit=1');
  const silent = await outboxRow(orphan.id);
  record('REL-21', silent.dispatched_at === null && silent.failed_at === null,
    `with the worker down the event is NOT dispatched after ${(SILENCE_BUDGET_MS / 1000).toFixed(0)}s `
    + `(dispatched_at=${silent.dispatched_at ? 'SET' : 'NULL'}, attempts=${silent.attempts}) — `
    + `while the API answered normally at both ends of that window (GET /assignments -> `
    + `${aliveBefore.status} then ${aliveAfter.status}), which is exactly why an api-only `
    + `deployment looks healthy while delivering nothing`);

  console.log(`  starting ${WORKER}`);
  docker('start', WORKER);
  workerIsStopped = false;
  const healthy = await until(() => {
    const s = workerState();
    return (s.startsWith('running') && !s.endsWith('/starting')) ? s : null;
  }, 180_000, 3000);
  console.log(`  worker is ${healthy.value ?? workerState()} after ${(healthy.ms / 1000).toFixed(0)}s`);

  const recovered = await until(async () => {
    const r = await outboxRow(orphan.id);
    return (r.dispatched_at || r.failed_at) ? r : null;
  }, REDELIVERY_BUDGET_MS + TICK_MS);
  const orphanRow = recovered.value ?? await outboxRow(orphan.id);
  record('REL-22', !!orphanRow.dispatched_at && orphanRow.failed_at === null,
    `and the same event IS dispatched once the worker is back `
    + `(dispatched_at=${orphanRow.dispatched_at ? 'set' : 'NULL'}, failed_at=`
    + `${orphanRow.failed_at ? 'SET' : 'NULL'}, ${(recovered.ms / 1000).toFixed(0)}s after restart)`);

  const afterRecovery = await countsFor(asgId);
  record('REL-23', afterRecovery.payables === 1 && afterRecovery.entries === 1,
    `and the recovered redelivery still books nothing new `
    + `(payables=${afterRecovery.payables}, client lines=${afterRecovery.entries})`);

  const schedAfter = relaySchedule();
  record('REL-24', schedAfter.repeat >= 1 && schedAfter.delayed >= 1,
    `the drain schedule survives the stop/start and a next tick is queued again `
    + `(bull:outbox:repeat=${schedAfter.repeat}, delayed=${schedAfter.delayed}) — a worker restart `
    + `is also the ONLY thing that re-registers it, since nothing re-converges the schedules while `
    + `the process is up`);

  // ── 5. dead-letter visibility, and who may look ─────────────────────────────────────────────
  section('CHECK 5 (priority 5) — dead-letter visibility');
  const dl = await callAs(admin, 'GET', '/admin/outbox/dead-letters');
  record('REL-50', dl.status === 403,
    `an ADMIN cannot read the outbox dead-letter queue — it is DEVELOPER-only and @RoleOnly, so `
    + `role implication does not open it (GET /admin/outbox/dead-letters -> ${dl.status})`);
  const health = await callAs(admin, 'GET', '/admin/outbox/health');
  record('REL-51', health.status === 403,
    `and the same gate covers the outbox health counts (GET /admin/outbox/health -> ${health.status})`);
  const anon = await call(null, 'GET', '/admin/outbox/dead-letters');
  record('REL-52', anon.status === 401,
    `and it is not reachable unauthenticated (-> ${anon.status})`);

  const [{ c: developers }] = await q(
    `SELECT count(*)::int c FROM users u JOIN user_roles ur ON ur.user_id=u.id
        JOIN roles r ON r.id=ur.role_id WHERE r.name='DEVELOPER' AND u.is_active`);
  if (developers === 0) {
    note(`no active DEVELOPER account exists on this deployment, so the positive side of that gate `
      + `(a developer CAN read the queue) could not be exercised — nobody can currently work the `
      + `dead-letter queue this deployment might accumulate`);
  }

  // An event nothing subscribes to: does the relay notice, or does it call that delivered?
  const [orphanEvent] = await q(
    `INSERT INTO outbox_events (id, event_name, payload, occurred_at, dispatched_at, attempts)
     VALUES (gen_random_uuid(), 'acceptance:nobody-listens',
             jsonb_build_object('probe','ACC-REL','note','no subscriber exists for this event name'),
             now() - interval '${(GRACE_MS / 1000) + 1} seconds', NULL, 0)
     RETURNING id`);
  probeRows.push(orphanEvent.id);
  const unheard = await until(async () => {
    const r = await outboxRow(orphanEvent.id);
    return (r.dispatched_at || r.failed_at || r.attempts > 0) ? r : null;
  }, REDELIVERY_BUDGET_MS);
  const unheardRow = unheard.value ?? await outboxRow(orphanEvent.id);
  record('REL-53', !!unheardRow.dispatched_at || !!unheardRow.failed_at,
    `an event with no subscriber reaches a terminal state rather than being retried forever `
    + `(dispatched_at=${unheardRow.dispatched_at ? 'set' : 'NULL'}, `
    + `failed_at=${unheardRow.failed_at ? 'set' : 'NULL'}, attempts=${unheardRow.attempts}, `
    + `${(unheard.ms / 1000).toFixed(0)}s)`);
  if (unheardRow.dispatched_at && !unheardRow.failed_at) {
    note(`'acceptance:nobody-listens' was marked DISPATCHED with 0 attempts. `
      + `DomainEventPublisher.deliverLocallyAsync iterates an empty listener list and returns `
      + `without error, so "delivered to nobody" and "delivered" are the same row state. A domain `
      + `event whose subscriber was deleted or renamed is therefore silently discarded, and the `
      + `dead-letter queue never learns of it.`);
  }

  const [{ c: everDeadLettered }] = await q(
    `SELECT count(*)::int c FROM outbox_events WHERE failed_at IS NOT NULL`);
  const [{ c: retrying }] = await q(
    `SELECT count(*)::int c FROM outbox_events WHERE dispatched_at IS NULL AND failed_at IS NULL AND attempts > 0`);
  note(`outbox census: ${everDeadLettered} dead-lettered row(s), ${retrying} retrying, `
    + `${stuck} undispatched older than 5 minutes. No reachable subscriber throws on a malformed `
    + `payload (billing returns early on a missing assignmentId, the realtime gateway returns early `
    + `on a missing server, auth's handlers are fire-and-forget), so the attempts/failed_at path `
    + `could not be driven from outside the process without breaking infrastructure.`);

  // ── summary ─────────────────────────────────────────────────────────────────────────────────
  results.sort((a, b) => a.id.localeCompare(b.id));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  [${r.id}] ${r.detail}`);
  if (notes.length) {
    console.log('\nnotes:');
    for (const n of notes) console.log(`  - ${n}`);
  }
  console.log(`\nfixture assignment ${asgId}\nfixture payable ${payable.id} (${payable.payable_number})`);
  console.log(`probe outbox rows (left in place, dispatched, for retention to purge): ${probeRows.join(', ')}`);
  console.log(`worker ${WORKER} final state: ${workerState()}\n`);

  ensureWorkerRunning();
  await db.end();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\nABORTED:', e.message);
  console.error(e.stack);
  ensureWorkerRunning();
  console.log(`worker ${WORKER} final state: ${workerState()}`);
  try { await db?.end(); } catch {}
  process.exit(2);
});

// A signal is the other way this run can end, and it must not be the way the worker stays down.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { ensureWorkerRunning(); process.exit(130); });
}
