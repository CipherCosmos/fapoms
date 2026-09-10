#!/usr/bin/env node
/**
 * FAPOMS production acceptance — the lifecycle paths the single-transition certification cannot see.
 *
 * `assayer-lifecycle-certification.db.spec.ts` certifies the 150-cell single-transition matrix:
 * for every (from, to) pair, does `POST /assayers/:id/lifecycle` agree with the shared map. That
 * suite is not re-run here. What it cannot answer is what happens when the column is moved by
 * something OTHER than that one endpoint, and there are four such somethings:
 *
 *   1. `POST /assayers/bulk/lifecycle`  — plans a ROUTE and walks it, so a batch can traverse
 *      edges nobody selected. The question is not whether each hop is legal (it is) but whether
 *      the waypoints are decisions somebody has to answer for, and whether a per-hop reason gate
 *      really is per-hop.
 *   2. `DELETE /assayers/:id`           — the documented bypass. It writes ARCHIVED from any state
 *      without consulting the map at all, and cascades a cancellation across live work.
 *   3. `POST /assayers/:id/recovery/reset-onboarding-stage` — writes `lifecycle_status` directly.
 *   4. `PUT /assayers/:assayerId/empanelment/:clientId` — a different state column entirely, with
 *      no state machine at all. Whether that matters depends on the assignment-time hard block,
 *      so section 5 goes and pushes on it.
 *
 * Every probe checks the DATABASE as well as the status code, and counts audit rows as a DELTA
 * across the call — `audit_events` carries a `BEFORE DELETE OR UPDATE` trigger and is append-only,
 * so an absolute count inherits every previous run.
 *
 * Fixtures: `ACLB-` prefix, ids from `gen_random_uuid()` rather than the certification suite's
 * `md5('lcert:'||code)::uuid`, because `BulkTransitionLifecycleDto` validates `@IsUUID('4')` and an
 * md5 digest's version nibble is whatever the digest happened to produce. BLK-03 proves that.
 * Cleanup removes exactly the `ACLB-` prefix and its dependants, and never touches `audit_events`.
 */
import { createRequire } from 'node:module';
const require = createRequire(
  process.env.AC_REPO ? `${process.env.AC_REPO}/package.json`
    : '/Users/deepstacker/WorkSpace/dupcq/gssAutomation/package.json');
const { Client } = require('pg');

const API = process.env.AC_API || 'http://127.0.0.1:8080/api/v1';
const PW = process.env.AC_PASSWORD;
const DBC = {
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 55432),
  user: process.env.DB_USERNAME || 'fapoms', password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
};

const PREFIX = 'ACLB-';
const results = [];
const findings = [];
let db;
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await q(sql, p))[0];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  [${id}] ${detail}`);
};
/**
 * An observation the run is here to make rather than an assertion it can pass or fail.
 *
 * Section 2(d) asks whether a per-assignment audit row exists for work the delete cascade
 * cancelled. Either answer is the deliverable, so recording it as a FAIL would be dishonest and
 * recording it as a PASS would bury it. It gets its own channel and its own severity.
 */
const finding = (id, severity, detail) => {
  findings.push({ id, severity, detail });
  console.log(`  FIND  [${id}] (${severity}) ${detail}`);
};

/**
 * One request, backing off while the throttle says no.
 *
 * The per-IP throttle is doing its job when a script fires a hundred writes as fast as the event
 * loop allows — and this deployment is shared, so the budget is being spent by other runs too.
 * A 429 left unhandled reads like a lifecycle defect, which is a worse outcome than being slow.
 * `/auth/login` has the tightest bucket of the lot, which is why the backoff has to be patient
 * rather than a single retry.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (token, method, path, body) => {
  const send = () => fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let res = await send();
  for (const wait of [1500, 3000, 6000, 10000, 15000]) {
    if (res.status !== 429) break;
    await sleep(wait);
    res = await send();
  }
  return { status: res.status, body: await res.json().catch(() => null) };
};

const signIn = async (username, seedPw, changePath) => {
  let r = await call(null, 'POST', '/auth/login', { username, password: PW });
  if (!r.body?.data?.accessToken) {
    r = await call(null, 'POST', '/auth/login', { username, password: seedPw });
    if (!r.body?.data?.accessToken) return null;
    const t = r.body.data.accessToken;
    await call(t, 'POST', changePath, { currentPassword: seedPw, newPassword: PW });
    r = await call(null, 'POST', '/auth/login', { username, password: PW });
  }
  return r.body?.data?.accessToken ? { token: r.body.data.accessToken, id: r.body.data.user.id, username } : null;
};

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────
/** The operational projection `chk_assayers_lifecycle_status_projection` demands. */
const projectionFor = (lc) => (lc === 'ACTIVE' ? 'ACTIVE' : lc === 'SUSPENDED' ? 'SUSPENDED' : 'INACTIVE');
/** `chk_assayers_is_active_consistency`: only ARCHIVED is inactive. */
const isActiveFor = (lc) => lc !== 'ARCHIVED';

let ORG = null;
const CLEANUP = `
DELETE FROM assayer_activities WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE '${PREFIX}%');
DELETE FROM schedules WHERE assignment_id IN (SELECT id FROM assignments WHERE assayer_id IN
  (SELECT id FROM assayers WHERE assayer_code LIKE '${PREFIX}%'));
DELETE FROM assignments WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE '${PREFIX}%');
DELETE FROM assignments WHERE assignment_number LIKE '${PREFIX}%';
DELETE FROM assayer_client_empanelments WHERE assayer_id IN
  (SELECT id FROM assayers WHERE assayer_code LIKE '${PREFIX}%');
DELETE FROM assayers WHERE assayer_code LIKE '${PREFIX}%';
DELETE FROM project_branches WHERE project_id IN (SELECT id FROM projects WHERE project_number LIKE '${PREFIX}%');
DELETE FROM projects WHERE project_number LIKE '${PREFIX}%';
`;

/**
 * A throwaway assayer in an exact lifecycle state, id from `gen_random_uuid()`.
 *
 * Both CHECK constraints are satisfied from the lifecycle value rather than passed in, so a
 * fixture cannot be seeded into a shape the production table would reject.
 */
const seedAssayer = async (suffix, lifecycle) => {
  const code = `${PREFIX}${suffix}`;
  const row = await one(
    `INSERT INTO assayers (id, assayer_code, first_name, last_name, display_name, address,
       state, district, city, lifecycle_status, status, is_active, organization_id, version,
       joining_date, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::text, 'ACLB', $1::text, 'ACLB '||$1::text, 'Acceptance Address',
       'MAHARASHTRA', 'Pune', 'Pune', $2, $3, $4, $5, 1, '2026-01-01', now(), now())
     RETURNING id`,
    [code, lifecycle, projectionFor(lifecycle), isActiveFor(lifecycle), ORG]);
  return { id: row.id, code, lifecycle };
};

const lifecycleOf = async (id) => (await one(
  `SELECT lifecycle_status, status, is_active FROM assayers WHERE id = $1`, [id])) ?? {};

/** Audit rows of a type against one entity — always read as a delta, never as an absolute. */
const auditCount = async (entityId, eventType) => Number((await one(
  `SELECT count(*)::int c FROM audit_events WHERE entity_id = $1 ${eventType ? 'AND event_type = $2' : ''}`,
  eventType ? [entityId, eventType] : [entityId])).c);

(async () => {
  db = new Client(DBC);
  await db.connect();
  console.log(`\n=== FAPOMS acceptance — lifecycle bypass routes ===\nAPI ${API}\n`);

  const admin = await signIn('admin', 'admin123', '/users/me/change-password');
  const exec = await signIn('executive', 'admin123', '/users/me/change-password');
  if (!admin) throw new Error('could not sign in admin');
  if (!exec) throw new Error('could not sign in executive (OPERATIONS)');
  ORG = (await one(`SELECT organization_id FROM users WHERE id = $1`, [admin.id])).organization_id;
  console.log(`admin ${admin.id}  org ${ORG}\n`);

  await db.query(CLEANUP);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 1. THE BULK PATH. Does planning a route launder the decisions on the way?
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log('── 1. POST /assayers/bulk/lifecycle ──────────────────────────────────────────');

  const bulk = (ids, targetStatus, reason) =>
    call(admin.token, 'POST', '/assayers/bulk/lifecycle',
      { ids, targetStatus, ...(reason === undefined ? {} : { reason }) });

  /**
   * BLK-01/02 — THE REHIRE LAUNDERING PROBE.
   *
   * `RESIGNED → INVITED` is a real edge (the rehire), and `INVITED → … → ACTIVE` is the whole
   * onboarding chain, so a plain shortest-path search WOULD walk RESIGNED → ACTIVE in five hops.
   * `NEVER_A_WAYPOINT` is supposed to refuse it. Confirmed here against the running system rather
   * than against the constant, once with no reason and once with one, because if the refusal came
   * from the reason gate rather than the path-finder the second call would succeed.
   */
  {
    const a = await seedAssayer('REHIRE-NOREASON', 'RESIGNED');
    const before = await auditCount(a.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const r = await bulk([a.id], 'ACTIVE');
    const after = await auditCount(a.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const db1 = await lifecycleOf(a.id);
    const skipped = r.body?.data?.skipped?.[0];
    record('BLK-01',
      r.status === 201 && !!skipped && r.body.data.succeeded.length === 0
        && db1.lifecycle_status === 'RESIGNED' && after === before,
      `RESIGNED → ACTIVE in bulk, no reason: HTTP ${r.status}, `
      + `${skipped ? `SKIPPED ("${skipped.reason}")` : JSON.stringify(r.body?.data ?? r.body)}, `
      + `db still ${db1.lifecycle_status}, ${after - before} lifecycle audit rows written`);

    const b = await seedAssayer('REHIRE-REASON', 'RESIGNED');
    const rb = await bulk([b.id], 'ACTIVE', 'Acceptance probe: rehire this leaver straight to active.');
    const db2 = await lifecycleOf(b.id);
    record('BLK-02',
      rb.body?.data?.skipped?.length === 1 && rb.body?.data?.succeeded?.length === 0
        && db2.lifecycle_status === 'RESIGNED',
      `and supplying a reason does not unlock it — still skipped, db ${db2.lifecycle_status} `
      + `(so the refusal is the path-finder, not the reason gate)`);
  }

  /**
   * BLK-03 — the id shape the bulk DTO accepts.
   *
   * The certification's fixtures use `md5('lcert:'||code)::uuid`, whose version nibble is not 4.
   * `@IsUUID('4', { each: true })` therefore rejects them before the service is reached, which is
   * why every fixture in this file is `gen_random_uuid()`. Stated as a check so the reason is on
   * the record rather than in a comment.
   */
  {
    const probe = await one(`SELECT md5('lcert:${PREFIX}MD5ID')::uuid AS id`);
    const version = probe.id[14];
    const r = await bulk([probe.id], 'DOCUMENT_VERIFICATION');
    record('BLK-03', r.status === 400,
      `an md5-derived id (${probe.id}, version nibble '${version}') is refused by the bulk DTO `
      + `before the service sees it: HTTP ${r.status} ${JSON.stringify(r.body?.message ?? '')}`);
  }

  /**
   * BLK-04/05 — is the reason gate really per HOP, or only on the final target?
   *
   * `TRAINING → ARCHIVED` routes through INACTIVE. ARCHIVED and INACTIVE both need a reason, so
   * the walk must stop at the first hop. The version of this that tested only `targetStatus`
   * carried whatever it was given (or nothing) through every hop.
   */
  {
    const a = await seedAssayer('HOPGATE-NOREASON', 'TRAINING');
    const before = await auditCount(a.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const r = await bulk([a.id], 'ARCHIVED');
    const after = await auditCount(a.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const st = await lifecycleOf(a.id);
    const failed = r.body?.data?.failed?.[0];
    record('BLK-04',
      !!failed && st.lifecycle_status === 'TRAINING' && after === before,
      `TRAINING → ARCHIVED (routes via INACTIVE) with NO reason: FAILED per-row `
      + `("${(failed?.reason ?? '').slice(0, 90)}"), db still ${st.lifecycle_status}, `
      + `${after - before} audit rows`);

    const b = await seedAssayer('HOPGATE-REASON', 'TRAINING');
    const beforeB = await auditCount(b.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const rb = await bulk([b.id], 'ARCHIVED', 'Acceptance probe: candidate withdrew during training, file closed.');
    const afterB = await auditCount(b.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const stB = await lifecycleOf(b.id);
    record('BLK-05',
      rb.body?.data?.succeeded?.length === 1 && stB.lifecycle_status === 'ARCHIVED'
        && stB.is_active === false && (afterB - beforeB) === 2,
      `the same walk WITH a reason completes both hops: db ${stB.lifecycle_status}/`
      + `is_active=${stB.is_active}, ${afterB - beforeB} audit rows (one per hop, not one per batch)`);
  }

  /**
   * BLK-06 — what a half-walked route leaves behind.
   *
   * `INVITED → INACTIVE` routes INVITED → DOCUMENT_VERIFICATION → INACTIVE. The first hop needs
   * no reason and the second does, so a reasonless call commits hop one and is refused at hop two.
   * The service's own comment calls the committed hop "the honest outcome"; this records what an
   * operator is actually left holding.
   */
  {
    const a = await seedAssayer('PARTIAL-WALK', 'INVITED');
    const before = await auditCount(a.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const r = await bulk([a.id], 'INACTIVE');
    const after = await auditCount(a.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const st = await lifecycleOf(a.id);
    const failed = r.body?.data?.failed?.[0];
    record('BLK-06',
      !!failed && st.lifecycle_status !== 'INACTIVE',
      `INVITED → INACTIVE, no reason: the reasonless first hop COMMITS and the walk stops — `
      + `db ${st.lifecycle_status} (asked for INACTIVE), ${after - before} audit rows, `
      + `reported as failed ("${(failed?.reason ?? '').slice(0, 70)}")`);
    if (st.lifecycle_status === 'DOCUMENT_VERIFICATION') {
      finding('BLK-06', 'LOW',
        'a refused bulk move leaves the record part-moved (INVITED → DOCUMENT_VERIFICATION) and '
        + 'reports only "failed" for that id — the response says nothing about the hop that landed, '
        + 'so a roster batch can silently advance people the operator believes were refused');
    }
  }

  /**
   * BLK-07 — per-row isolation. One legal row, one illegal, one ARCHIVED, one call.
   *
   * Target DOCUMENT_VERIFICATION: the INVITED row has a one-hop path, the ACTIVE row has none,
   * and the ARCHIVED row cannot even be loaded (`findOne` filters `is_active`). Each must land in
   * its own bucket and only the legal one may move.
   */
  {
    const good = await seedAssayer('BATCH-LEGAL', 'INVITED');
    const bad = await seedAssayer('BATCH-NOPATH', 'ACTIVE');
    const gone = await seedAssayer('BATCH-ARCHIVED', 'ARCHIVED');
    const r = await bulk([good.id, gone.id, bad.id], 'DOCUMENT_VERIFICATION');
    const d = r.body?.data ?? {};
    const sGood = await lifecycleOf(good.id);
    const sBad = await lifecycleOf(bad.id);
    const sGone = await lifecycleOf(gone.id);
    const ok = d.succeeded?.length === 1 && d.succeeded[0].id === good.id
      && sGood.lifecycle_status === 'DOCUMENT_VERIFICATION'
      && sBad.lifecycle_status === 'ACTIVE' && sGone.lifecycle_status === 'ARCHIVED'
      && (d.skipped?.length ?? 0) + (d.failed?.length ?? 0) === 2;
    record('BLK-07', ok,
      `mixed batch [legal, ARCHIVED, no-path]: succeeded=${d.succeeded?.length} `
      + `skipped=${d.skipped?.length} failed=${d.failed?.length}; db legal→${sGood.lifecycle_status}, `
      + `no-path stayed ${sBad.lifecycle_status}, archived stayed ${sGone.lifecycle_status} `
      + `(one bad row did not abort the rest)`);
  }

  /** BLK-08 — the same id twice in one batch must transition exactly once. */
  {
    const a = await seedAssayer('DUPLICATE-ID', 'INVITED');
    const before = await auditCount(a.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const r = await bulk([a.id, a.id], 'DOCUMENT_VERIFICATION');
    const after = await auditCount(a.id, 'ASSAYER_LIFECYCLE_TRANSITION');
    const st = await lifecycleOf(a.id);
    const [v] = await q(`SELECT version FROM assayers WHERE id=$1`, [a.id]);
    record('BLK-08',
      st.lifecycle_status === 'DOCUMENT_VERIFICATION' && (after - before) === 1,
      `the same id twice in one batch: HTTP ${r.status}, reported succeeded=`
      + `${r.body?.data?.succeeded?.length}, but exactly ${after - before} transition audit row `
      + `and db ${st.lifecycle_status} (version ${v?.version}) — the repeat is a no-op self-path`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 2. DELETE /assayers/:id — the documented bypass.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── 2. DELETE /assayers/:id ───────────────────────────────────────────────────');

  /** A project to hang the delete-cascade's assignments on, created only if the seed left none. */
  const projectFor = async () => {
    const existing = await one(
      `SELECT p.id, p.client_id FROM projects p WHERE p.is_active ORDER BY p.created_at DESC LIMIT 1`);
    if (existing) return existing;
    const client = await one(`SELECT id FROM clients ORDER BY created_at LIMIT 1`);
    if (!client) return null;
    return one(
      `INSERT INTO projects (id, project_number, name, client_id, status, priority, version, is_active,
         created_at, updated_at)
       VALUES (gen_random_uuid(), '${PREFIX}PROJ', 'ACLB acceptance project', $1, 'ACTIVE', 'MEDIUM', 1, true,
         now(), now())
       RETURNING id, client_id`, [client.id]);
  };

  {
    const proj = await projectFor();
    const victim = await seedAssayer('DELETE-TARGET', 'ACTIVE');
    const spare = await seedAssayer('DELETE-403', 'ACTIVE');
    const mapProbe = await seedAssayer('DELETE-MAPPROBE', 'ACTIVE');

    // (a) a reason is not optional
    const noReason = await call(admin.token, 'DELETE', `/assayers/${victim.id}`, {});
    const afterNoReason = await lifecycleOf(victim.id);
    record('DEL-01', noReason.status === 400 && afterNoReason.lifecycle_status === 'ACTIVE',
      `admin DELETE with no reason -> HTTP ${noReason.status} `
      + `("${String(noReason.body?.message ?? '').slice(0, 70)}"), db still ${afterNoReason.lifecycle_status}`);

    // (b) OPERATIONS may run the whole workforce but may not destroy a record
    const asOps = await call(exec.token, 'DELETE', `/assayers/${spare.id}`,
      { reason: 'Acceptance probe: OPERATIONS attempting an administrative deletion.' });
    const opsAfter = await lifecycleOf(spare.id);
    record('DEL-02', asOps.status === 403 && opsAfter.lifecycle_status === 'ACTIVE'
      && opsAfter.is_active === true,
      `executive (OPERATIONS) DELETE with a reason -> HTTP ${asOps.status}, `
      + `db unchanged (${opsAfter.lifecycle_status}, is_active=${opsAfter.is_active}) — ADMIN only`);

    // The bypass, stated plainly: the map has no ACTIVE → ARCHIVED edge at all.
    const viaMap = await call(admin.token, 'POST', `/assayers/${mapProbe.id}/lifecycle`,
      { targetStatus: 'ARCHIVED', reason: 'Acceptance probe: archive an active assayer directly.' });
    record('DEL-08', viaMap.status === 400,
      `the transition route refuses ACTIVE → ARCHIVED outright (HTTP ${viaMap.status}: `
      + `"${String(viaMap.body?.message ?? '').slice(0, 70)}") — DELETE reaches the same column anyway`);

    // (c) the cascade
    let pending = null;
    let completed = null;
    if (proj) {
      pending = await one(
        `INSERT INTO assignments (id, assignment_number, project_id, assayer_id, status, priority,
           auto_schedule, negotiation_count, entity_version, sla_status, empanelment_override_used,
           version, is_active, scheduled_date, created_at, updated_at)
         VALUES (gen_random_uuid(), '${PREFIX}PENDING-'||floor(random()*100000)::text, $1, $2,
           'PENDING', 'MEDIUM', false, 0, 1, 'COMPLIANT', false, 1, true, CURRENT_DATE, now(), now())
         RETURNING id`, [proj.id, victim.id]);
      completed = await one(
        `INSERT INTO assignments (id, assignment_number, project_id, assayer_id, status, priority,
           auto_schedule, negotiation_count, entity_version, sla_status, empanelment_override_used,
           version, is_active, scheduled_date, created_at, updated_at)
         VALUES (gen_random_uuid(), '${PREFIX}DONE-'||floor(random()*100000)::text, $1, $2,
           'COMPLETED', 'MEDIUM', false, 0, 1, 'COMPLIANT', false, 1, true, CURRENT_DATE - 30, now(), now())
         RETURNING id`, [proj.id, victim.id]);
    }

    const auditBefore = await auditCount(victim.id, 'ASSAYER_DELETED');
    const perAssignmentBefore = pending
      ? await auditCount(pending.id, null) + await auditCount(completed.id, null) : 0;

    const del = await call(admin.token, 'DELETE', `/assayers/${victim.id}`,
      { reason: 'Acceptance probe: duplicate record created in error, removed by administrator.' });
    const gone = await lifecycleOf(victim.id);
    record('DEL-03',
      (del.status === 204 || del.status === 200) && gone.lifecycle_status === 'ARCHIVED'
        && gone.is_active === false && gone.status === 'INACTIVE',
      `admin DELETE with a reason on an ACTIVE assayer -> HTTP ${del.status}; db `
      + `${gone.lifecycle_status}/status=${gone.status}/is_active=${gone.is_active} — reached ARCHIVED `
      + `without the transition map being consulted`);

    if (pending) {
      const p = await one(
        `SELECT status, is_active, cancel_reason FROM assignments WHERE id=$1`, [pending.id]);
      record('DEL-04', p.status === 'CANCELLED' && p.is_active === false,
        `the open PENDING assignment is closed: status ${p.status}, is_active=${p.is_active}, `
        + `cancel_reason "${p.cancel_reason ?? ''}"`);
      const c = await one(
        `SELECT status, is_active, cancel_reason FROM assignments WHERE id=$1`, [completed.id]);
      record('DEL-05', c.status === 'COMPLETED' && c.is_active === true && !c.cancel_reason,
        `the COMPLETED assignment is left alone: status ${c.status}, is_active=${c.is_active} `
        + `(billing filters on is_active, so clearing it would drop a delivered audit off an invoice)`);
    } else {
      record('DEL-04', false, 'no project available to seed the delete-cascade assignments');
      record('DEL-05', false, 'no project available to seed the delete-cascade assignments');
    }

    const auditAfter = await auditCount(victim.id, 'ASSAYER_DELETED');
    const row = await one(
      `SELECT user_id, previous_state, new_state, remarks, metadata FROM audit_events
        WHERE entity_id=$1 AND event_type='ASSAYER_DELETED' ORDER BY occurred_at DESC LIMIT 1`,
      [victim.id]);
    record('DEL-06',
      (auditAfter - auditBefore) === 1 && row?.user_id === admin.id
        && row?.previous_state === 'ACTIVE' && row?.new_state === 'ARCHIVED',
      `one ASSAYER_DELETED row: actor ${row?.user_id === admin.id ? 'admin' : row?.user_id}, `
      + `previous_state=${row?.previous_state}, new_state=${row?.new_state}, `
      + `reason on file="${String(row?.metadata?.reason ?? '').slice(0, 45)}"`);

    // (d) THE QUESTION THIS SECTION EXISTS FOR: is the cancelled work audited as itself?
    if (pending) {
      const perAssignmentAfter = await auditCount(pending.id, null) + await auditCount(completed.id, null);
      const delta = perAssignmentAfter - perAssignmentBefore;
      record('DEL-07', true,
        `per-assignment audit rows written by the delete cascade: ${delta} `
        + `(aggregate ASSAYER_DELETED rows: ${auditAfter - auditBefore})`);
      if (delta === 0) {
        finding('DEL-07', 'MEDIUM',
          'the delete cascade cancels open assignments with a raw UPDATE and writes NO audit row '
          + 'against any assignment it closed — the only trail is one ASSAYER_DELETED row on the '
          + 'ASSAYER, whose remarks name neither the assignments nor how many. "Why was my job '
          + 'cancelled?" is answerable only by already knowing to look at the assayer\'s deletion, '
          + 'and `entity_version` is bumped with nothing on the assignment to say what changed');
      }
    } else {
      record('DEL-07', false, 'no project available to measure per-assignment audit rows');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 3. POST /assayers/:id/recovery/reset-onboarding-stage — a rewind, and only a rewind.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── 3. POST /assayers/:id/recovery/reset-onboarding-stage ─────────────────────');

  const reset = (id, targetStage, reason) =>
    call(admin.token, 'POST', `/assayers/${id}/recovery/reset-onboarding-stage`, { targetStage, reason });
  const GOOD_REASON = 'Acceptance probe: documents were filed against the wrong candidate, rewinding.';

  {
    const a = await seedAssayer('REWIND-OK', 'TRAINING');
    const before = await auditCount(a.id, 'ASSAYER_ONBOARDING_STAGE_RESET');
    const r = await reset(a.id, 'DOCUMENT_VERIFICATION', GOOD_REASON);
    const after = await auditCount(a.id, 'ASSAYER_ONBOARDING_STAGE_RESET');
    const st = await lifecycleOf(a.id);
    record('REC-01', (r.status === 200 || r.status === 201) && st.lifecycle_status === 'DOCUMENT_VERIFICATION',
      `TRAINING rewound to DOCUMENT_VERIFICATION -> HTTP ${r.status}, db ${st.lifecycle_status}`);
    const row = await one(
      `SELECT previous_state, new_state, user_id FROM audit_events WHERE entity_id=$1
         AND event_type='ASSAYER_ONBOARDING_STAGE_RESET' ORDER BY occurred_at DESC LIMIT 1`, [a.id]);
    record('REC-02', (after - before) === 1 && row?.previous_state === 'TRAINING'
      && row?.new_state === 'DOCUMENT_VERIFICATION' && row?.user_id === admin.id,
      `and it is distinctly audited: ${after - before} ASSAYER_ONBOARDING_STAGE_RESET row, `
      + `${row?.previous_state} → ${row?.new_state}, actor ${row?.user_id === admin.id ? 'admin' : row?.user_id}`);

    // forward is a real transition, with its own gates
    const fwd = await reset(a.id, 'TRAINING', GOOD_REASON);
    const stFwd = await lifecycleOf(a.id);
    record('REC-04', fwd.status === 400 && stFwd.lifecycle_status === 'DOCUMENT_VERIFICATION',
      `and it will not go forward again (DOCUMENT_VERIFICATION → TRAINING) -> HTTP ${fwd.status} `
      + `("${String(fwd.body?.message ?? '').slice(0, 70)}"), db ${stFwd.lifecycle_status}`);

    const short = await reset(a.id, 'INVITED', 'oops');
    record('REC-05', short.status === 400,
      `a 4-character reason is refused -> HTTP ${short.status} `
      + `("${String(short.body?.message ?? '').slice(0, 70)}")`);

    const notOnboarding = await reset(a.id, 'SUSPENDED', GOOD_REASON);
    const stAfter = await lifecycleOf(a.id);
    record('REC-06', notOnboarding.status === 400 && stAfter.lifecycle_status === 'DOCUMENT_VERIFICATION',
      `a non-onboarding target (SUSPENDED) is refused -> HTTP ${notOnboarding.status} `
      + `("${String(notOnboarding.body?.message ?? '').slice(0, 70)}"), db ${stAfter.lifecycle_status}`);

    const same = await reset(a.id, 'DOCUMENT_VERIFICATION', GOOD_REASON);
    record('REC-07', same.status === 400,
      `and a rewind to the stage they are already at is refused -> HTTP ${same.status}`);
  }

  {
    const act = await seedAssayer('REWIND-FROM-ACTIVE', 'ACTIVE');
    const r = await reset(act.id, 'TRAINING', GOOD_REASON);
    const st = await lifecycleOf(act.id);
    record('REC-03', r.status === 400 && st.lifecycle_status === 'ACTIVE',
      `from ACTIVE it is refused -> HTTP ${r.status} `
      + `("${String(r.body?.message ?? '').slice(0, 80)}"), db ${st.lifecycle_status}`);

    const left = await seedAssayer('REWIND-FROM-RESIGNED', 'RESIGNED');
    const rl = await reset(left.id, 'INVITED', GOOD_REASON);
    const stl = await lifecycleOf(left.id);
    record('REC-08', rl.status === 400 && stl.lifecycle_status === 'RESIGNED',
      `and it cannot manufacture a rehire from RESIGNED -> HTTP ${rl.status}, db ${stl.lifecycle_status} `
      + `(this route plus one lifecycle call was the two-call laundering the certification found)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 4. PUT /assayers/:assayerId/empanelment/:clientId — a free-form upsert, no state machine.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── 4. PUT /assayers/:assayerId/empanelment/:clientId ─────────────────────────');

  const client = await one(`SELECT id, name FROM clients ORDER BY created_at LIMIT 1`);
  const panelist = await seedAssayer('EMPANEL', 'ACTIVE');
  if (!client) {
    record('EMP-01', false, 'no client in the database to set a standing against');
  } else {
    const setStanding = (status, extra = {}) =>
      call(admin.token, 'PUT', `/assayers/${panelist.id}/empanelment/${client.id}`, { status, ...extra });

    const rejected = await setStanding('REJECTED',
      { statusReason: 'Acceptance probe: client refused this appraiser after their own vetting.' });
    const afterRejected = await one(
      `SELECT status FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`,
      [panelist.id, client.id]);
    record('EMP-01', (rejected.status === 200 || rejected.status === 201)
      && afterRejected?.status === 'REJECTED',
      `standing with ${client.name} set to REJECTED -> HTTP ${rejected.status}, db ${afterRejected?.status}`);

    const auditBefore = await auditCount(panelist.id, 'EMPANELMENT_SET');
    const reversed = await setStanding('ACTIVE');
    const afterReversed = await one(
      `SELECT status FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`,
      [panelist.id, client.id]);
    const auditAfter = await auditCount(panelist.id, 'EMPANELMENT_SET');
    const accepted = reversed.status < 300 && afterReversed?.status === 'ACTIVE';
    // The assertion is that the API's answer and the database agree — either answer is a real
    // observation, and a 200 that did not write would be the worst of the three.
    record('EMP-02',
      (reversed.status < 300) === (afterReversed?.status === 'ACTIVE'),
      `REJECTED → ACTIVE in one call -> HTTP ${reversed.status}, db now ${afterReversed?.status} `
      + `(response and database agree${accepted ? '; the reversal was ACCEPTED' : '; it was refused'})`);
    if (accepted) {
      finding('EMP-02', 'HIGH',
        "a client's rejection is reversible in one unguarded PUT: REJECTED → ACTIVE was accepted "
        + 'with no state machine, no reason required, and no second approver. The empanelment '
        + 'column is a compliance fact about what a bank decided, and the only things standing '
        + 'between it and a silent reversal are the EMPANELMENT_SET audit row (after the fact) '
        + 'and the assignment-time hard block (section 5). Any holder of '
        + 'assayer:edit:organization can do it');
    }

    const rows = await one(
      `SELECT count(*)::int c FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`,
      [panelist.id, client.id]);
    record('EMP-03', rows.c === 1,
      `exactly ${rows.c} standing row exists for that (assayer, client) pair — it is an upsert, `
      + `not a second opinion alongside the first (UQ_assayer_client_empanelment)`);

    const bogus = await setStanding('BLACKLISTED');
    const afterBogus = await one(
      `SELECT status FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`,
      [panelist.id, client.id]);
    record('EMP-04', bogus.status === 400 && afterBogus?.status === 'ACTIVE',
      `an invented standing ("BLACKLISTED") is refused by the DTO enum -> HTTP ${bogus.status}, `
      + `db unchanged at ${afterBogus?.status}`);

    const audit = await one(
      `SELECT previous_state, new_state, user_id, metadata FROM audit_events
        WHERE entity_id=$1 AND event_type='EMPANELMENT_SET' ORDER BY occurred_at DESC LIMIT 1`,
      [panelist.id]);
    record('EMP-05',
      (auditAfter - auditBefore) === 1 && audit?.previous_state === 'REJECTED'
      && audit?.new_state === 'ACTIVE' && audit?.user_id === admin.id,
      `the reversal is on the record: EMPANELMENT_SET previous_state=${audit?.previous_state} → `
      + `new_state=${audit?.new_state}, actor ${audit?.user_id === admin.id ? 'admin' : audit?.user_id}, `
      + `metadata.previousValue.status=${audit?.metadata?.previousValue?.status}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 5. Does the assignment-time hard block actually hold?
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── 5. POST /assignments against a REJECTED standing ──────────────────────────');

  {
    const branch = client ? await one(
      `SELECT pb.id, p.client_id FROM project_branches pb
         JOIN projects p ON p.id = pb.project_id
        WHERE p.client_id = $1 AND p.is_active
          AND (p.end_date IS NULL OR p.end_date >= CURRENT_DATE)
          AND (p.start_date IS NULL OR p.start_date <= CURRENT_DATE)
          AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.project_branch_id = pb.id AND a.is_active)
        LIMIT 1`, [client.id]) : null;

    if (!branch) {
      record('ELG-01', false,
        'no open, unassigned project_branch for that client — the hard block was not probed');
    } else {
      const blocked = await seedAssayer('ELIGIBILITY', 'ACTIVE');
      await call(admin.token, 'PUT', `/assayers/${blocked.id}/empanelment/${client.id}`,
        { status: 'REJECTED', statusReason: 'Acceptance probe: client rejected this appraiser.' });
      const standing = await one(
        `SELECT status FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`,
        [blocked.id, client.id]);
      const today = new Date().toISOString().slice(0, 10);
      // No `proposedFee`: an omitted fee means "quote it for me", and a hard-coded number is a
      // second way for this probe to fail that has nothing to do with empanelment — an operator
      // fee above twice the branch's contracted quote is refused by a different rule entirely.
      const base = {
        projectBranchId: branch.id, assayerId: blocked.id,
        scheduledDate: today, remarks: 'ACLB- eligibility probe',
      };

      const plain = await call(admin.token, 'POST', '/assignments', base);
      const n1 = Number((await one(
        `SELECT count(*)::int c FROM assignments WHERE assayer_id=$1`, [blocked.id])).c);
      record('ELG-01', plain.status >= 400 && n1 === 0,
        `standing=${standing?.status}: POST /assignments as ADMIN with no override -> HTTP `
        + `${plain.status} ("${String(plain.body?.message ?? '').slice(0, 80)}"), `
        + `${n1} assignment rows created`);

      const overridden = await call(admin.token, 'POST', '/assignments', {
        ...base,
        overrideReason: 'Acceptance probe: senior desk asserts this appraiser is the only one available.',
      });
      const n2 = Number((await one(
        `SELECT count(*)::int c FROM assignments WHERE assayer_id=$1`, [blocked.id])).c);
      record('ELG-02', overridden.status >= 400 && n2 === 0,
        `and WITH a written overrideReason, still as ADMIN -> HTTP ${overridden.status} `
        + `("${String(overridden.body?.message ?? '').slice(0, 90)}"), ${n2} assignment rows — `
        + `REJECTED is the strictly non-overridable class, and seniority does not lift it`);

      // The control: prove the refusal above was the standing and nothing else about the fixture.
      await call(admin.token, 'PUT', `/assayers/${blocked.id}/empanelment/${client.id}`,
        { status: 'ACTIVE' });
      const allowed = await call(admin.token, 'POST', '/assignments', base);
      const n3 = Number((await one(
        `SELECT count(*)::int c FROM assignments WHERE assayer_id=$1`, [blocked.id])).c);
      record('ELG-03', allowed.status < 400 && n3 === 1,
        `control — the same call with the standing flipped to ACTIVE -> HTTP ${allowed.status}, `
        + `${n3} assignment row, so ELG-01/02 refused the standing and not the fixture`
        + `${allowed.status >= 400 ? ` ("${String(allowed.body?.message ?? '').slice(0, 70)}")` : ''}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── cleanup ───────────────────────────────────────────────────────────────────');
  await db.query(CLEANUP);
  const left = Number((await one(
    `SELECT count(*)::int c FROM assayers WHERE assayer_code LIKE '${PREFIX}%'`)).c);
  console.log(`  ${left === 0 ? 'removed every ACLB- fixture' : `WARNING: ${left} ACLB- rows remain`}`
    + ' (audit_events deliberately untouched — the table is append-only by trigger)');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  for (const f of failed) console.log(`  FAILED [${f.id}] ${f.detail}`);
  if (findings.length) {
    console.log(`\n=== ${findings.length} finding(s) ===`);
    for (const f of findings) console.log(`  [${f.id}] ${f.severity}: ${f.detail}`);
  }
  await db.end();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\nABORTED:', e.message);
  try { await db?.query(CLEANUP); } catch {}
  try { await db?.end(); } catch {}
  process.exit(2);
});
