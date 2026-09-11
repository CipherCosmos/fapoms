#!/usr/bin/env node
/**
 * FAPOMS acceptance — the bulk lifecycle CONTRACT, against the running system.
 *
 * `POST /assayers/bulk/lifecycle` plans a route and walks it, one transaction per hop. The
 * question this file exists to answer is not whether each hop is legal — `lifecycle-bypass.mjs`
 * settles that — but whether **the response and the database ever disagree about what happened**.
 *
 * The defect it was written for:
 *
 *     INVITED → INACTIVE requested, no reason given
 *       INVITED → DOCUMENT_VERIFICATION    needs no reason, COMMITS
 *       DOCUMENT_VERIFICATION → INACTIVE   needs a reason, refused
 *       response said:      failed
 *       the database said:  DOCUMENT_VERIFICATION
 *
 * An operator reading "failed" believes nothing happened. Something did.
 *
 * ## How this is checked
 *
 * Not case by case. `bulk()` below snapshots every id's lifecycle state before the call and reads
 * it back after, then holds the response's own claim about each row against what the row now
 * says — for EVERY call this script makes, including the ones whose named check is about
 * something else. A single contradiction anywhere in the run fails BL-CONTRACT at the end. The
 * named checks then assert the specific outcome each scenario should have produced.
 *
 * `audit_events` is append-only by database trigger, so counts are always read as a DELTA across
 * a call — never as an absolute, which would inherit every previous run. NOTHING here writes to
 * that table; the cleanup deliberately leaves it alone.
 *
 * Fixtures are provisioned per run under the `ACBL-` prefix with `gen_random_uuid()` ids
 * (`BulkTransitionLifecycleDto` validates `@IsUUID('4')`, and an md5-derived id fails that), and
 * removed children-first at both ends of the run. Shared fixtures are never mutated.
 */
import { env, req, sql, one, login, tally, pool, declareMutating } from './_lib.mjs';

const PREFIX = 'ACBL-';
const { check, done } = tally();

/** The operational projection `chk_assayers_lifecycle_status_projection` demands. */
const projectionFor = (lc) => (lc === 'ACTIVE' ? 'ACTIVE' : lc === 'SUSPENDED' ? 'SUSPENDED' : 'INACTIVE');
/** `chk_assayers_is_active_consistency`: only ARCHIVED is inactive. */
const isActiveFor = (lc) => lc !== 'ARCHIVED';

let ORG = null;
let n = 0;

/** Children first, then the people. `audit_events` is read-only to this script, by rule. */
const CLEANUP = `
DELETE FROM assayer_activities WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE '${PREFIX}%');
DELETE FROM assayer_documents WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE '${PREFIX}%');
DELETE FROM assayer_client_empanelments WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE '${PREFIX}%');
-- workflow_history is the one table here with quoted camelCase columns.
DELETE FROM workflow_history WHERE "entityId" IN (SELECT id::text FROM assayers WHERE assayer_code LIKE '${PREFIX}%');
DELETE FROM assayers WHERE assayer_code LIKE '${PREFIX}%';
`;

const seedAssayer = async (tag, lifecycle, region = 'WEST') => {
  const code = `${PREFIX}${tag}-${++n}`;
  const [row] = await sql(
    `INSERT INTO assayers (id, assayer_code, first_name, last_name, display_name, address,
       state, district, city, region, lifecycle_status, status, is_active, organization_id,
       version, joining_date, created_at, updated_at, created_by, updated_by)
     VALUES (gen_random_uuid(), $1::text, 'ACBL', $1::text, 'ACBL '||$1::text, 'Acceptance Address',
       $6, 'Pune', 'Pune', $5, $2, $3, $4, $7, 1, '2026-01-01', now(), now(), 'acceptance', 'acceptance')
     RETURNING id`,
    [code, lifecycle, projectionFor(lifecycle), isActiveFor(lifecycle), region,
      region === 'EAST' ? 'WEST BENGAL' : 'MAHARASHTRA', ORG]);
  return { id: row.id, code, seeded: lifecycle };
};

const stateOf = async (id) => (await one(
  `SELECT lifecycle_status, status, is_active FROM assayers WHERE id = $1`, [id])) ?? {};
const lifecycleOf = async (id) => (await stateOf(id)).lifecycle_status;

const auditCount = async (id, eventType) => Number((await one(
  `SELECT count(*)::int c FROM audit_events WHERE entity_id = $1 AND event_type = $2`,
  [id, eventType])).c);
const hops = (id) => auditCount(id, 'ASSAYER_LIFECYCLE_TRANSITION');
const abandonments = (id) => auditCount(id, 'ASSAYER_LIFECYCLE_WALK_ABANDONED');

/** Where the response says a row ended up. */
const bucketOf = (data, id) => {
  for (const bucket of ['succeeded', 'partial', 'skipped', 'failed']) {
    const row = (data?.[bucket] ?? []).find((r) => r.id === id);
    if (row) return { bucket, row };
  }
  return { bucket: 'ABSENT', row: null };
};

const brief = (o) => JSON.stringify(o ?? null).slice(0, 240);

/** Every disagreement between a response and the row it described, across the whole run. */
const contradictions = [];

/**
 * A bulk call, with the contract checked on the way through.
 *
 * Reads each id's state and audit count before and after, then asks of every id: does the bucket
 * the response put it in match what the database now says?
 *
 *   succeeded  the row is at `to`
 *   partial    the row is at `reached`, `reached` is neither where it started nor the target,
 *              and an abandonment audit row explains it
 *   skipped    the row is exactly where it started      ← the bucket the defect belonged in
 *   failed     the row is exactly where it started      ← the bucket the defect was reported in
 */
const bulk = async (token, people, targetStatus, reason) => {
  const ids = people.map((p) => (typeof p === 'string' ? p : p.id));
  const unique = [...new Set(ids)];
  const before = Object.fromEntries(await Promise.all(
    unique.map(async (id) => [id, { state: await lifecycleOf(id), hops: await hops(id) }])));

  const r = await req('/assayers/bulk/lifecycle', {
    method: 'POST', token,
    body: { ids, targetStatus, ...(reason === undefined ? {} : { reason }) },
  });
  const data = r.body?.data ?? {};

  const after = Object.fromEntries(await Promise.all(
    unique.map(async (id) => [id, { state: await lifecycleOf(id), hops: await hops(id) }])));

  if (r.status === 201) {
    for (const id of unique) {
      const { bucket, row } = bucketOf(data, id);
      const was = before[id].state;
      const now = after[id].state;
      const say = (what) => contradictions.push(
        `${id.slice(0, 8)} reported ${bucket} ${brief(row)} but ${what} (was ${was}, now ${now}, `
        + `+${after[id].hops - before[id].hops} audit rows)`);

      if (bucket === 'succeeded' && now !== row.to) say(`the row is ${now}, not ${row.to}`);
      if (bucket === 'partial') {
        if (now !== row.reached) say(`the row is ${now}, not the ${row.reached} it named`);
        if (row.reached === row.target) say('a row that reached the target is not partial');
        if (row.reached === row.from) say('a row that never moved is not partial');
        if ((await abandonments(id)) === 0) say('no abandonment row was written for it');
      }
      // The two buckets that promise nothing happened have to mean it. This is the check that
      // would have failed against the old code, on the `failed` arm.
      if ((bucket === 'skipped' || bucket === 'failed') && now !== was) say(`the row MOVED to ${now}`);
      if (bucket === 'ABSENT') say('it was not reported at all');
    }
  }

  return { r, data, before, after };
};

(async () => {
  console.log(`\n=== FAPOMS acceptance — the bulk lifecycle contract ===\nAPI ${env.AC_API}\n`);
  declareMutating('bulk-lifecycle', [
    `INSERTs throwaway assayers under the ${PREFIX} prefix, and DELETEs them and their child rows`,
    '  at both ends of the run. Shared fixtures are never mutated; audit_events is never touched',
    'walks those assayers through POST /assayers/bulk/lifecycle — the walk is the subject of the',
    '  test, so lifecycle_status really changes and real audit rows are written',
  ]);

  const admin = await login('admin', env.AC_PASSWORD);
  const east = await login('cert_ops_east').catch(() => null);
  const auditor = await login('cert_auditor').catch(() => null);

  ORG = (await one(`SELECT organization_id FROM users WHERE username = 'admin'`)).organization_id;
  await pool.query(CLEANUP);

  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log('── 1. the half-landed walk ───────────────────────────────────────────────────');
  // ═════════════════════════════════════════════════════════════════════════════════════════

  {
    const a = await seedAssayer('PARTIAL-WALK', 'INVITED');
    const { r, data, before, after } = await bulk(admin.token, [a], 'INACTIVE');
    const { bucket, row } = bucketOf(data, a.id);

    check('BL-01  INVITED → INACTIVE with no reason: nobody moves, and it is not called "failed"',
      bucket === 'skipped' && after[a.id].state === 'INVITED'
        && after[a.id].hops === before[a.id].hops,
      `HTTP ${r.status}, reported ${bucket} ${brief(row)}; db ${after[a.id].state}, `
      + `+${after[a.id].hops - before[a.id].hops} lifecycle audit rows`);

    check('BL-02  …and the refusal names the hop that needs the sentence',
      /inactive/i.test(row?.reason ?? '') && /nothing was changed/i.test(row?.reason ?? ''),
      `reason: "${(row?.reason ?? '').slice(0, 170)}"`);
  }

  {
    const a = await seedAssayer('PARTIAL-WALK-OK', 'INVITED');
    const { data, before, after } = await bulk(admin.token, [a], 'INACTIVE',
      'Acceptance probe: never replied to the invitation, file closed.');
    const { bucket, row } = bucketOf(data, a.id);

    check('BL-03  the same walk WITH a reason completes, and reports the route it took',
      bucket === 'succeeded' && after[a.id].state === 'INACTIVE'
        && (after[a.id].hops - before[a.id].hops) === 2
        && JSON.stringify(row?.via) === JSON.stringify(['DOCUMENT_VERIFICATION', 'INACTIVE']),
      `reported ${bucket} ${brief(row)}; db ${after[a.id].state}, `
      + `+${after[a.id].hops - before[a.id].hops} audit rows (one per hop)`);
  }

  {
    // The other reason-gated multi-hop walk from the earlier campaign: TRAINING → ARCHIVED routes
    // via INACTIVE and BOTH hops need a reason, so nothing may move without one.
    const a = await seedAssayer('HOPGATE', 'TRAINING');
    const { data, before, after } = await bulk(admin.token, [a], 'ARCHIVED');
    const { bucket, row } = bucketOf(data, a.id);
    check('BL-04  TRAINING → ARCHIVED (via INACTIVE), no reason: refused whole — the per-hop gate holds',
      bucket === 'skipped' && after[a.id].state === 'TRAINING'
        && after[a.id].hops === before[a.id].hops,
      `reported ${bucket} ("${(row?.reason ?? '').slice(0, 120)}"); db ${after[a.id].state}`);
  }

  {
    // NEVER_A_WAYPOINT still holds: the rehire edge is not a corridor back to work.
    const a = await seedAssayer('REHIRE', 'RESIGNED');
    const { data, after } = await bulk(admin.token, [a], 'ACTIVE',
      'Acceptance probe: they asked to come back.');
    const { bucket, row } = bucketOf(data, a.id);
    check('BL-05  RESIGNED → ACTIVE stays unreachable even with a reason (NEVER_A_WAYPOINT)',
      bucket === 'skipped' && /no valid path/i.test(row?.reason ?? '') && after[a.id].state === 'RESIGNED',
      `reported ${bucket} ("${(row?.reason ?? '').slice(0, 90)}"); db ${after[a.id].state}`);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── 2. batches ────────────────────────────────────────────────────────────────');
  // ═════════════════════════════════════════════════════════════════════════════════════════

  {
    const people = [
      await seedAssayer('ALLGOOD', 'INVITED'),
      await seedAssayer('ALLGOOD', 'INVITED'),
      await seedAssayer('ALLGOOD', 'INVITED'),
    ];
    const { data, before, after } = await bulk(admin.token, people, 'BACKGROUND_VERIFICATION');
    check('BL-06  all valid: every row moves, two audit rows each, the other buckets empty',
      data.succeeded?.length === 3 && (data.skipped?.length ?? 0) === 0
        && (data.failed?.length ?? 0) === 0 && (data.partial?.length ?? 0) === 0
        && people.every((p) => after[p.id].state === 'BACKGROUND_VERIFICATION')
        && people.every((p) => after[p.id].hops - before[p.id].hops === 2),
      `succeeded=${data.succeeded?.length} partial=${data.partial?.length} `
      + `skipped=${data.skipped?.length} failed=${data.failed?.length}; `
      + `db ${people.map((p) => after[p.id].state).join(', ')}`);
  }

  {
    const people = [
      await seedAssayer('ALLBAD', 'ACTIVE'),
      await seedAssayer('ALLBAD', 'ON_LEAVE'),
      await seedAssayer('ALLBAD', 'ARCHIVED'),
    ];
    const { r, data, after } = await bulk(admin.token, people, 'DOCUMENT_VERIFICATION');
    check('BL-07  all invalid: HTTP 201, nobody moves, every row reported and none as succeeded',
      r.status === 201 && (data.succeeded?.length ?? 0) === 0 && (data.partial?.length ?? 0) === 0
        && ((data.skipped?.length ?? 0) + (data.failed?.length ?? 0)) === 3
        && people.map((p) => after[p.id].state).join(',') === 'ACTIVE,ON_LEAVE,ARCHIVED',
      `HTTP ${r.status}, skipped=${data.skipped?.length} failed=${data.failed?.length}; `
      + `db ${people.map((p) => after[p.id].state).join(', ')}`);
  }

  {
    const good = await seedAssayer('MIXED-GOOD', 'INVITED');
    const noPath = await seedAssayer('MIXED-NOPATH', 'ACTIVE');
    const archived = await seedAssayer('MIXED-GONE', 'ARCHIVED');
    const alsoGood = await seedAssayer('MIXED-GOOD2', 'INVITED');
    const { data, after } = await bulk(admin.token, [good, noPath, archived, alsoGood], 'DOCUMENT_VERIFICATION');
    check('BL-08  mixed: one bad id neither rolls back a good one nor stops the ones after it',
      data.succeeded?.length === 2
        && after[good.id].state === 'DOCUMENT_VERIFICATION'
        && after[alsoGood.id].state === 'DOCUMENT_VERIFICATION'
        && after[noPath.id].state === 'ACTIVE' && after[archived.id].state === 'ARCHIVED'
        && ((data.skipped?.length ?? 0) + (data.failed?.length ?? 0)) === 2,
      `succeeded=${data.succeeded?.length} skipped=${data.skipped?.length} `
      + `failed=${data.failed?.length}; db good→${after[good.id].state}, `
      + `alsoGood→${after[alsoGood.id].state}, no-path stayed ${after[noPath.id].state}, `
      + `archived stayed ${after[archived.id].state}`);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── 3. parity with POST /assayers/:id/lifecycle ───────────────────────────────');
  // ═════════════════════════════════════════════════════════════════════════════════════════

  {
    // A one-hop reason-gated move, refused by both routes for the same reason and in the same
    // words. The single route answers 400; the bulk route answers 201 with the row refused,
    // because per-row isolation is the point of the batch endpoint.
    const a = await seedAssayer('REASON-SINGLE', 'ACTIVE');
    const b = await seedAssayer('REASON-BULK', 'ACTIVE');
    const single = await req(`/assayers/${a.id}/lifecycle`, {
      method: 'POST', token: admin.token, body: { targetStatus: 'INACTIVE' },
    });
    const { data, after } = await bulk(admin.token, [b], 'INACTIVE');
    const { bucket, row } = bucketOf(data, b.id);
    check('BL-09  a missing reason is refused by BOTH routes, in the same words, moving neither record',
      single.status === 400 && bucket === 'skipped'
        && (await lifecycleOf(a.id)) === 'ACTIVE' && after[b.id].state === 'ACTIVE'
        && /say why this assayer is being moved/i.test(row?.reason ?? '')
        && /say why this assayer is being moved/i.test(String(single.msg ?? '')),
      `single: HTTP ${single.status} "${String(single.msg ?? '').slice(0, 80)}"; `
      + `bulk: ${bucket} "${(row?.reason ?? '').slice(0, 80)}"`);
  }

  if (auditor) {
    const a = await seedAssayer('UNAUTH', 'INVITED');
    const before = await hops(a.id);
    const r = await req('/assayers/bulk/lifecycle', {
      method: 'POST', token: auditor.token,
      body: { ids: [a.id], targetStatus: 'DOCUMENT_VERIFICATION' },
    });
    check('BL-10  an unauthorized role is refused outright, and moves nobody',
      (r.status === 401 || r.status === 403) && (await lifecycleOf(a.id)) === 'INVITED'
        && (await hops(a.id)) === before,
      `cert_auditor: HTTP ${r.status} "${String(r.msg ?? '').slice(0, 80)}"; `
      + `db ${await lifecycleOf(a.id)}`);
  } else {
    check('BL-10  an unauthorized role is refused outright', false, 'could not sign in cert_auditor');
  }

  if (east) {
    // The region ceiling is per id and asserted BEFORE any transition, so a batch containing one
    // out-of-scope record is refused whole rather than half-applied.
    const inScope = await seedAssayer('REGION-EAST', 'INVITED', 'EAST');
    const outOfScope = await seedAssayer('REGION-WEST', 'INVITED', 'WEST');
    const before = [await hops(inScope.id), await hops(outOfScope.id)];
    const r = await req('/assayers/bulk/lifecycle', {
      method: 'POST', token: east.token,
      body: { ids: [inScope.id, outOfScope.id], targetStatus: 'DOCUMENT_VERIFICATION' },
    });
    const s = [await lifecycleOf(inScope.id), await lifecycleOf(outOfScope.id)];
    check('BL-11  one out-of-region id refuses the WHOLE batch — the in-region row does not move either',
      r.status === 403 && s.every((x) => x === 'INVITED')
        && (await hops(inScope.id)) === before[0] && (await hops(outOfScope.id)) === before[1],
      `cert_ops_east (EAST) sending [EAST, WEST]: HTTP ${r.status} `
      + `"${String(r.msg ?? '').slice(0, 90)}"; db ${s.join(', ')}`);

    const { r: solo } = await bulk(east.token, [inScope], 'DOCUMENT_VERIFICATION');
    check('BL-12  …and it is a ceiling, not a wall: the in-region id alone still moves',
      solo.status === 201 && (await lifecycleOf(inScope.id)) === 'DOCUMENT_VERIFICATION',
      `HTTP ${solo.status}; db ${await lifecycleOf(inScope.id)}`);
  } else {
    check('BL-11  one out-of-region id refuses the whole batch', false, 'could not sign in cert_ops_east');
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── 4. duplicates and repeats ─────────────────────────────────────────────────');
  // ═════════════════════════════════════════════════════════════════════════════════════════

  {
    const a = await seedAssayer('DUP-ID', 'INVITED');
    const { data, before, after } = await bulk(admin.token, [a, a], 'DOCUMENT_VERIFICATION');
    const secondVia = data.succeeded?.[1]?.via;
    check('BL-13  the same id twice in one batch transitions once, and the repeat reports via: []',
      (after[a.id].hops - before[a.id].hops) === 1 && after[a.id].state === 'DOCUMENT_VERIFICATION'
        && data.succeeded?.length === 2 && Array.isArray(secondVia) && secondVia.length === 0,
      `succeeded=${data.succeeded?.length} (second via=${brief(secondVia)}); `
      + `+${after[a.id].hops - before[a.id].hops} audit row; db ${after[a.id].state}`);
  }

  {
    const a = await seedAssayer('REPEAT', 'INVITED');
    const first = await bulk(admin.token, [a], 'TRAINING');
    const second = await bulk(admin.token, [a], 'TRAINING');
    const v1 = first.data.succeeded?.[0]?.via;
    const v2 = second.data.succeeded?.[0]?.via;
    const walked = first.after[a.id].hops - first.before[a.id].hops;
    const walkedAgain = second.after[a.id].hops - second.before[a.id].hops;
    check('BL-14  the same request twice: the second writes nothing and reports arrival, not a move',
      walked === 3 && walkedAgain === 0 && second.after[a.id].state === 'TRAINING'
        && Array.isArray(v1) && v1.length === 3 && Array.isArray(v2) && v2.length === 0,
      `first via=${brief(v1)} (+${walked} audit rows), second via=${brief(v2)} `
      + `(+${walkedAgain} audit rows); db ${second.after[a.id].state}`);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── 5. the shape, and the invariant over the whole run ─────────────────────────');
  // ═════════════════════════════════════════════════════════════════════════════════════════

  {
    // A genuine partial needs the walk to be raced, which this script does not attempt — the unit
    // suite drives that with an injected fault. What is asserted here is that the bucket EXISTS,
    // so a part-moved row has somewhere truthful to be reported.
    const a = await seedAssayer('SHAPE', 'INVITED');
    const { data } = await bulk(admin.token, [a], 'DOCUMENT_VERIFICATION');
    check('BL-15  the response carries all four buckets, so a part-moved row has somewhere to go',
      ['succeeded', 'partial', 'skipped', 'failed'].every((k) => Array.isArray(data[k])),
      `keys: ${Object.keys(data).join(', ')}`);
    check('BL-16  a clean walk leaves no abandonment row behind',
      (await abandonments(a.id)) === 0,
      `${await abandonments(a.id)} ASSAYER_LIFECYCLE_WALK_ABANDONED rows`);
  }

  check('BL-CONTRACT  no response in this run contradicted the database',
    contradictions.length === 0,
    contradictions.length
      ? contradictions.join('\n        ')
      : 'every reported row matched the row it described, in every call above');

  await pool.query(CLEANUP);
  console.log(`\n(cleanup removed the ${PREFIX} fixtures; audit_events was never written to)`);
  await done();
})().catch(async (e) => {
  console.error(`\nFATAL ${e.stack ?? e.message}`);
  try { await pool.query(CLEANUP); } catch { /* best effort */ }
  try { await pool.end(); } catch { /* best effort */ }
  process.exit(2);
});
