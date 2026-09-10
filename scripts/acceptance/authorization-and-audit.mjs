#!/usr/bin/env node
/**
 * FAPOMS production acceptance — authorization, isolation, and the audit trail's own defences.
 *
 * Three questions:
 *   1. Can a role reach a write it should not, by calling the API directly? (The UI hiding a
 *      button is not evidence of anything.)
 *   2. Can one assayer reach another's work?
 *   3. Can the application's own database credential take the audit trail apart?
 *
 * Every refusal is checked against the database as well as the status code: a 403 that still
 * mutated is worse than a 200.
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

const results = [];
let db;
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  [${id}] ${detail}`);
};

const call = async (token, method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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

(async () => {
  db = new Client(DBC);
  await db.connect();
  console.log(`\n=== FAPOMS acceptance — authorization, isolation, audit defences ===\nAPI ${API}\n`);

  const admin = await signIn('admin', 'admin123', '/users/me/change-password');
  const validator = await signIn('validator', 'admin123', '/users/me/change-password');
  if (!admin || !validator) throw new Error('could not sign in the staff personas');

  // ── 1. every token must be alive, or a sweep of 403s proves nothing ─────────────────────────
  const aliveV = await call(validator.token, 'GET', '/assignments?limit=1');
  record('AZ-00', aliveV.status < 400 || aliveV.status === 403,
    `the DESK_OPERATOR token is a real session (GET /assignments -> ${aliveV.status})`);

  // ── 2. writes a desk operator must not reach ───────────────────────────────────────────────
  const [victim] = await q(
    `SELECT id, lifecycle_status, version FROM assayers WHERE lifecycle_status='ACTIVE' AND is_active LIMIT 1`);
  const [anyPayable] = await q(`SELECT id, status FROM assayer_payables ORDER BY created_at DESC LIMIT 1`);
  const [anyAssignment] = await q(
    `SELECT id, status FROM assignments WHERE status='COMPLETED' ORDER BY created_at DESC LIMIT 1`);

  const writes = [
    ['AZ-01', 'POST', `/assayers/${victim.id}/lifecycle`, { targetStatus: 'SUSPENDED', reason: 'unauthorised probe attempt' },
      'suspend a person'],
    ['AZ-02', 'DELETE', `/assayers/${victim.id}`, { reason: 'unauthorised probe attempt' }, 'archive a person'],
    ['AZ-03', 'POST', '/assignments', { projectBranchId: victim.id, assayerId: victim.id, proposedFee: 1 },
      'create work'],
    ['AZ-04', 'POST', '/billing-engine/payouts/approve', { payableIds: [anyPayable?.id] }, 'approve money'],
    ['AZ-05', 'POST', '/billing-engine/payouts/pay',
      { payableIds: [anyPayable?.id], paymentReference: 'PROBE', method: 'NEFT' }, 'pay money'],
    ['AZ-06', 'POST', `/assignments/${anyAssignment?.id}/reopen`, { reason: 'unauthorised probe attempt' },
      'reopen finished work'],
  ];

  const before = {
    lifecycle: victim.lifecycle_status,
    payable: anyPayable?.status ?? null,
    assignment: anyAssignment?.status ?? null,
    assignments: Number((await q(`SELECT count(*)::int c FROM assignments`))[0].c),
  };

  for (const [id, method, path, body, what] of writes) {
    const r = await call(validator.token, method, path, body);
    record(id, r.status === 403 || r.status === 401,
      `a DESK_OPERATOR cannot ${what} (${method} ${path.split('?')[0].slice(0, 46)} -> ${r.status})`);
  }

  const after = {
    lifecycle: (await q(`SELECT lifecycle_status FROM assayers WHERE id=$1`, [victim.id]))[0].lifecycle_status,
    payable: anyPayable ? (await q(`SELECT status FROM assayer_payables WHERE id=$1`, [anyPayable.id]))[0].status ?? null : null,
    assignment: anyAssignment ? (await q(`SELECT status FROM assignments WHERE id=$1`, [anyAssignment.id]))[0].status ?? null : null,
    assignments: Number((await q(`SELECT count(*)::int c FROM assignments`))[0].c),
  };
  record('AZ-07', JSON.stringify(before) === JSON.stringify(after),
    `and none of those refusals changed anything (lifecycle ${before.lifecycle}->${after.lifecycle}, `
    + `payable ${before.payable}->${after.payable}, assignments ${before.assignments}->${after.assignments})`);

  // ── 3. one assayer must not reach another's work ───────────────────────────────────────────
  const pair = await q(
    `SELECT DISTINCT a.assayer_id, asr.assayer_code FROM assignments a
       JOIN assayers asr ON asr.id=a.assayer_id WHERE a.is_active LIMIT 2`);
  const owner = pair[0];
  const [others] = await q(
    `SELECT id, assayer_code FROM assayers WHERE id <> $1 AND lifecycle_status='ACTIVE' AND is_active LIMIT 1`,
    [owner?.assayer_id ?? '00000000-0000-0000-0000-000000000000']);
  const intruder = others ? await signIn(others.assayer_code, 'assayer123', '/assayers/me/change-password') : null;
  if (intruder && owner) {
    const [job] = await q(
      `SELECT id FROM assignments WHERE assayer_id=$1 AND is_active ORDER BY created_at DESC LIMIT 1`,
      [owner.assayer_id]);
    const peek = await call(intruder.token, 'GET', `/assignments/assayer/${owner.assayer_id}`);
    record('AZ-10', peek.status === 403 || peek.status === 404,
      `${others.assayer_code} cannot list ${owner.assayer_code}'s work (-> ${peek.status})`);
    const grab = await call(intruder.token, 'POST', `/assignments/${job.id}/accept`, {});
    const [stillOwned] = await q(`SELECT assayer_id FROM assignments WHERE id=$1`, [job.id]);
    record('AZ-11', (grab.status === 403 || grab.status === 400) && stillOwned.assayer_id === owner.assayer_id,
      `${others.assayer_code} cannot accept ${owner.assayer_code}'s job (-> ${grab.status}, owner unchanged)`);
    const bank = await call(intruder.token, 'GET', `/assayers/${owner.assayer_id}/sensitive/bank`);
    record('AZ-12', bank.status === 403 || bank.status === 404,
      `${others.assayer_code} cannot read ${owner.assayer_code}'s bank details (-> ${bank.status})`);
  } else {
    record('AZ-10', false, 'could not sign in a second assayer to probe horizontal isolation');
  }

  // ── 4. the audit trail against the application's own credential ────────────────────────────
  // Everything here runs inside a transaction that is always rolled back: a probe that proves a
  // control by destroying evidence is how 5,621 audit rows were lost on 9 September.
  const runtimePw = process.env.FAPOMS_RUNTIME_PASSWORD;
  if (runtimePw) {
    const rt = new Client({ ...DBC, user: 'fapoms_runtime', password: runtimePw });
    await rt.connect();
    const asRuntime = async (sql) => {
      await rt.query('BEGIN');
      try { await rt.query(sql); await rt.query('ROLLBACK'); return { refused: false, error: null }; }
      catch (e) { await rt.query('ROLLBACK'); return { refused: true, error: e.message.split('\n')[0] }; }
    };
    const [{ c: auditRows }] = (await rt.query(`SELECT count(*)::int c FROM audit_events`)).rows;
    record('AUD-10', auditRows > 0, `the runtime can read the audit trail (${auditRows} rows)`);

    const vectors = [
      ['AUD-11', `UPDATE audit_events SET remarks='tampered'`, 'rewrite an audit row'],
      ['AUD-12', `DELETE FROM audit_events`, 'delete the audit trail'],
      ['AUD-13', `TRUNCATE audit_events`, 'truncate the audit trail'],
      ['AUD-14', `TRUNCATE audit_events, audit_chain`, 'truncate both in one statement'],
      ['AUD-15', `ALTER TABLE audit_events DISABLE TRIGGER USER`, 'switch the protections off'],
      ['AUD-16', `DROP TABLE audit_events`, 'drop the table'],
      ['AUD-17', `UPDATE audit_chain SET row_hash='0'`, 'rewrite the hash chain'],
    ];
    for (const [id, sql, what] of vectors) {
      const r = await asRuntime(sql);
      record(id, r.refused, `the runtime cannot ${what} — ${r.refused ? r.error : 'IT SUCCEEDED'}`);
    }

    const appended = await asRuntime(
      `INSERT INTO audit_events (id, event_type, category, entity_type, entity_id, occurred_at)
       VALUES (gen_random_uuid(), 'ACCEPTANCE_PROBE', 'SYSTEM', 'probe', gen_random_uuid(), now())`);
    record('AUD-18', !appended.refused,
      `but it can still append, which is what the application needs${appended.error ? ` (${appended.error})` : ''}`);
    await rt.end();
  } else {
    record('AUD-10', false, 'FAPOMS_RUNTIME_PASSWORD not supplied — audit defences not probed');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  for (const f of failed) console.log(`  FAILED [${f.id}] ${f.detail}`);
  await db.end();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\nABORTED:', e.message);
  try { await db?.end(); } catch {}
  process.exit(2);
});
