#!/usr/bin/env node
/**
 * FAPOMS production acceptance — the core business loop, end to end, against the running rig.
 *
 * Create -> Accept -> Check-in -> Complete -> Payable -> Approve -> Pay, with the database
 * inspected after every step and segregation of duties probed in both directions.
 *
 * Everything it creates is prefixed ACC- so it can be told apart from seeded data.
 */
import { createRequire } from 'node:module';
// `pg` lives in the workspace, not beside this script.
const require = createRequire(
  process.env.AC_REPO ? `${process.env.AC_REPO}/package.json`
    : '/Users/deepstacker/WorkSpace/dupcq/gssAutomation/package.json');
const { Client } = require('pg');

const API = process.env.AC_API || 'http://127.0.0.1:8080/api/v1';
const PW = process.env.AC_PASSWORD;
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 55432),
  user: process.env.DB_USERNAME || 'fapoms',
  password: process.env.DB_PASSWORD || 'fapoms_dev',
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

/** Sign in, clearing a forced rotation. Tries the campaign password first so re-runs are no-ops. */
const signIn = async (username, seedPw, changePath) => {
  let r = await call(null, 'POST', '/auth/login', { username, password: PW });
  if (!r.body?.data?.accessToken) {
    r = await call(null, 'POST', '/auth/login', { username, password: seedPw });
    if (!r.body?.data?.accessToken) throw new Error(`login failed for ${username}: HTTP ${r.status}`);
    const t = r.body.data.accessToken;
    const chg = await call(t, 'POST', changePath, { currentPassword: seedPw, newPassword: PW });
    if (chg.status >= 400) throw new Error(`rotate failed for ${username}: ${JSON.stringify(chg.body)}`);
    r = await call(null, 'POST', '/auth/login', { username, password: PW });
  }
  return { token: r.body.data.accessToken, id: r.body.data.user.id, username };
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

(async () => {
  db = new Client(DB);
  await db.connect();
  console.log(`\n=== FAPOMS acceptance — core business loop ===\nAPI ${API}\n`);

  // ── personas ────────────────────────────────────────────────────────────────────────────────
  const admin = await signIn('admin', 'admin123', '/users/me/change-password');
  const admin2 = await signIn('admin2', 'admin123', '/users/me/change-password');
  const exec = await signIn('executive', 'admin123', '/users/me/change-password');
  console.log(`signed in: admin=${admin.id.slice(0, 8)} admin2=${admin2.id.slice(0, 8)} executive=${exec.id.slice(0, 8)}\n`);

  // ── leftovers from an earlier run ───────────────────────────────────────────────────────────
  // An assayer may hold one open job per day, so a previous run's still-open offer would be
  // refused as a double booking. Cancelled through the product, not deleted, so the history of
  // every earlier run stays intact.
  const stale = await q(
    `SELECT id FROM assignments WHERE remarks LIKE 'ACC-%' AND is_active
        AND status IN ('PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS')`);
  for (const s of stale) {
    await call(exec.token, 'POST', `/assignments/${s.id}/cancel`,
      { reason: 'Acceptance run: clearing an earlier run of this same probe.' });
  }
  if (stale.length) console.log(`cleared ${stale.length} open assignment(s) from an earlier run\n`);

  // ── fixture: an ACTIVE assayer, empanelled, with payout details ─────────────────────────────
  const [assayer] = await q(
    `SELECT id, assayer_code FROM assayers
      WHERE lifecycle_status='ACTIVE' AND is_active AND assayer_code LIKE 'AS-%'
      ORDER BY assayer_code LIMIT 1`);
  const [pb] = await q(
    `SELECT pb.id, pb.branch_id, b.name AS branch, p.client_id
       FROM project_branches pb JOIN branches b ON b.id=pb.branch_id
       JOIN projects p ON p.id=pb.project_id
      WHERE NOT EXISTS (SELECT 1 FROM assignments a
                         WHERE a.project_branch_id=pb.id AND a.is_active
                           AND a.status IN ('PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS'))
      LIMIT 1`);
  if (!assayer || !pb) throw new Error('no free project_branch or ACTIVE assayer to work with');
  console.log(`fixture: assayer ${assayer.assayer_code}  branch "${pb.branch}"  client ${pb.client_id.slice(0, 8)}\n`);

  // Payout details are mandatory at approval; set them through the product so the encrypted
  // columns round-trip the way a real edit would.
  const payoutSetup = await call(admin.token, 'PUT', `/assayers/${assayer.id}`, {
    bankAccountNumber: '50100234567890', ifscCode: 'HDFC0001234',
    bankName: 'HDFC Bank', panNumber: 'ABCPD1234E',
  });
  const [banked] = await q(
    `SELECT bank_account_number IS NOT NULL AS bank, ifsc_code IS NOT NULL AS ifsc,
            pan_number IS NOT NULL AS pan FROM assayers WHERE id=$1`, [assayer.id]);
  if (!banked.bank || !banked.ifsc || !banked.pan) {
    throw new Error(`payout details did not persist (HTTP ${payoutSetup.status}) — approval would be `
      + `refused for missing banking rather than for the reason under test: ${JSON.stringify(payoutSetup.body)}`);
  }
  // Empanel with this client so the eligibility policy is satisfied on merit, not by override.
  await call(admin.token, 'PUT', `/assayers/${assayer.id}/empanelment/${pb.client_id}`, { status: 'ACTIVE' });

  const FEE = 2500;
  const PAY_REF = `ACC-PAY-${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);

  // The seeded project's window closed in July; scheduling today is refused by the timeline rule
  // (correctly — that refusal is itself recorded as E2E-00). Widen it so the rest of the loop can
  // run against a project that is genuinely open.
  const [proj] = await q(
    `SELECT p.id, p.end_date FROM project_branches pb JOIN projects p ON p.id=pb.project_id WHERE pb.id=$1`, [pb.id]);
  if (proj.end_date && new Date(proj.end_date) < new Date(today)) {
    const beforeWiden = await call(exec.token, 'POST', '/assignments', {
      projectBranchId: pb.id, assayerId: assayer.id, proposedFee: FEE,
      scheduledDate: today, remarks: 'ACC- timeline probe',
    });
    record('E2E-00', beforeWiden.status === 400,
      `scheduling outside the project window is refused (HTTP ${beforeWiden.status}: ${beforeWiden.body?.message ?? ''})`);
    await q(`UPDATE projects SET end_date = $2 WHERE id = $1`, [proj.id, '2027-12-31']);
  } else {
    console.log('  SKIP  [E2E-00] project window already covers today (widened by an earlier run)');
  }

  // ── 1. create ───────────────────────────────────────────────────────────────────────────────
  const base = {
    projectBranchId: pb.id, assayerId: assayer.id, proposedFee: FEE,
    scheduledDate: today, remarks: 'ACC- acceptance loop',
  };
  let created = await call(exec.token, 'POST', '/assignments', base);

  // Sending somebody a long way is allowed, but not silently: the desk has to say why. When the
  // branch this run picked happens to be out of the client's radius, that refusal is itself worth
  // recording, and the override that follows exercises the documented way through it.
  if (created.status === 400 && created.body?.code === 'OVERRIDE_REASON_REQUIRED') {
    record('ELIG-01', true,
      `out-of-radius work is refused until a reason is given: "${created.body.message}"`);
    created = await call(exec.token, 'POST', '/assignments', {
      ...base,
      overrideReason: 'Acceptance run: nearest empanelled assayer is unavailable, desk approved the travel.',
    });
    // No column carries a distance override; the audit trail is where it lives, so that is what
    // gets asserted. What matters is that the decision is attributable afterwards, not that a
    // particular table has a particular field.
    const overrideAudit = await q(
      `SELECT event_type, remarks, metadata, user_id FROM audit_events
        WHERE entity_id=$1 AND event_type='ASSIGNMENT_ELIGIBILITY_OVERRIDDEN'`,
      [created.body?.data?.id ?? '00000000-0000-0000-0000-000000000000']);
    record('ELIG-03', created.status < 400 && overrideAudit.length === 1
      && !!overrideAudit[0].user_id
      && /desk approved the travel/.test(overrideAudit[0].remarks ?? ''),
      `the override is recorded against the person who made it, with their words and the rule `
      + `(${overrideAudit[0]?.metadata?.rule ?? 'no rule'}) — "${(overrideAudit[0]?.remarks ?? '').slice(0, 80)}"`);
  }
  if (created.status >= 400) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const asgId = created.body.data.id;
  let [row] = await q(`SELECT status, assayer_id, entity_version FROM assignments WHERE id=$1`, [asgId]);
  record('E2E-01', row.status === 'PENDING' && row.assayer_id === assayer.id,
    `create -> DB status=${row.status}, owner=${row.assayer_id === assayer.id ? 'the intended assayer' : 'WRONG'}`);

  // ── 2. assayer accepts ──────────────────────────────────────────────────────────────────────
  const asr = await signIn(assayer.assayer_code, 'assayer123', '/assayers/me/change-password');
  const accepted = await call(asr.token, 'POST', `/assignments/${asgId}/accept`, {});
  [row] = await q(`SELECT status, agreed_fee FROM assignments WHERE id=$1`, [asgId]);
  record('E2E-02', accepted.status < 400 && row.status === 'ACCEPTED',
    `assayer accept -> HTTP ${accepted.status}, DB status=${row.status}, agreed_fee=${row.agreed_fee}`);

  // ── 2b. the assayer may not price their own work ────────────────────────────────────────────
  // The fee resolves by precedence — a settled `agreed_fee` if there is one, else the offered
  // `proposed_fee`. An accept that did not negotiate leaves agreed_fee NULL on purpose, so the
  // question worth asking is what the assignment is actually worth, not which column holds it.
  let [fees] = await q(`SELECT proposed_fee, agreed_fee FROM assignments WHERE id=$1`, [asgId]);
  const effectiveFee = Number(fees.agreed_fee) > 0 ? Number(fees.agreed_fee) : Number(fees.proposed_fee);
  record('E2E-03', effectiveFee === FEE,
    `the work is worth the offered ${FEE} after acceptance (agreed=${fees.agreed_fee ?? 'NULL'}, proposed=${fees.proposed_fee}, effective=${effectiveFee})`);

  // An assayer who sends their own price must not get it.
  const greedy = await call(asr.token, 'POST', `/assignments/${asgId}/accept`, { fee: 99999 });
  [fees] = await q(`SELECT proposed_fee, agreed_fee FROM assignments WHERE id=$1`, [asgId]);
  const afterGreedy = Number(fees.agreed_fee) > 0 ? Number(fees.agreed_fee) : Number(fees.proposed_fee);
  record('E2E-03b', afterGreedy === FEE,
    `an assayer cannot price their own work (sent fee=99999, HTTP ${greedy.status}, still worth ${afterGreedy})`);

  // ── 3. check in ─────────────────────────────────────────────────────────────────────────────
  const [branchGeo] = await q(`SELECT latitude, longitude FROM branches WHERE id=$1`, [pb.branch_id]);
  const ci = await call(asr.token, 'POST', `/assignments/${asgId}/check-in`, {
    latitude: Number(branchGeo?.latitude ?? 18.52), longitude: Number(branchGeo?.longitude ?? 73.86), accuracy: 12,
  });
  [row] = await q(`SELECT status, checked_in_at FROM assignments WHERE id=$1`, [asgId]);
  record('E2E-04', ci.status < 400 && row.status === 'CHECKED_IN' && row.checked_in_at !== null,
    `check-in -> HTTP ${ci.status}, DB status=${row.status}, checked_in_at ${row.checked_in_at ? 'stamped' : 'MISSING'}`);

  // ── 4. illegal moves while the work is live ─────────────────────────────────────────────────
  const assayerComplete = await call(asr.token, 'POST', `/assignments/${asgId}/transition`,
    { status: 'COMPLETED', reason: 'assayer attempting to close their own job' });
  record('E2E-05', assayerComplete.status === 403 || assayerComplete.status === 400,
    `assayer cannot COMPLETE their own work -> HTTP ${assayerComplete.status}`);

  // ── 5. staff completes ──────────────────────────────────────────────────────────────────────
  const done = await call(exec.token, 'POST', `/assignments/${asgId}/complete`,
    { reason: 'Acceptance loop: field work finished and verified.' });
  [row] = await q(`SELECT status, completion_date FROM assignments WHERE id=$1`, [asgId]);
  record('E2E-06', done.status < 400 && row.status === 'COMPLETED',
    `complete -> HTTP ${done.status}, DB status=${row.status}`);

  // ── 6. double completion must not double anything ───────────────────────────────────────────
  const again = await call(exec.token, 'POST', `/assignments/${asgId}/complete`,
    { reason: 'Acceptance loop: duplicate press.' });
  const [{ c: completedAudits }] = await q(
    `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND new_state='COMPLETED'`, [asgId]);
  record('E2E-07', completedAudits <= 1,
    `second completion is not a second business event (HTTP ${again.status}, COMPLETED audit rows=${completedAudits})`);

  // ── 7. the payable the worker books ─────────────────────────────────────────────────────────
  let payables = [];
  for (let i = 0; i < 40 && payables.length === 0; i++) {
    payables = await q(`SELECT * FROM assayer_payables WHERE assignment_id=$1`, [asgId]);
    if (payables.length === 0) await new Promise((r) => setTimeout(r, 3000));
  }
  record('E2E-08', payables.length === 1,
    `completion books exactly one payable (found ${payables.length})`);
  if (payables.length !== 1) throw new Error('no payable — the rest of the money path cannot be probed');
  const pay = payables[0];
  const entries = await q(`SELECT * FROM billing_entries WHERE assignment_id=$1`, [asgId]);
  record('E2E-09', entries.length === 1, `and exactly one client line (found ${entries.length})`);

  // ── 8. the money, recomputed independently ──────────────────────────────────────────────────
  // Recomputed here from the stored rates rather than read back from the same service that wrote
  // them: the point is to catch a formula that agrees with itself and with nothing else.
  const gross = round2(Number(pay.base_amount ?? 0) + Number(pay.travel_amount ?? 0));
  const tds = round2(Number(pay.tds_amount ?? 0));
  const total = round2(Number(pay.total_amount ?? 0));
  record('E2E-10', Math.abs(gross - tds - total) < 0.01,
    `payable arithmetic holds: base+travel ${gross} - TDS ${tds} = payable ${total}`);
  record('E2E-11', Math.abs(gross - FEE) < 0.01,
    `the assayer is owed exactly the fee the desk offered (${gross} vs ${FEE})`);

  const ent = entries[0];
  const taxable = round2(Number(ent.taxable_amount ?? 0));
  const taxRate = Number(ent.tax_rate ?? 0);
  const tax = round2(Number(ent.tax_amount ?? 0));
  const expectedTax = round2(taxable * taxRate / 100);
  record('E2E-12', Math.abs(tax - expectedTax) < 0.02,
    `client GST is taken on the taxable base: ${taxable} x ${taxRate}% = ${expectedTax}, stored ${tax}`);

  const cTdsRate = Number(ent.tds_rate ?? 0);
  const cTds = round2(Number(ent.tds_amount ?? 0));
  const expectedCTds = round2(taxable * cTdsRate / 100);
  record('E2E-13', Math.abs(cTds - expectedCTds) < 0.02,
    `client TDS is taken on the base and never on the GST: ${taxable} x ${cTdsRate}% = ${expectedCTds}, stored ${cTds}`);

  const entTotal = round2(Number(ent.total_amount ?? 0));
  const expectedEntTotal = round2(taxable + tax - cTds);
  record('E2E-13b', Math.abs(entTotal - expectedEntTotal) < 0.02,
    `the client line totals up: ${taxable} + GST ${tax} - TDS ${cTds} = ${expectedEntTotal}, stored ${entTotal}`);

  // ── 9. segregation of duties ────────────────────────────────────────────────────────────────
  const bookerApprove = await call(exec.token, 'POST', '/billing-engine/payouts/approve', { payableIds: [pay.id] });
  let [p2] = await q(`SELECT status FROM assayer_payables WHERE id=$1`, [pay.id]);
  // The refusal must be ABOUT separation of duties. A payable refused for missing bank details
  // would leave the same PENDING row and read as a pass, which is how this check nearly lied.
  const bookerReason = (bookerApprove.body?.data?.refused?.[0]?.reason
    ?? bookerApprove.body?.message ?? '').toString();
  const sodRefusal = /approv|duti|booked|same (person|user)|segregation/i.test(bookerReason)
    && !/bank|ifsc|pan/i.test(bookerReason);
  record('SOD-01', p2.status === 'PENDING' && sodRefusal,
    `whoever booked the work cannot approve its payout — refused as a duties conflict: "${bookerReason}"`);

  const approve = await call(admin.token, 'POST', '/billing-engine/payouts/approve', { payableIds: [pay.id] });
  [p2] = await q(`SELECT status, approved_by, destination_verified_at, destination_verified_source
                    FROM assayer_payables WHERE id=$1`, [pay.id]);
  record('SOD-02', p2.status === 'APPROVED',
    `a different person can approve it (HTTP ${approve.status}, status ${p2.status})`);
  record('FIN-01', p2.destination_verified_at === null ? p2.destination_verified_source === null : !!p2.destination_verified_source,
    `payout destination evidence is honest: verified_at=${p2.destination_verified_at ? 'set' : 'NULL'}, source=${p2.destination_verified_source ?? 'NULL'}`);

  const approverPays = await call(admin.token, 'POST', '/billing-engine/payouts/pay',
    { payableIds: [pay.id], paymentReference: PAY_REF, method: 'NEFT' });
  let [p3] = await q(`SELECT status FROM assayer_payables WHERE id=$1`, [pay.id]);
  record('SOD-03', p3.status !== 'PAID',
    `whoever approved cannot also pay (HTTP ${approverPays.status}, status still ${p3.status})`);

  const paid = await call(admin2.token, 'POST', '/billing-engine/payouts/pay',
    { payableIds: [pay.id], paymentReference: PAY_REF, method: 'NEFT' });
  [p3] = await q(`SELECT status, paid_amount FROM assayer_payables WHERE id=$1`, [pay.id]);
  record('SOD-04', p3.status === 'PAID',
    `a third person can pay it (HTTP ${paid.status}, status ${p3.status}, paid ${p3.paid_amount})`);

  // ── 10. paying twice must not pay twice ─────────────────────────────────────────────────────
  const dup = await call(admin2.token, 'POST', '/billing-engine/payouts/pay',
    { payableIds: [pay.id], paymentReference: PAY_REF, method: 'NEFT' });
  const payments = await q(
    `SELECT count(*)::int c, COALESCE(sum(amount),0) total FROM billing_payments
      WHERE payment_reference=$1 AND is_active`, [PAY_REF]);
  record('FIN-02', payments[0].c === 1,
    `the same payment reference twice is one payment, not two (HTTP ${dup.status}, rows=${payments[0].c}, total=${payments[0].total})`);

  const approveAgain = await call(admin.token, 'POST', '/billing-engine/payouts/approve', { payableIds: [pay.id] });
  const [{ c: approvals }] = await q(
    `SELECT count(*)::int c FROM audit_events
      WHERE entity_id=$1 AND event_type='PAYABLE_APPROVED' AND outcome='SUCCESS'`, [pay.id]);
  record('FIN-03', approvals === 1,
    `approving an already-paid payable does not re-approve it (HTTP ${approveAgain.status}, PAYABLE_APPROVED rows=${approvals})`);

  // Every refusal above must be in the trail as a refusal — a denied action that left no trace,
  // or worse left a success-shaped one, is how an audit log starts lying.
  const denials = await q(
    `SELECT event_type, outcome FROM audit_events
      WHERE entity_id=$1 AND event_type='SEGREGATION_OF_DUTIES_REFUSED'`, [pay.id]);
  record('AUD-02', denials.length === 2 && denials.every((d) => d.outcome === 'DENIED'),
    `both duties refusals are recorded as refusals, not as successes `
    + `(${denials.length} rows, outcomes ${[...new Set(denials.map((d) => d.outcome))].join('/')})`);

  // ── 11. cancelling completed work ───────────────────────────────────────────────────────────
  const cancelDone = await call(exec.token, 'POST', `/assignments/${asgId}/cancel`,
    { reason: 'Acceptance probe: cancelling work that is already finished.' });
  [row] = await q(`SELECT status FROM assignments WHERE id=$1`, [asgId]);
  record('E2E-14', cancelDone.status >= 400 && row.status === 'COMPLETED',
    `completed work cannot be cancelled (HTTP ${cancelDone.status}, DB status still ${row.status})`);

  // ── 12. the audit trail tells the story ─────────────────────────────────────────────────────
  const trail = await q(
    `SELECT event_type, user_id, previous_state, new_state, remarks FROM audit_events
      WHERE entity_id=$1 ORDER BY occurred_at`, [asgId]);
  record('AUD-01', trail.length >= 3 && trail.every((t) => t.user_id),
    `the assignment's audit trail has ${trail.length} rows and every one names an actor`);
  console.log('\n  audit trail:');
  for (const t of trail) console.log(`    ${t.event_type}  ${t.previous_state ?? '-'} -> ${t.new_state ?? '-'}`);

  // ── summary ─────────────────────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  [${f.id}] ${f.detail}`);
  }
  console.log(`\nassignment ${asgId}\npayable ${pay.id}\n`);
  await db.end();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\nABORTED:', e.message);
  try { await db?.end(); } catch {}
  process.exit(2);
});
