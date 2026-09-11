#!/usr/bin/env node
/**
 * The financial invariant across reopen and redo.
 *
 * For every legitimate completion of an assignment there must be exactly ONE live payable and
 * ONE live client line. Money withdrawn by a reopen stays in the tables as history and must
 * neither be mistaken for a current booking nor block the next one.
 *
 * This exists because it was not true. A completed audit that was reopened, redone and completed
 * again booked nothing at all: `bookAssignment` found the voided payable, read "a row exists" as
 * "already booked", and returned. The assayer was never paid for the work they redid, the client
 * was never billed, the money view reported `booked: true` beside the voided row, and the
 * reconciler that repairs exactly this could not see it because its LEFT JOIN matched the
 * cancelled line too. Detection and repair share that query, so the recovery path was blind in
 * the same way.
 *
 * Usage:  node scripts/acceptance/reopen-redo-money.mjs
 * Env:    reads scratchpad acc.env (AC_API, AC_PASSWORD, DB_*) via pa/lib.mjs when present,
 *         otherwise AC_API / AC_PASSWORD / DB_* from the environment.
 */
/**
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * SAFETY CLASSIFICATION: WRITES
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * password    : none beyond sign-in.
 * api writes  : creates a fixture branch and an assignment, then completes / reopens /
 *               re-completes it. BOOKS AND VOIDS REAL MONEY each time round.
 * deletion    : DELETEs its own fixture at the end — payments, payables, billing entries, the
 *               assignment, the project_branch and the branch.
 * gate        : declareMutating + AC_ALLOW_WRITES.
 *
 * The full table for every script here is in scripts/acceptance/README.md.
 */
import { env, req, sql, one, login, tally, freshBranch, pool, declareMutating } from './_lib.mjs';

const { check, done } = tally();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 70_000;

/** Every fee payable and client line for an assignment, split into live and historical. */
async function money(id) {
  const payables = await sql(
    `SELECT payable_number AS n, status, total_amount FROM assayer_payables
      WHERE assignment_id = $1 AND expense_id IS NULL ORDER BY created_at`, [id]);
  const entries = await sql(
    `SELECT entry_number AS n, state, total_amount FROM billing_entries
      WHERE assignment_id = $1 ORDER BY created_at`, [id]);
  return {
    payables, entries,
    livePayables: payables.filter((p) => p.status !== 'VOIDED'),
    liveEntries: entries.filter((e) => e.state !== 'CANCELLED'),
    show: () => `payables[${payables.map((p) => `${p.n}=${p.status}`).join(', ') || 'none'}] `
      + `lines[${entries.map((e) => `${e.n}=${e.state}`).join(', ') || 'none'}]`,
  };
}

/** Wait until the outbox and worker have settled, or the budget runs out. */
async function settle(id, predicate) {
  const deadline = Date.now() + SETTLE_MS;
  let m = await money(id);
  while (Date.now() < deadline && !predicate(m)) { await wait(2000); m = await money(id); }
  return m;
}

const main = async () => {
  declareMutating('reopen-redo-money', [
    'creates a fixture branch and project_branch, then a real assignment on it, and drives that',
    '  assignment through accept / check-in / complete / reopen / re-complete',
    'BOOKS AND VOIDS REAL MONEY: assayer_payables and billing_entries rows are created by the',
    '  worker as a consequence, and the reopen voids/cancels them',
    'deletes its own fixture at the end — payments, payables, billing entries, the assignment,',
    '  the project_branch and the branch',
  ]);
  const admin = await login('admin', env.AC_PASSWORD);
  check('admin session alive', !!admin.token, 'token issued');

  const br = await freshBranch('Reopen Redo Invariant');
  const assayer = await one(`
    SELECT id, assayer_code FROM assayers
     WHERE lifecycle_status = 'ACTIVE' AND is_active
       AND bank_account_number IS NOT NULL AND ifsc_code IS NOT NULL AND pan_number IS NOT NULL
     LIMIT 1`);
  check('found a payable-ready ACTIVE assayer', !!assayer, assayer?.assayer_code);
  await req(`/assayers/${assayer.id}/empanelment/${br.clientId}`,
    { method: 'PUT', token: admin.token, body: { status: 'ACTIVE' } });

  /**
   * Walk candidate dates until the answer stops being about the calendar. `isHoliday` also
   * consults the client's configured working days, so a Saturday comes back as "a holiday" with
   * no holiday row behind it — a refusal that says nothing about what is under test.
   */
  const days = await sql(`
    SELECT d.day::text AS day FROM generate_series(current_date + 2, current_date + 45, '1 day') AS d(day)
     WHERE d.day BETWEEN (SELECT start_date FROM projects p JOIN project_branches pb ON pb.project_id = p.id WHERE pb.id = $1)
                     AND (SELECT end_date   FROM projects p JOIN project_branches pb ON pb.project_id = p.id WHERE pb.id = $1)
     ORDER BY d.day LIMIT 20`, [br.pbId]);
  let created = null; const tried = [];
  for (const d of days) {
    const r = await req('/assignments', {
      method: 'POST', token: admin.token,
      body: { projectBranchId: br.pbId, assayerId: assayer.id, scheduledDate: d.day,
              proposedFee: 2000, clientRequestId: `redo-inv-${Date.now()}` },
    });
    tried.push(`${String(d.day).slice(0, 10)}:${r.status}`);
    if (!/Holiday Conflict|Timeline Conflict|on leave|double booking/i.test(JSON.stringify(r.msg ?? ''))) {
      if (r.status === 201 || r.status === 200) created = r.body?.data;
      break;
    }
  }
  check('booked the work', !!created?.id, `tried ${tried.length} dates: ${tried.join(', ')}`);
  if (!created?.id) { await done(); return; }
  const id = created.id;
  await req(`/assignments/${id}/accept`, { method: 'POST', token: admin.token, body: {} });

  const complete = (why) => req(`/assignments/${id}/complete`,
    { method: 'POST', token: admin.token, body: { reason: why } });
  const reopen = (why) => req(`/assignments/${id}/reopen`,
    { method: 'POST', token: admin.token, body: { reason: why } });

  // ── Cycle 1 ────────────────────────────────────────────────────────────────
  await complete('First completion, for the invariant probe.');
  let m = await settle(id, (x) => x.livePayables.length && x.liveEntries.length);
  check('first completion books exactly one live payout and one live client line',
    m.livePayables.length === 1 && m.liveEntries.length === 1, m.show());

  await reopen('The gold weight was recorded wrongly; the branch must be revisited.');
  m = await settle(id, (x) => x.livePayables.length === 0);
  check('reopen withdraws the money and leaves the history in place',
    m.livePayables.length === 0 && m.liveEntries.length === 0
      && m.payables.length === 1 && m.entries.length === 1, m.show());

  await complete('Revisited and re-valued; closing again.');
  m = await settle(id, (x) => x.livePayables.length && x.liveEntries.length);
  check('THE REDONE WORK IS PAID FOR — a new live payout exists',
    m.livePayables.length === 1, m.show());
  check('THE REDONE WORK IS BILLED — a new live client line exists',
    m.liveEntries.length === 1, m.show());
  check('the withdrawn money is still there as history, not deleted',
    m.payables.length === 2 && m.entries.length === 2, m.show());

  // ── Cycle 2: it must keep working, not just work once ──────────────────────
  await reopen('Second review: the client disputed the valuation again.');
  m = await settle(id, (x) => x.livePayables.length === 0);
  check('a second reopen withdraws only the current money',
    m.livePayables.length === 0 && m.payables.length === 2, m.show());

  await complete('Revisited a second time; closing again.');
  m = await settle(id, (x) => x.livePayables.length && x.liveEntries.length);
  check('a second redo books its own money — one live pair, three rows of history',
    m.livePayables.length === 1 && m.liveEntries.length === 1
      && m.payables.length === 3 && m.entries.length === 3, m.show());

  // ── Duplicate and concurrent redo: exactly one effect ──────────────────────
  const beforeDup = await money(id);
  const dup = await complete('Duplicate completion of an already-completed assignment.');
  const afterDup = await settle(id, () => true);
  check('completing an already-completed assignment adds no money',
    afterDup.payables.length === beforeDup.payables.length
      && afterDup.entries.length === beforeDup.entries.length,
    `-> ${dup.status}; ${afterDup.show()}`);

  await reopen('Third reopen, to race the redo.');
  await settle(id, (x) => x.livePayables.length === 0);
  const racers = await Promise.all([
    complete('Concurrent redo A.'), complete('Concurrent redo B.'), complete('Concurrent redo C.'),
  ]);
  m = await settle(id, (x) => x.livePayables.length >= 1);
  check('three simultaneous completions of one redo produce exactly one live payout',
    m.livePayables.length === 1 && m.liveEntries.length === 1,
    `statuses ${racers.map((r) => r.status).join('/')}; ${m.show()}`);

  // ── The reconciler must see, and repair, what it can fix ───────────────────
  // Break it deliberately: withdraw the live money without going through reopen, which is the
  // shape any future gap would leave behind.
  await sql(`UPDATE assayer_payables SET status = 'VOIDED' WHERE assignment_id = $1 AND status <> 'VOIDED'`, [id]);
  await sql(`UPDATE billing_entries SET state = 'CANCELLED' WHERE assignment_id = $1 AND state <> 'CANCELLED'`, [id]);
  const broken = await money(id);
  check('the assignment is now completed with no live money — the state to detect',
    broken.livePayables.length === 0 && broken.liveEntries.length === 0, broken.show());

  const preview = await req('/billing-engine/reconcile/preview', { token: admin.token });
  const count = preview.body?.data?.count ?? preview.body?.data?.unbookedAssignmentIds?.length ?? 0;
  check('the reconciler DETECTS the financially incomplete assignment',
    typeof count === 'number' && count > 0, `reconcile/preview -> count = ${count}`);

  await req('/billing-engine/reconcile', { method: 'POST', token: admin.token, body: {} });
  m = await settle(id, (x) => x.livePayables.length && x.liveEntries.length);
  check('the reconciler REPAIRS it — one live payout and one live client line',
    m.livePayables.length === 1 && m.liveEntries.length === 1, m.show());

  const afterFirstRepair = await money(id);
  await req('/billing-engine/reconcile', { method: 'POST', token: admin.token, body: {} });
  const afterSecondRepair = await settle(id, () => true);
  check('running the repair again is a no-op',
    afterSecondRepair.payables.length === afterFirstRepair.payables.length
      && afterSecondRepair.entries.length === afterFirstRepair.entries.length,
    `${afterFirstRepair.payables.length} -> ${afterSecondRepair.payables.length} payables`);

  // ── What the product says about itself ────────────────────────────────────
  const mv = await req(`/billing-engine/assignments/${id}/money`, { token: admin.token });
  const d = mv.body?.data ?? {};
  check('the money card reports booked from the LIVE legs', d.booked === true,
    `booked = ${JSON.stringify(d.booked)}`);
  check('the money card shows the live payout, not a voided one',
    d.payable && d.payable.status !== 'VOIDED', `payable.status = ${d.payable?.status}`);
  check('the withdrawn money is still visible as history',
    (d.superseded?.payables?.length ?? 0) >= 1,
    `superseded payables = ${d.superseded?.payables?.length ?? 0}, lines = ${d.superseded?.entries?.length ?? 0}`);

  // Clean up: children first, and never audit_events.
  await sql('DELETE FROM billing_payments WHERE payable_id IN (SELECT id FROM assayer_payables WHERE assignment_id = $1)', [id]);
  await sql('DELETE FROM assayer_payables WHERE assignment_id = $1', [id]);
  await sql('DELETE FROM billing_entries WHERE assignment_id = $1', [id]);
  await sql('DELETE FROM assignments WHERE id = $1', [id]);
  await sql('DELETE FROM project_branches WHERE id = $1', [br.pbId]);
  await sql('DELETE FROM branches WHERE id = $1', [br.branchId]);
  console.log('  cleaned up the probe assignment and branch');

  await done();
};

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(2); });
