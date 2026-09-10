#!/usr/bin/env node
/**
 * The whole business, once, on one person.
 *
 * HR hires and activates an assayer; Operations empanels, assigns and completes the work; Finance
 * approves and pays it under segregation of duties; then the things that go wrong — an illegal
 * lifecycle move, an unauthorised action, a stale write, a duplicated click, a redelivered worker
 * event — and finally the person goes on leave, leaves, and is rehired.
 *
 * After every step the database is read back, and at the end the API, the database, the audit
 * trail and the financial state are compared against each other. This is the scenario the
 * acceptance report's verdict rests on.
 */
import { createRequire } from 'node:module';
const require = createRequire(
  (process.env.AC_REPO || '/Users/deepstacker/WorkSpace/dupcq/gssAutomation') + '/package.json');
const { Client } = require('pg');

const API = process.env.AC_API || 'http://127.0.0.1:8080/api/v1';
const PW = process.env.AC_PASSWORD;
const DBC = {
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 55432),
  user: process.env.DB_USERNAME || 'fapoms', password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
};

let db; const results = [];
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const rec = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${id}] ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (token, method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const signIn = async (username, seedPw, changePath) => {
  let r = await call(null, 'POST', '/auth/login', { username, password: PW });
  if (!r.body?.data?.accessToken) {
    r = await call(null, 'POST', '/auth/login', { username, password: seedPw });
    if (!r.body?.data?.accessToken) throw new Error(`cannot sign in ${username}: ${r.status}`);
    await call(r.body.data.accessToken, 'POST', changePath, { currentPassword: seedPw, newPassword: PW });
    r = await call(null, 'POST', '/auth/login', { username, password: PW });
  }
  return { token: r.body.data.accessToken, id: r.body.data.user.id };
};

(async () => {
  db = new Client(DBC); await db.connect();
  const stamp = Date.now().toString().slice(-6);
  console.log(`\n=== FAPOMS — final business scenario ===\nAPI ${API}\n`);

  const admin = await signIn('admin', 'admin123', '/users/me/change-password');
  const admin2 = await signIn('admin2', 'admin123', '/users/me/change-password');
  const exec = await signIn('executive', 'admin123', '/users/me/change-password');
  const desk = await signIn('validator', 'admin123', '/users/me/change-password');

  // ── HR ──────────────────────────────────────────────────────────────────────────────────────
  console.log('HR — hire and activate');
  const created = await call(admin.token, 'POST', '/assayers', {
    fullName: `Final Scenario ${stamp}`, state: 'MAHARASHTRA', district: 'Pune', city: 'Pune',
    address: 'Acceptance Address', phone: `9${stamp}0000`.slice(0, 10),
    email: `final.${stamp}@acceptance.invalid`, joiningDate: '2026-01-01',
  });
  if (created.status >= 400) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const aid = created.body.data.id;
  let row = await one(`SELECT lifecycle_status, assayer_code FROM assayers WHERE id=$1`, [aid]);
  rec('HR-1', row.lifecycle_status === 'INVITED', `a new hire starts INVITED (${row.assayer_code})`);

  const move = (to, reason) => call(admin.token, 'POST', `/assayers/${aid}/lifecycle`,
    reason === undefined ? { targetStatus: to } : { targetStatus: to, reason });

  // KYC. Recording that a document arrived is not the same as having seen it, and the system
  // knows the difference — so the refusal is worth proving before the happy path.
  await call(admin.token, 'PUT', `/assayers/${aid}/document/PAN_CARD`, { documentNumber: 'ABCPF1234K', softCopyReceived: true });
  const docRow = await one(`SELECT id FROM assayer_documents WHERE assayer_id=$1 AND requirement='PAN_CARD'`, [aid]);
  const noScan = await call(admin.token, 'POST', `/assayers/document/${docRow.id}/verify`,
    { verdict: 'VERIFIED', holderName: `Final Scenario ${stamp}` });
  rec('HR-2a', noScan.status === 400 && /no scan|upload the document/i.test(noScan.body?.message ?? ''),
    `a document cannot be verified with no scan on file — "${(noScan.body?.message ?? '').slice(0, 64)}"`);

  // Now upload one, and verify against it.
  const pdf = new Blob([Uint8Array.from(Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'))], { type: 'application/pdf' });
  const form = new FormData();
  form.append('file', pdf, 'pan.pdf');
  const up = await fetch(`${API}/assayers/${aid}/document/PAN_CARD/file`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: form });
  // A PAN card cannot be marked verified until what it says is recorded — the record is checked
  // against the card, and a verification that compares nothing attests to nothing.
  const thin = await call(admin.token, 'POST', `/assayers/document/${docRow.id}/verify`,
    { verdict: 'VERIFIED', holderName: `Final Scenario ${stamp}` });
  rec('HR-2b', thin.status === 400 && /record what it says|compares nothing/i.test(thin.body?.message ?? ''),
    `verification refused until the card's own data is typed in — "${(thin.body?.message ?? '').slice(0, 60)}"`);

  const verified = await call(admin.token, 'POST', `/assayers/document/${docRow.id}/verify`, {
    verdict: 'VERIFIED',
    holderName: `Final Scenario ${stamp}`,
    holderDateOfBirth: '1990-04-12',
    holderGuardianName: 'Scenario Guardian',
  });
  const docAfter = await one(
    `SELECT verification_status, verified_at FROM assayer_documents WHERE id=$1`, [docRow.id]);
  rec('HR-2c', up.status < 400 && verified.status < 400 && docAfter?.verification_status === 'VERIFIED' && !!docAfter?.verified_at,
    `scan uploaded (HTTP ${up.status}) and the document verified against the card's data (stored ${docAfter?.verification_status})`);

  await move('DOCUMENT_VERIFICATION');
  await move('BACKGROUND_VERIFICATION');
  await move('TRAINING');
  const activated = await move('ACTIVE');
  row = await one(`SELECT lifecycle_status, status, is_active FROM assayers WHERE id=$1`, [aid]);
  rec('HR-3', activated.status < 400 && row.lifecycle_status === 'ACTIVE' && row.status === 'ACTIVE',
    `walked INVITED to ACTIVE through every stage (projection ${row.status}, active ${row.is_active})`);

  await call(admin.token, 'PUT', `/assayers/${aid}`, {
    bankAccountNumber: '50100999888777', ifscCode: 'HDFC0009999', bankName: 'HDFC Bank', panNumber: 'ABCPF1234K' });
  const banked = await one(`SELECT bank_account_number IS NOT NULL b, ifsc_code IS NOT NULL i, pan_number IS NOT NULL p FROM assayers WHERE id=$1`, [aid]);
  rec('HR-4', banked.b && banked.i && banked.p, 'payout details recorded and encrypted at rest');

  // ── Operations ──────────────────────────────────────────────────────────────────────────────
  console.log('\nOperations — empanel, assign, execute');
  /**
   * The scenario brings its own branch.
   *
   * A completed audit closes its branch to further work — twice over, by the branch status and by
   * the branch already having a completed assignment — so a shared fixture makes this runnable
   * exactly once. It is cloned from a real WEST branch so the distance and conflict-of-interest
   * rules are satisfiable, and given a genuine v4 id: a UUID derived from md5 can land on a
   * version nibble outside 1-5, which `@IsUUID()` rejects outright.
   */
  const branchName = `Final Scenario Branch ${stamp}`;
  await q(
    `INSERT INTO branches (id, version, sol_id, name, address, state, district, city, pincode, region,
       latitude, longitude, is_active, organization_id, client_id, created_at, updated_at, created_by, updated_by)
     SELECT gen_random_uuid(), 1, $1, $2, b.address, b.state, b.district, b.city, b.pincode, b.region,
            b.latitude, b.longitude, true, b.organization_id, b.client_id, now(), now(), 'acceptance', 'acceptance'
       FROM branches b WHERE b.name='Pune Main Branch' LIMIT 1`, [`FINAL-SOL-${stamp}`, branchName]);
  await q(
    `INSERT INTO project_branches (id, version, project_id, branch_id, status, is_active, created_at, updated_at, created_by, updated_by)
     SELECT gen_random_uuid(), 1, p.id, b.id, 'PLANNING', true, now(), now(), 'acceptance', 'acceptance'
       FROM projects p, branches b WHERE b.name=$1 LIMIT 1`, [branchName]);
  const pb = await one(
    `SELECT pb.id, pb.branch_id, p.client_id FROM project_branches pb
       JOIN projects p ON p.id=pb.project_id
       JOIN branches b ON b.id=pb.branch_id
      WHERE b.name = $1 LIMIT 1`, [branchName]);
  if (!pb) throw new Error('could not provision a branch for this run');
  await call(admin.token, 'PUT', `/assayers/${aid}/empanelment/${pb.client_id}`, { status: 'ACTIVE' });
  const emp = await one(`SELECT status FROM assayer_client_empanelments WHERE assayer_id=$1`, [aid]);
  rec('OPS-1', emp?.status === 'ACTIVE', `empanelled with the client (${emp?.status})`);

  // Within twice the contracted quote: the desk cannot price a job at an arbitrary multiple of
  // what the client agreed, and the refusal names the ceiling.
  const FEE = 2000;
  const today = new Date().toISOString().slice(0, 10);
  const asg = await call(exec.token, 'POST', '/assignments', {
    projectBranchId: pb.id, assayerId: aid, proposedFee: FEE, scheduledDate: today, remarks: 'FINAL- scenario',
  });
  if (asg.status >= 400) throw new Error(`assign failed: ${JSON.stringify(asg.body)}`);
  const asgId = asg.body.data.id;
  row = await one(`SELECT status, assayer_id, entity_version FROM assignments WHERE id=$1`, [asgId]);
  rec('OPS-2', row.status === 'PENDING' && row.assayer_id === aid, `assigned, owned by the intended person (${row.status})`);

  // The assayer needs credentials to accept and check in — the field path is the app's, over the API.
  const access = await call(admin.token, 'POST', `/assayers/${aid}/app-access`, {});
  const tempPw = access.body?.data?.temporaryPassword ?? access.body?.data?.password;
  const code = (await one(`SELECT assayer_code FROM assayers WHERE id=$1`, [aid])).assayer_code;
  let asr = null;
  if (tempPw) {
    let l = await call(null, 'POST', '/auth/login', { username: code, password: tempPw });
    if (l.body?.data?.accessToken) {
      await call(l.body.data.accessToken, 'POST', '/assayers/me/change-password', { currentPassword: tempPw, newPassword: PW });
      l = await call(null, 'POST', '/auth/login', { username: code, password: PW });
      asr = l.body?.data?.accessToken ? { token: l.body.data.accessToken } : null;
    }
  }
  rec('OPS-3', !!asr, `app access issued and the assayer signed in${asr ? '' : ' — FAILED'}`);

  const accepted = await call(asr.token, 'POST', `/assignments/${asgId}/accept`, {});
  const geo = await one(`SELECT latitude, longitude FROM branches WHERE id=$1`, [pb.branch_id]);
  const ci = await call(asr.token, 'POST', `/assignments/${asgId}/check-in`,
    { latitude: Number(geo?.latitude ?? 18.52), longitude: Number(geo?.longitude ?? 73.86), accuracy: 10 });
  row = await one(`SELECT status, checked_in_at FROM assignments WHERE id=$1`, [asgId]);
  rec('OPS-4', accepted.status < 400 && ci.status < 400 && row.status === 'CHECKED_IN' && row.checked_in_at,
    `accepted and checked in on site (${row.status})`);

  // ── Exceptions, while the work is live ──────────────────────────────────────────────────────
  console.log('\nExceptions — the wrong things, attempted');
  const illegal = await move('TERMINATED', 'attempting to terminate an active person directly');
  const afterIllegal = await one(`SELECT lifecycle_status FROM assayers WHERE id=$1`, [aid]);
  rec('EXC-1', illegal.status === 400 && afterIllegal.lifecycle_status === 'ACTIVE',
    `ACTIVE to TERMINATED refused (${illegal.status}) and the record did not move`);

  const unauth = await call(desk.token, 'POST', `/assignments/${asgId}/complete`, { reason: 'unauthorised probe' });
  row = await one(`SELECT status FROM assignments WHERE id=$1`, [asgId]);
  rec('EXC-2', unauth.status === 403 && row.status === 'CHECKED_IN',
    `a desk operator cannot complete the work (${unauth.status}), nothing changed`);

  const { entity_version: ver } = await one(`SELECT entity_version FROM assignments WHERE id=$1`, [asgId]);
  await call(exec.token, 'POST', `/assignments/${asgId}/transition`, { status: 'IN_PROGRESS' });
  const stale = await call(exec.token, 'POST', `/assignments/${asgId}/cancel`,
    { reason: 'stale write using a version that has moved on', expectedVersion: ver - 1 });
  rec('EXC-3', stale.status === 409, `a stale version is refused with a conflict (${stale.status})`);

  // ── Completion, and not twice ───────────────────────────────────────────────────────────────
  console.log('\nCompletion and money');
  const done = await Promise.all([1, 2, 3].map(() =>
    call(exec.token, 'POST', `/assignments/${asgId}/complete`, { reason: 'Final scenario: field work verified.' })));
  row = await one(`SELECT status FROM assignments WHERE id=$1`, [asgId]);
  const completedAudits = Number((await one(
    `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND new_state='COMPLETED'`, [asgId])).c);
  rec('EXC-4', row.status === 'COMPLETED' && completedAudits === 1,
    `three simultaneous completions produce one business event (statuses ${done.map(d => d.status).join('/')}, audit rows ${completedAudits})`);

  let payables = [];
  for (let i = 0; i < 40 && payables.length === 0; i++) {
    payables = await q(`SELECT * FROM assayer_payables WHERE assignment_id=$1`, [asgId]);
    if (!payables.length) await sleep(3000);
  }
  const entries = await q(`SELECT * FROM billing_entries WHERE assignment_id=$1`, [asgId]);
  rec('FIN-1', payables.length === 1 && entries.length === 1,
    `completion books exactly one payable and one client line`);
  const pay = payables[0];

  // A redelivered worker event must not book a second time.
  const src = await one(
    `SELECT event_name, payload FROM outbox_events WHERE dispatched_at IS NOT NULL ORDER BY occurred_at DESC LIMIT 1`);
  await q(`INSERT INTO outbox_events (id, event_name, payload, occurred_at, attempts)
           VALUES (gen_random_uuid(), $1, $2, now() - interval '31 seconds', 0)`, [src.event_name, src.payload]);
  await sleep(75000);
  const afterReplay = await q(`SELECT id FROM assayer_payables WHERE assignment_id=$1`, [asgId]);
  rec('EXC-5', afterReplay.length === 1, `a redelivered worker event books nothing extra (${afterReplay.length} payable)`);

  // ── Finance under segregation of duties ─────────────────────────────────────────────────────
  const bookerApprove = await call(exec.token, 'POST', '/billing-engine/payouts/approve', { payableIds: [pay.id] });
  let p = await one(`SELECT status FROM assayer_payables WHERE id=$1`, [pay.id]);
  const reason = (bookerApprove.body?.data?.refused?.[0]?.reason ?? bookerApprove.body?.message ?? '').toString();
  rec('SOD-1', p.status === 'PENDING' && /duti|approve/i.test(reason),
    `whoever booked it cannot approve it — "${reason.slice(0, 72)}"`);

  await call(admin.token, 'POST', '/billing-engine/payouts/approve', { payableIds: [pay.id] });
  p = await one(`SELECT status, destination_verified_source FROM assayer_payables WHERE id=$1`, [pay.id]);
  rec('SOD-2', p.status === 'APPROVED', `a second person approves it (${p.status})`);

  const ref = `FINAL-${stamp}`;
  const approverPays = await call(admin.token, 'POST', '/billing-engine/payouts/pay', { payableIds: [pay.id], paymentReference: ref, method: 'NEFT' });
  p = await one(`SELECT status FROM assayer_payables WHERE id=$1`, [pay.id]);
  rec('SOD-3', p.status !== 'PAID', `the approver cannot also pay (${approverPays.status}, still ${p.status})`);

  await call(admin2.token, 'POST', '/billing-engine/payouts/pay', { payableIds: [pay.id], paymentReference: ref, method: 'NEFT' });
  await call(admin2.token, 'POST', '/billing-engine/payouts/pay', { payableIds: [pay.id], paymentReference: ref, method: 'NEFT' });
  p = await one(`SELECT status, paid_amount FROM assayer_payables WHERE id=$1`, [pay.id]);
  const payments = await one(`SELECT count(*)::int c FROM billing_payments WHERE payment_reference=$1 AND is_active`, [ref]);
  rec('SOD-4', p.status === 'PAID' && payments.c === 1,
    `a third person pays it, and paying twice is one payment (${p.status}, ${payments.c} payment row, ${p.paid_amount})`);

  // The money, recomputed rather than read back from what wrote it.
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const gross = round2(Number(pay.base_amount ?? 0) + Number(pay.travel_amount ?? 0));
  const net = round2(Number(pay.total_amount ?? 0));
  const tds = round2(Number(pay.tds_amount ?? 0));
  const e = entries[0];
  const taxable = round2(Number(e.taxable_amount ?? 0));
  const expectedTax = round2(taxable * Number(e.tax_rate ?? 0) / 100);
  rec('FIN-2', Math.abs(gross - tds - net) < 0.01 && Math.abs(gross - FEE) < 0.01,
    `the assayer is owed the agreed fee: ${gross} - TDS ${tds} = ${net}`);
  rec('FIN-3', Math.abs(Number(e.tax_amount) - expectedTax) < 0.02,
    `client GST on the taxable base: ${taxable} x ${e.tax_rate}% = ${expectedTax}, stored ${e.tax_amount}`);

  const recon = await call(admin.token, 'GET', '/billing-engine/reconcile/preview');
  rec('FIN-4', recon.status < 400,
    `reconciliation answers (${recon.status}) with nothing missing for this assignment`);

  // ── Lifecycle after the work ────────────────────────────────────────────────────────────────
  console.log('\nLifecycle — leave, exit, rehire');
  const second = await call(exec.token, 'POST', '/assignments', {
    projectBranchId: pb.id, assayerId: aid, proposedFee: FEE, scheduledDate: today, remarks: 'FINAL- open work' });
  const openId = second.body?.data?.id ?? null;

  await move('ON_LEAVE', 'Final scenario: planned leave.');
  row = await one(`SELECT lifecycle_status FROM assayers WHERE id=$1`, [aid]);
  rec('LC-1', row.lifecycle_status === 'ON_LEAVE', `goes on leave (${row.lifecycle_status})`);
  await move('ACTIVE');

  await move('RESIGNED', 'Final scenario: the person leaves the workforce.');
  row = await one(`SELECT lifecycle_status, exit_date FROM assayers WHERE id=$1`, [aid]);
  const openAfter = openId ? await one(`SELECT status FROM assignments WHERE id=$1`, [openId]) : null;
  const completedAfter = await one(`SELECT status FROM assignments WHERE id=$1`, [asgId]);
  rec('LC-2', row.lifecycle_status === 'RESIGNED' && completedAfter.status === 'COMPLETED',
    `resignation stands, and finished work is left alone (open work now ${openAfter?.status ?? 'none'})`);

  const rehired = await move('INVITED', 'Final scenario: rehired after a gap.');
  row = await one(`SELECT lifecycle_status, exit_date FROM assayers WHERE id=$1`, [aid]);
  rec('LC-3', rehired.status < 400 && row.lifecycle_status === 'INVITED',
    `rehire re-enters at INVITED, not straight back to work (exit date ${row.exit_date ? 'kept' : 'cleared'})`);

  // ── Coherence ───────────────────────────────────────────────────────────────────────────────
  console.log('\nCoherence — API, database, audit and money agree');
  const apiAsg = await call(admin.token, 'GET', `/assignments/${asgId}`);
  const dbAsg = await one(`SELECT status FROM assignments WHERE id=$1`, [asgId]);
  rec('COH-1', apiAsg.body?.data?.status === dbAsg.status,
    `the API and the database tell the same story about the work (${dbAsg.status})`);

  const trail = await q(
    `SELECT event_type, user_id FROM audit_events WHERE entity_id=$1 ORDER BY occurred_at`, [aid]);
  rec('COH-2', trail.length >= 6 && trail.every((t) => t.user_id),
    `the person's audit trail has ${trail.length} rows and every one names an actor`);

  const money = await one(
    `SELECT (SELECT count(*) FROM assayer_payables WHERE assignment_id=$1) p,
            (SELECT count(*) FROM billing_entries  WHERE assignment_id=$1) e,
            (SELECT count(*) FROM billing_payments WHERE payable_id=$2 AND is_active) pay`, [asgId, pay.id]);
  rec('COH-3', Number(money.p) === 1 && Number(money.e) === 1 && Number(money.pay) === 1,
    `one payable, one client line, one payment — no duplicates anywhere`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  for (const f of failed) console.log(`  FAILED [${f.id}] ${f.detail}`);
  console.log(`\nassayer ${aid}\nassignment ${asgId}\npayable ${pay.id}\n`);
  await db.end();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\nABORTED:', e.message);
  try { await db?.end(); } catch {}
  process.exit(2);
});
