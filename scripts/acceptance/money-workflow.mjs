#!/usr/bin/env node
/**
 * The money workflow end to end, on both roads, and every way it must refuse to be walked.
 *
 * This is the probe for the billing rebuild of 2026-09-18. That rebuild reorganised the desk's
 * screens around five jobs and introduced two things the server had not been asked for before:
 * a payout STAGE model (`?onBill=true|false`, so "due" stops meaning two incompatible piles),
 * and a recorded exception on the approval path (approving a payout the assayer never confirmed
 * now carries a reason onto its history row). A UI reorganisation is worth nothing if the rules
 * underneath it are not the rules it claims, so this walks them.
 *
 * It is written around one idea: **a refusal is only real if nothing moved.** Every illegal step
 * is followed by a read of the database, not of the HTTP status, because a 409 with a write
 * behind it is worse than a 200. Symmetrically, every legal step is confirmed in the tables and
 * not from the response body.
 *
 * The two roads to an approved payout, both walked here:
 *
 *   the normal road   complete -> bill the assayer -> they confirm -> the desk approves the BILL,
 *                     which approves every payout on it in one gesture, with consent on record
 *   the exception     complete -> the desk approves the payout directly, because that assayer
 *                     cannot confirm (no smartphone, has left) — allowed, and recorded as to why
 *
 * Since 2026-09-24 money also needs the HOD's FINAL approval after the office's: a bill, a payout
 * approved without a bill, and a client invoice before it is sent. Act 3b walks that gate —
 * payment refused until the HOD approves, the office approver refused as the HOD, the office
 * (OPERATIONS) refused the HOD's route, the HOD sending a payout back — and every later payment
 * goes through it. The HOD is `AC_HOD` (default admin2, an ADMIN who is NOT the office approver).
 *
 * Usage:  AC_ALLOW_WRITES=1 AC_API=http://127.0.0.1:3001/api/v1 AC_PASSWORD=... \
 *           DB_HOST=127.0.0.1 DB_PORT=55433 node scripts/acceptance/money-workflow.mjs
 */
/**
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * SAFETY CLASSIFICATION: WRITES
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * password    : none beyond sign-in. Never rotates anything.
 * api writes  : creates fixture branches and assignments, completes them, bills and approves and
 *               PAYS the resulting payouts, raises a client invoice and settles it. Gives the HOD's
 *               final approval (as AC_HOD) and sends one payout back to the office.
 *               BOOKS, APPROVES AND PAYS REAL MONEY.
 * db writes   : fills bank account / IFSC / PAN on ONE assayer it picks, so a payout can be
 *               approved at all — restored to whatever they held before, at the end.
 * deletion    : DELETEs its own fixture — payments, payables, entries, invoices, history, the
 *               assignments, the project_branches and the branches.
 * gate        : declareMutating + AC_ALLOW_WRITES.
 *
 * The full table for every script here is in scripts/acceptance/README.md.
 */
import {
  env, req, sql, one, login, tally, freshBranch, declareMutating,
  postAndAwait, JOB_STATUS, describeJobOutcome,
} from './_lib.mjs';

const { check, done } = tally();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TAG = `MW-${Date.now()}`;
/** Every fixture branch is cloned from this one, so assayers are chosen relative to it. */
const SOURCE_BRANCH = env.AC_SOURCE_BRANCH ?? 'Pune Main Branch';
const SETTLE_MS = 90_000;
const money = (n) => `₹${Number(n).toFixed(2)}`;

/** Everything created by this run, so teardown never guesses. */
const made = { branchIds: [], pbIds: [], assignmentIds: [], invoiceIds: [], billIds: [] };

/**
 * THREE accounts, and the separation between them is the point.
 *
 * `booker` creates and completes the work, `approver` releases the money, `payer` records what
 * the bank actually sent. Segregation of duties refuses the same account doing two adjacent
 * steps, and there are TWO such rules, not one — book-then-approve, and approve-then-pay. A
 * probe signed in once cannot reach a single approval, and one signed in twice reaches approval
 * but never a payment. The first version of this script spent fourteen failing checks
 * rediscovering that, which is worth knowing but is not what the other forty are for, so Act 8
 * now asserts the control deliberately and everything else stays out of its way.
 */
let token = null;        // the approver — approves payouts and bills, and may never pay them
let bookerToken = null;  // creates and completes assignments, and may never approve their payouts
let payerToken = null;   // records the bank payment, and may never have approved what it pays
let hodToken = null;     // the HOD's final approval (2026-09-24) — may never be the office approver
const get = (p) => req(p, { token });
const post = (p, body) => req(p, { method: 'POST', token, body });
const patch = (p, body) => req(p, { method: 'PATCH', token, body });
const postAs = (t, p, body) => req(p, { method: 'POST', token: t, body });
const dataOf = (r) => (r.body && 'data' in r.body ? r.body.data : r.body);

// ── reading the tables, which is the only evidence this script trusts ─────────────────────────

const payablesFor = (assignmentId) => sql(
  `SELECT id, payable_number AS n, status, on_hold, hold_reason, total_amount, paid_amount,
          assayer_invoice_id, expense_id
     FROM assayer_payables WHERE assignment_id = $1 ORDER BY created_at`, [assignmentId]);

const entriesFor = (assignmentId) => sql(
  `SELECT id, entry_number AS n, state, on_hold, total_amount, invoice_id
     FROM billing_entries WHERE assignment_id = $1 ORDER BY created_at`, [assignmentId]);

const liveFeePayable = async (assignmentId) => (await payablesFor(assignmentId))
  .find((p) => p.expense_id === null && p.status !== 'VOIDED') ?? null;

/** Wait for the outbox and worker to reach a state, or give up and report what it did reach. */
async function settle(assignmentId, predicate, budget = SETTLE_MS) {
  const deadline = Date.now() + budget;
  for (;;) {
    const p = await payablesFor(assignmentId);
    const e = await entriesFor(assignmentId);
    if (predicate({ p, e }) || Date.now() > deadline) return { p, e };
    await wait(1500);
  }
}

/**
 * A refusal that is only a refusal if the row is untouched.
 *
 * Takes the payout's whole row before, runs the illegal act, and compares. The status code is
 * reported but never the thing asserted on: an endpoint that answers 409 and writes anyway is
 * the exact failure this shape exists to catch.
 */
async function refusesAndLeavesUnmoved(name, payableId, act, { expect = /.*/ } = {}) {
  const before = await one('SELECT * FROM assayer_payables WHERE id = $1', [payableId]);
  const r = await act();
  const after = await one('SELECT * FROM assayer_payables WHERE id = $1', [payableId]);
  const said = JSON.stringify(r?.msg ?? r?.body?.message ?? r?.detail ?? '');
  const unmoved = before.status === after.status
    && String(before.total_amount) === String(after.total_amount)
    && String(before.paid_amount) === String(after.paid_amount)
    && before.on_hold === after.on_hold;
  const refused = r.refused === true || (typeof r.status === 'number' && r.status >= 400);
  check(name, refused && unmoved && expect.test(said),
    `answered ${r.status ?? 'refused-in-run'} ${said.slice(0, 160)} · row ${before.status}->${after.status}`);
}

/** Approve payouts through the queue, returning the run's own done/refused lists. */
const approve = (payableIds, reason) => postAndAwait(
  '/billing-engine/payouts/approve', reason ? { payableIds, reason } : { payableIds },
  JOB_STATUS.billingBulk, { token: () => token });

/** The HOD's final approval of one item: 'assayer-invoices', 'payouts' or 'invoices'. */
const hodApprove = (path, id, t = () => hodToken) => req(`/billing-engine/final-approval/${path}/${id}/approve`, { method: 'POST', token: t() });
const hodReject = (path, id, reason) => req(`/billing-engine/final-approval/${path}/${id}/reject`, { method: 'POST', token: hodToken, body: { reason } });

/** Paying runs as the payer, who must not be whoever approved these rows. */
const payOut = (payableIds, body) => postAndAwait(
  '/billing-engine/payouts/pay', { payableIds, ...body },
  JOB_STATUS.billingBulk, { token: () => payerToken });

/** A queued per-row refusal wears a different shape from an HTTP one; normalise for the helper. */
const asRefusal = (run) => {
  if (run.status >= 400) return { status: run.status, msg: run.r?.msg };
  const refusedRow = run.result?.refused?.[0];
  return { status: run.status, refused: !!refusedRow, msg: refusedRow?.reason ?? describeJobOutcome(run) };
};

// ── fixture ──────────────────────────────────────────────────────────────────────────────────

/** A branch nobody has audited, with an assignment on it, completed so its money is booked. */
async function completedAssignment(assayerId, label, fee = 2400) {
  const br = await freshBranch(`${TAG} ${label}`, SOURCE_BRANCH);
  made.branchIds.push(br.branchId); made.pbIds.push(br.pbId);
  await req(`/assayers/${assayerId}/empanelment/${br.clientId}`,
    { method: 'PUT', token, body: { status: 'ACTIVE' } });

  /**
   * Walk candidate dates until the refusal stops being about the calendar. `isHoliday` also
   * consults the client's working days, so a Saturday comes back as "a holiday" with no holiday
   * row behind it — a refusal that says nothing about what is under test.
   *
   * The window is NOT filtered in SQL. It was, and on a seeded database whose only project ran
   * July 2026 that produced zero candidate days and a bare "could not book an assignment" —
   * the fixture failing in a way that reads exactly like the product refusing. Every refusal is
   * collected instead, so a run that cannot book says which wall it hit.
   */
  const days = await sql(`
    SELECT d.day::date::text AS day FROM generate_series(current_date + 2, current_date + 45, '1 day') AS d(day)
     ORDER BY d.day LIMIT 25`);
  let created = null; const tried = [];
  for (const d of days) {
    const r = await postAs(bookerToken, '/assignments', {
      projectBranchId: br.pbId, assayerId, scheduledDate: d.day,
      proposedFee: fee, clientRequestId: `${TAG}-${label}-${Date.now()}`,
    });
    tried.push(`${d.day}:${r.status}${r.status >= 400 ? ` ${String(r.msg).slice(0, 60)}` : ''}`);
    if (!/Holiday Conflict|Timeline Conflict|on leave|double booking|outside the project/i.test(JSON.stringify(r.msg ?? ''))) {
      if (r.status === 201 || r.status === 200) created = dataOf(r);
      break;
    }
  }
  if (!created?.id) return { br, id: null, why: tried.slice(0, 4).join(' | ') };
  made.assignmentIds.push(created.id);
  await postAs(bookerToken, `/assignments/${created.id}/accept`, {});
  await postAs(bookerToken, `/assignments/${created.id}/complete`, { reason: `${TAG} ${label}: audit finished.` });
  const s = await settle(created.id, ({ p, e }) => p.some((x) => x.status !== 'VOIDED') && e.some((x) => x.state !== 'CANCELLED'));
  return { br, id: created.id, ...s };
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────

const main = async () => {
  declareMutating('money-workflow', [
    'creates fixture branches and project_branches, and a real assignment on each',
    'drives those assignments through accept / complete — which BOOKS REAL MONEY',
    'bills an assayer, confirms on their behalf, APPROVES and PAYS real payouts',
    'raises a client invoice, sends it and records real payments against it',
    'fills bank account / IFSC / PAN on ONE assayer so a payout can be approved, and restores',
    '  whatever those three columns held before',
    'deletes its own fixture at the end — payments, payables, entries, invoices, history,',
    '  assignments, project_branches and branches',
  ]);

  const approver = await login(env.AC_APPROVER ?? 'admin', env.AC_PASSWORD);
  const booker = await login(env.AC_BOOKER ?? 'manager', env.AC_BOOKER_PASSWORD ?? env.AC_PASSWORD);
  const payer = await login(env.AC_PAYER ?? 'admin2', env.AC_PAYER_PASSWORD ?? env.AC_PASSWORD);
  const hod = await login(env.AC_HOD ?? 'admin2', env.AC_HOD_PASSWORD ?? env.AC_PAYER_PASSWORD ?? env.AC_PASSWORD);
  token = approver.token;
  bookerToken = booker.token;
  payerToken = payer.token;
  hodToken = hod.token;
  check('the HOD session is alive, and is not the office approver',
    !!hodToken && (env.AC_HOD ?? 'admin2') !== (env.AC_APPROVER ?? 'admin'), `hod=${env.AC_HOD ?? 'admin2'}`);
  check('three SEPARATE sessions are alive — one books, one approves, one pays',
    !!token && !!bookerToken && !!payerToken,
    `booker=${env.AC_BOOKER ?? 'manager'} approver=${env.AC_APPROVER ?? 'admin'} payer=${env.AC_PAYER ?? 'admin2'}`);
  if (!token || !bookerToken || !payerToken) return done();

  /**
   * Two assayers, chosen by DISTANCE from the branch these fixtures are cloned from.
   *
   * Not by `created_at`. The first seeded assayer is filed under "Pune City" and carries
   * Bangalore's coordinates — the district/city pollution the roster is known for — so picking
   * the oldest row got every assignment refused with "Out of range: 745.3km exceeds the client's
   * 200km limit". That is a real business rule doing its job on a fixture that had no business
   * being 745km away, and it reads exactly like a product failure when it lands in the setup.
   */
  /**
   * The client's coverage rule has BOTH ends, and a fixture has to land between them: under 5km
   * is refused as a conflict of interest (the assayer effectively lives at the branch) and over
   * 200km as out of range. Picking the nearest assayer walked straight into the first; picking
   * the oldest row walked into the second. The window below is a degree-space proxy for that
   * band — about 9km to 130km — comfortably inside both walls without this script needing to
   * read the client's configuration or reimplement the distance the server computes.
   */
  const BAND = `AND (a.latitude - b.latitude) ^ 2 + (a.longitude - b.longitude) ^ 2 BETWEEN 0.08 ^ 2 AND 1.2 ^ 2`;
  const NEAR = `ORDER BY (a.latitude - b.latitude) ^ 2 + (a.longitude - b.longitude) ^ 2`;
  const payee = await one(`
    SELECT a.id, a.assayer_code, a.bank_account_number, a.ifsc_code, a.pan_number
      FROM assayers a, branches b
     WHERE b.name = $1 AND a.lifecycle_status = 'ACTIVE' AND a.is_active
       AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL
       ${BAND}
     ${NEAR} LIMIT 1`, [SOURCE_BRANCH]);
  const unpayable = await one(`
    SELECT a.id, a.assayer_code FROM assayers a, branches b
     WHERE b.name = $1 AND a.lifecycle_status = 'ACTIVE' AND a.is_active AND a.id <> $2
       AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL
       AND (a.bank_account_number IS NULL OR a.ifsc_code IS NULL OR a.pan_number IS NULL)
       ${BAND}
     ${NEAR} LIMIT 1`, [SOURCE_BRANCH, payee?.id ?? null]);
  check('found an ACTIVE assayer to pay', !!payee, payee?.assayer_code);
  check('found an ACTIVE assayer with no payout details, to be refused', !!unpayable, unpayable?.assayer_code);
  if (!payee || !unpayable) return done();

  /**
   * The seeded project ran 1–31 July 2026 and the calendar has moved on, so every date this probe
   * could book is outside it. Widened for the run and put back at the end — recorded alongside
   * the assayer's payout columns because both are fixture surgery on rows this script did not
   * create, and both have to be undone whatever happens.
   */
  const projects = await sql(`SELECT id, start_date, end_date FROM projects`);
  await sql(`UPDATE projects SET start_date = LEAST(start_date, current_date), end_date = GREATEST(end_date, current_date + 60)`);

  const restore = { bank: payee.bank_account_number, ifsc: payee.ifsc_code, pan: payee.pan_number, projects };
  await sql(`UPDATE assayers SET bank_account_number = COALESCE(bank_account_number, '50100123456789'),
                                 ifsc_code = COALESCE(ifsc_code, 'HDFC0001234'),
                                 pan_number = COALESCE(pan_number, 'ABCDE1234F')
              WHERE id = $1`, [payee.id]);

  try {
    // ══ ACT 1 — money is born by itself ══════════════════════════════════════════════════════
    const a1 = await completedAssignment(payee.id, 'bill-road');
    check('a completed assignment books its money with nobody typing anything', !!a1.id
      && a1.p.filter((x) => x.status !== 'VOIDED').length === 1
      && a1.e.filter((x) => x.state !== 'CANCELLED').length === 1,
      a1.id ? `payables=${a1.p.length} entries=${a1.e.length}` : `could not book an assignment — ${a1.why}`);
    /**
     * `return`, never `return done()`.
     *
     * `done()` ends with `process.exit`, so calling it from inside this `try` kills the process
     * before the `finally` runs — and the finally is the teardown. An early exit here therefore
     * left three fixture branches behind AND a real assayer holding this script's placeholder
     * bank account and IFSC, which is the one write it makes to a row it did not create. Found
     * by noticing an assayer had acquired a bank account between two runs.
     */
    if (!a1.id) return;

    const fee1 = await liveFeePayable(a1.id);
    check('the payout opens as due, on no bill, not held',
      fee1.status === 'PENDING' && fee1.assayer_invoice_id === null && fee1.on_hold === false,
      `${fee1.n} ${fee1.status} ${money(fee1.total_amount)}`);

    // ══ ACT 2 — the stage model: "due" is two piles, and they must not overlap ════════════════
    const stage = async (q) => {
      const r = await get(`/billing-engine/payouts?${q}&page=1&limit=100`);
      return { status: r.status, ids: (dataOf(r)?.items ?? []).map((x) => x.id), total: dataOf(r)?.total };
    };
    const notBilled = await stage('status=PENDING&onHold=false&onBill=false');
    const withAssayer = await stage('status=PENDING&onHold=false&onBill=true');
    check('the pay screen’s stage filter is accepted, not rejected by the whitelist pipe',
      notBilled.status === 200 && withAssayer.status === 200,
      `onBill=false -> ${notBilled.status}, onBill=true -> ${withAssayer.status}`);
    check('a brand-new payout is in "not billed yet" and not in "with the assayer"',
      notBilled.ids.includes(fee1.id) && !withAssayer.ids.includes(fee1.id),
      `not-billed=${notBilled.total} with-assayer=${withAssayer.total}`);
    check('the two stages are disjoint — no payout can be in both',
      notBilled.ids.every((id) => !withAssayer.ids.includes(id)),
      `${notBilled.ids.length} + ${withAssayer.ids.length} ids, overlap ${notBilled.ids.filter((i) => withAssayer.ids.includes(i)).length}`);

    const ov1 = dataOf(await get('/billing-engine/overview'))?.payouts ?? {};
    check('the overview’s split reports the same two piles the lists return',
      ov1.unbilledCount === notBilled.total && ov1.inClaimReviewCount === withAssayer.total,
      `overview says ${ov1.unbilledCount}/${ov1.inClaimReviewCount}, lists say ${notBilled.total}/${withAssayer.total}`);
    check('the two piles add up to the total due — nothing is counted twice or lost',
      (ov1.unbilledCount ?? 0) + (ov1.inClaimReviewCount ?? 0) === ov1.dueCount,
      `${ov1.unbilledCount} + ${ov1.inClaimReviewCount} vs dueCount ${ov1.dueCount}`);

    // ══ ACT 3 — the normal road: bill, confirm, approve the bill ══════════════════════════════
    const invited = await post('/billing-engine/assayer-invoices/invite', { assayerId: payee.id });
    const bill = dataOf(invited);
    if (bill?.id) made.billIds.push(bill.id);
    check('billing the assayer creates one bill covering their unbilled work',
      invited.status === 201 || invited.status === 200,
      `${invited.status} ${bill?.invoiceNumber ?? invited.msg} lines=${bill?.lineCount}`);

    const afterInvite = await one('SELECT assayer_invoice_id, status FROM assayer_payables WHERE id = $1', [fee1.id]);
    check('the payout moves onto the bill and stays due until somebody approves it',
      afterInvite.assayer_invoice_id === bill?.id && afterInvite.status === 'PENDING',
      `invoice=${afterInvite.assayer_invoice_id ? 'set' : 'null'} status=${afterInvite.status}`);

    const nb2 = await stage('status=PENDING&onHold=false&onBill=false');
    const wa2 = await stage('status=PENDING&onHold=false&onBill=true');
    check('the stages follow the move — it leaves "not billed" and appears in "with the assayer"',
      !nb2.ids.includes(fee1.id) && wa2.ids.includes(fee1.id),
      `not-billed=${nb2.total} with-assayer=${wa2.total}`);

    // ILLEGAL: approving a payout the assayer is still being asked to confirm.
    await refusesAndLeavesUnmoved(
      'ILLEGAL approving a payout that is out for confirmation is refused, and it does not move',
      fee1.id, async () => asRefusal(await approve([fee1.id])),
      { expect: /awaiting assayer invoice|approve the invoice instead/i });

    // ILLEGAL: a second live bill for the same assayer.
    const second = await post('/billing-engine/assayer-invoices/invite', { assayerId: payee.id });
    const billCount = await one(
      `SELECT count(*)::int AS n FROM assayer_invoices WHERE assayer_id = $1 AND status IN ('INVITED','SUBMITTED')`, [payee.id]);
    check('ILLEGAL a second open bill for the same assayer is refused, and none is created',
      second.status >= 400 && billCount.n === 1,
      `${second.status} ${String(second.msg).slice(0, 120)} · open bills = ${billCount.n}`);

    // The assayer confirms. Billing staff may submit on their behalf, which is the desk-side
    // path for an assayer on the phone; the horizontal-isolation case (an assayer submitting
    // somebody ELSE's bill) is covered by authorization-and-audit.mjs.
    // Staff recording it must say why (audit F5, 2026-09-24) and are recorded as themselves.
    const submitted = await post(`/billing-engine/assayers/${payee.id}/invoice-invitation/submit`,
      { clientRequestId: crypto.randomUUID(), onBehalfReason: 'Assayer confirmed the figures by phone' });
    const billAfterSubmit = await one('SELECT status, submitted_at FROM assayer_invoices WHERE id = $1', [bill.id]);
    check('the assayer confirming the figures moves the bill to submitted',
      submitted.status === 200 && billAfterSubmit.status === 'SUBMITTED' && !!billAfterSubmit.submitted_at,
      `${submitted.status} -> ${billAfterSubmit.status}`);

    // ILLEGAL: confirming twice under a NEW request id is a second consent to the same figures.
    const resubmit = await post(`/billing-engine/assayers/${payee.id}/invoice-invitation/submit`,
      { clientRequestId: crypto.randomUUID(), onBehalfReason: 'Assayer confirmed the figures by phone' });
    check('ILLEGAL confirming an already-confirmed bill again is refused',
      resubmit.status >= 400, `${resubmit.status} ${String(resubmit.msg).slice(0, 120)}`);

    // ILLEGAL: paying a payout that has not been approved.
    await refusesAndLeavesUnmoved(
      'ILLEGAL paying a payout nobody approved is refused, and it does not become paid',
      fee1.id, async () => asRefusal(await payOut([fee1.id], { paymentReference: `${TAG}-EARLY`, method: 'NEFT' })),
      { expect: /approved|not.*approv/i });

    // LEGAL: approving the bill approves its lines, in one gesture.
    const billApproved = await post(`/billing-engine/assayer-invoices/${bill.id}/approve`, {});
    const feeAfterBill = await one('SELECT status, approved_at FROM assayer_payables WHERE id = $1', [fee1.id]);
    check('approving the bill approves every payout on it, in one act',
      billApproved.status === 200 || billApproved.status === 201,
      `${billApproved.status} ${String(billApproved.msg ?? '').slice(0, 100)}`);
    check('the payout is approved, and the approval is stamped',
      feeAfterBill.status === 'APPROVED' && !!feeAfterBill.approved_at, feeAfterBill.status);

    const consentRow = await one(
      `SELECT reason FROM billing_history WHERE entity_id = $1 AND action = 'PAYABLE_STATUS_CHANGED' ORDER BY created_at DESC LIMIT 1`,
      [fee1.id]);
    check('a payout approved through its bill carries NO exception reason — consent is the record',
      consentRow && consentRow.reason === null, `reason = ${JSON.stringify(consentRow?.reason)}`);

    // ILLEGAL: cancelling a bill whose money is already approved.
    const lateCancel = await patch(`/billing-engine/assayer-invoices/${bill.id}/cancel`, { reason: 'Changed my mind.' });
    const billNow = await one('SELECT status FROM assayer_invoices WHERE id = $1', [bill.id]);
    check('ILLEGAL cancelling an approved bill is refused, and it stays approved',
      lateCancel.status >= 400 && billNow.status === 'APPROVED',
      `${lateCancel.status} ${String(lateCancel.msg).slice(0, 120)} · bill is ${billNow.status}`);

    // ══ ACT 3b — the HOD's final approval (2026-09-24) ════════════════════════════════════════
    // ILLEGAL: the office approved it; that is not enough to pay.
    await refusesAndLeavesUnmoved(
      'ILLEGAL an office-approved payout the HOD has not approved cannot be paid',
      fee1.id, async () => asRefusal(await payOut([fee1.id], { paymentReference: `${TAG}-NO-HOD`, method: 'NEFT' })),
      { expect: /Waiting for HOD approval/ });

    const queue = dataOf(await req('/billing-engine/final-approval', { token: hodToken }));
    check('the bill appears in the HOD’s queue, with the office approver named',
      (queue?.items ?? []).some((i) => i.kind === 'ASSAYER_BILL' && i.id === bill.id && !!i.officeApprovedBy),
      `queue total=${queue?.total}`);

    const bookerSeesQueue = await req('/billing-engine/final-approval', { token: bookerToken });
    check('ILLEGAL the office (OPERATIONS) cannot open the HOD’s queue', bookerSeesQueue.status === 403, String(bookerSeesQueue.status));

    const selfFinal = await hodApprove('assayer-invoices', bill.id, () => token);
    const billSelf = await one('SELECT status, hod_approved_at FROM assayer_invoices WHERE id = $1', [bill.id]);
    check('ILLEGAL the office approver cannot also give the final approval, and nothing moves',
      selfFinal.status === 409 && /segregation of duties/i.test(JSON.stringify(selfFinal.msg ?? '')) && billSelf.status === 'APPROVED' && !billSelf.hod_approved_at,
      `${selfFinal.status} ${String(selfFinal.msg).slice(0, 120)} · bill ${billSelf.status}`);

    const opsFinal = await hodApprove('assayer-invoices', bill.id, () => bookerToken);
    check('ILLEGAL the office (OPERATIONS) cannot reach the final approval at all', opsFinal.status === 403, String(opsFinal.status));

    const finalOk = await hodApprove('assayer-invoices', bill.id);
    const billFinal = await one('SELECT status, hod_approved_by FROM assayer_invoices WHERE id = $1', [bill.id]);
    const feeFinal = await one('SELECT status, hod_approved_at FROM assayer_payables WHERE id = $1', [fee1.id]);
    check('LEGAL the HOD approves the bill: HOD_APPROVED, and every payout on it cleared for payment',
      finalOk.status === 200 && billFinal.status === 'HOD_APPROVED' && !!billFinal.hod_approved_by
      && feeFinal.status === 'APPROVED' && !!feeFinal.hod_approved_at,
      `${finalOk.status} bill ${billFinal.status} · payout ${feeFinal.status} hod=${!!feeFinal.hod_approved_at}`);

    // ══ ACT 4 — the exception road, and what it must leave behind ═════════════════════════════
    const a2 = await completedAssignment(payee.id, 'exception-road', 1800);
    check('a second completed assignment books its own money', !!a2.id
      && a2.p.filter((x) => x.status !== 'VOIDED').length === 1, a2.id ? 'booked' : 'not booked');
    if (a2.id) {
      const fee2 = await liveFeePayable(a2.id);
      const why = 'Assayer has no smartphone, or the app will not run on theirs';
      const run = await approve([fee2.id], why);
      const fee2After = await one('SELECT status FROM assayer_payables WHERE id = $1', [fee2.id]);
      check('LEGAL the desk may approve a payout the assayer never confirmed',
        fee2After.status === 'APPROVED', `${describeJobOutcome(run)} -> ${fee2After.status}`);

      const exceptionRow = await one(
        `SELECT reason FROM billing_history WHERE entity_id = $1 AND action = 'PAYABLE_STATUS_CHANGED' ORDER BY created_at DESC LIMIT 1`,
        [fee2.id]);
      check('...and WHY is on the record, which is the whole point of allowing it',
        exceptionRow?.reason === why, JSON.stringify(exceptionRow?.reason ?? null));

      const audit = await one(
        `SELECT remarks FROM audit_events WHERE entity_id = $1 AND event_type = 'PAYABLE_APPROVED' ORDER BY occurred_at DESC LIMIT 1`,
        [fee2.id]);
      check('the compliance trail says it too, not only the reconciliation history',
        /approved without assayer confirmation/i.test(audit?.remarks ?? ''),
        String(audit?.remarks ?? 'no audit row').slice(0, 150));

      // ILLEGAL: approving the same payout again must not double anything.
      const before = await payablesFor(a2.id);
      await approve([fee2.id], why);
      const after = await payablesFor(a2.id);
      check('ILLEGAL approving an already-approved payout changes nothing and creates nothing',
        before.length === after.length && after.find((x) => x.id === fee2.id).status === 'APPROVED',
        `${before.length} -> ${after.length} payables`);

      // The HOD sends it back (2026-09-24): back to Due with the reason, never cancelled.
      const shortReason = await hodReject('payouts', fee2.id, 'no');
      check('ILLEGAL the HOD cannot send a payout back without a reason', shortReason.status === 400, String(shortReason.status));
      const back = await hodReject('payouts', fee2.id, 'The assayer is still reachable by phone; bill them properly.');
      const fee2Back = await one('SELECT status, approved_by, hod_reject_reason FROM assayer_payables WHERE id = $1', [fee2.id]);
      check('LEGAL the HOD sends a payout back to the office: Due again, the office approval undone, the reason kept',
        back.status === 200 && fee2Back.status === 'PENDING' && fee2Back.approved_by === null && /reachable by phone/.test(fee2Back.hod_reject_reason ?? ''),
        `${back.status} -> ${fee2Back.status} reason=${JSON.stringify(fee2Back.hod_reject_reason)}`);
    }

    // ══ ACT 5 — holds, and paying ════════════════════════════════════════════════════════════
    const held = await patch(`/billing-engine/payouts/${fee1.id}/hold`,
      { onHold: true, reason: 'Bank details missing or incorrect' });
    check('a payout can be stopped, with a reason', held.status === 200 || held.status === 201, String(held.status));

    await refusesAndLeavesUnmoved(
      'ILLEGAL a held payout cannot be paid',
      fee1.id, async () => asRefusal(await payOut([fee1.id], { paymentReference: `${TAG}-HELD`, method: 'NEFT' })),
      { expect: /on hold/i });

    await patch(`/billing-engine/payouts/${fee1.id}/hold`, { onHold: false });
    const releasedRow = await one('SELECT on_hold FROM assayer_payables WHERE id = $1', [fee1.id]);
    check('releasing the hold lets it move again', releasedRow.on_hold === false, `on_hold=${releasedRow.on_hold}`);

    await refusesAndLeavesUnmoved(
      'ILLEGAL the account that approved a payout cannot also pay it',
      fee1.id, async () => asRefusal(await postAndAwait('/billing-engine/payouts/pay',
        { payableIds: [fee1.id], paymentReference: `${TAG}-SELF`, method: 'NEFT' },
        JOB_STATUS.billingBulk, { token: () => token })),
      { expect: /segregation of duties/i });

    const paid = await payOut([fee1.id], { paymentReference: `${TAG}-UTR-1`, method: 'NEFT', notes: 'money-workflow probe' });
    const paidRow = await one('SELECT status, total_amount, paid_amount FROM assayer_payables WHERE id = $1', [fee1.id]);
    check('LEGAL an approved payout is paid, in full, and recorded',
      paidRow.status === 'PAID' && Number(paidRow.paid_amount) === Number(paidRow.total_amount),
      `${describeJobOutcome(paid)}${paid.result?.refused?.length ? ` refused: ${paid.result.refused[0].reason}` : ''}`
      + ` -> ${paidRow.status} ${money(paidRow.paid_amount)}/${money(paidRow.total_amount)}`);

    const disb = await one(
      `SELECT count(*)::int AS n FROM billing_payments WHERE payment_reference = $1`, [`${TAG}-UTR-1`]);
    check('exactly one disbursement row exists for that bank reference', disb.n === 1, `rows=${disb.n}`);

    await refusesAndLeavesUnmoved(
      'ILLEGAL a paid payout cannot be paid a second time',
      fee1.id, async () => asRefusal(await payOut([fee1.id], { paymentReference: `${TAG}-UTR-2`, method: 'NEFT' })),
      { expect: /already|paid/i });

    await refusesAndLeavesUnmoved(
      'ILLEGAL a paid payout cannot be re-approved back down the chain',
      fee1.id, async () => asRefusal(await approve([fee1.id], 'trying to walk it backwards')),
      { expect: /already paid|paid/i });

    // ══ ACT 6 — an assayer who cannot legally be paid at all ══════════════════════════════════
    const a3 = await completedAssignment(unpayable.id, 'no-bank-details', 1500);
    if (a3.id) {
      const fee3 = await liveFeePayable(a3.id);
      if (fee3) {
        await refusesAndLeavesUnmoved(
          'ILLEGAL a payout cannot be approved for an assayer with no bank account or PAN on file',
          fee3.id, async () => asRefusal(await approve([fee3.id], 'testing the statutory gate')),
          { expect: /bank account|IFSC|PAN/i });
      } else {
        check('ILLEGAL a payout cannot be approved for an assayer with no bank account or PAN on file',
          false, 'no payable was booked for the second assayer');
      }
    }

    // ══ ACT 7 — the client side ══════════════════════════════════════════════════════════════
    const invoiceable = dataOf(await get('/billing-engine/invoiceable'));
    const clientRow = (invoiceable?.clients ?? []).find((c) => c.lines?.some((l) => l.assignmentId === a1.id));
    check('completed work appears as ready to invoice, by client',
      !!clientRow, clientRow ? `${clientRow.clientName}: ${clientRow.count} line(s)` : 'assignment not listed');

    const entry1 = (await entriesFor(a1.id)).find((e) => e.state !== 'CANCELLED');
    /**
     * Measured as a DELTA, not against zero.
     *
     * This read the whole book's `receivables` and asserted both figures were 0 — true on a clean
     * database and false the moment anything else in the system has a sent invoice. It failed
     * against a database where a walk-through had left one real settled invoice, reporting a
     * product defect that was entirely the probe's own assumption. What the rule actually says is
     * "raising a draft moves neither figure", and that is a comparison, not a constant.
     */
    const before = dataOf(await get('/billing-engine/overview'))?.receivables ?? {};
    const inv = await post('/billing-engine/invoices', {
      clientId: clientRow?.clientId, assignmentIds: [a1.id], notes: `${TAG} probe invoice`,
    });
    const invoice = dataOf(inv);
    if (invoice?.id) made.invoiceIds.push(invoice.id);
    const entryAfter = await one('SELECT state, invoice_id FROM billing_entries WHERE id = $1', [entry1.id]);
    check('LEGAL invoicing the work creates a draft and moves the line onto it',
      (inv.status === 201 || inv.status === 200) && entryAfter.state === 'INVOICED' && entryAfter.invoice_id === invoice?.id,
      `${inv.status} ${invoice?.invoiceNumber} · line ${entryAfter.state}`);

    const ovDraft = dataOf(await get('/billing-engine/overview'))?.receivables ?? {};
    check('a DRAFT invoice is owed by nobody — raising it moves neither sent nor outstanding',
      Number(ovDraft.invoiced) === Number(before.invoiced)
      && Number(ovDraft.outstanding) === Number(before.outstanding),
      `invoiced ${money(before.invoiced)}->${money(ovDraft.invoiced)}, `
      + `outstanding ${money(before.outstanding)}->${money(ovDraft.outstanding)}`);

    // ILLEGAL: collecting against a draft the client has never seen.
    const earlyPay = await post(`/billing-engine/invoices/${invoice.id}/payment`,
      { paymentReference: `${TAG}-CL-EARLY`, method: 'NEFT', amount: 100 });
    const invEarly = await one('SELECT status, paid_amount FROM billing_invoices WHERE id = $1', [invoice.id]);
    check('ILLEGAL a draft invoice cannot be paid, and takes no money',
      earlyPay.status >= 400 && Number(invEarly.paid_amount) === 0,
      `${earlyPay.status} ${String(earlyPay.msg).slice(0, 120)} · paid ${money(invEarly.paid_amount)}`);

    // The HOD's final approval of a client invoice (2026-09-24): not sent without it.
    const sendDraft = await patch(`/billing-engine/invoices/${invoice.id}/send`, {});
    const invDraft = await one('SELECT status FROM billing_invoices WHERE id = $1', [invoice.id]);
    check('ILLEGAL a draft cannot be marked sent to the client before the HOD approves it',
      sendDraft.status === 409 && /Waiting for HOD approval/.test(JSON.stringify(sendDraft.msg ?? '')) && invDraft.status === 'DRAFT',
      `${sendDraft.status} ${String(sendDraft.msg).slice(0, 100)} · ${invDraft.status}`);
    const upForFinal = await patch(`/billing-engine/invoices/${invoice.id}/request-final-approval`, {});
    const invFinal = await hodApprove('invoices', invoice.id);
    const invHod = await one('SELECT status, invoice_number FROM billing_invoices WHERE id = $1', [invoice.id]);
    check('LEGAL the office sends it up and the HOD approves it; the number does not change',
      upForFinal.status === 200 && invFinal.status === 200 && invHod.status === 'HOD_APPROVED' && invHod.invoice_number === invoice.invoiceNumber,
      `${upForFinal.status}/${invFinal.status} -> ${invHod.status} ${invHod.invoice_number}`);

    const sent = await patch(`/billing-engine/invoices/${invoice.id}/send`, {});
    const invSent = await one('SELECT status, total, outstanding_amount FROM billing_invoices WHERE id = $1', [invoice.id]);
    check('LEGAL sending the invoice is what makes it owed',
      (sent.status === 200 || sent.status === 201) && invSent.status === 'ISSUED' && Number(invSent.outstanding_amount) > 0,
      `${invSent.status} outstanding ${money(invSent.outstanding_amount)}`);

    // ILLEGAL: more money than is owed.
    const over = await post(`/billing-engine/invoices/${invoice.id}/payment`, {
      paymentReference: `${TAG}-CL-OVER`, method: 'NEFT', amount: Number(invSent.total) + 1000,
    });
    const invOver = await one('SELECT paid_amount FROM billing_invoices WHERE id = $1', [invoice.id]);
    check('ILLEGAL a payment larger than the amount outstanding is refused, and nothing is banked',
      over.status >= 400 && Number(invOver.paid_amount) === 0,
      `${over.status} ${String(over.msg).slice(0, 120)}`);

    const half = Math.max(1, Math.floor(Number(invSent.outstanding_amount) / 2));
    await post(`/billing-engine/invoices/${invoice.id}/payment`,
      { paymentReference: `${TAG}-CL-1`, method: 'NEFT', amount: half });
    const invHalf = await one('SELECT status, paid_amount, outstanding_amount FROM billing_invoices WHERE id = $1', [invoice.id]);
    check('a part payment is recorded without inventing a "part paid" status',
      invHalf.status === 'ISSUED' && Number(invHalf.paid_amount) === half && Number(invHalf.outstanding_amount) > 0,
      `${invHalf.status} paid ${money(invHalf.paid_amount)} left ${money(invHalf.outstanding_amount)}`);

    await post(`/billing-engine/invoices/${invoice.id}/payment`, {
      paymentReference: `${TAG}-CL-2`, method: 'NEFT', amount: Number(invHalf.outstanding_amount),
    });
    const invPaid = await one('SELECT status, outstanding_amount FROM billing_invoices WHERE id = $1', [invoice.id]);
    check('LEGAL settling the remainder closes the invoice',
      invPaid.status === 'PAID' && Number(invPaid.outstanding_amount) === 0,
      `${invPaid.status} outstanding ${money(invPaid.outstanding_amount)}`);

    const lateVoid = await patch(`/billing-engine/invoices/${invoice.id}/cancel`, { reason: 'Trying to void a settled invoice.' });
    const invVoid = await one('SELECT status FROM billing_invoices WHERE id = $1', [invoice.id]);
    check('ILLEGAL a paid invoice cannot be cancelled out from under the payment',
      lateVoid.status >= 400 && invVoid.status === 'PAID',
      `${lateVoid.status} ${String(lateVoid.msg).slice(0, 120)} · invoice is ${invVoid.status}`);

    // ══ ACT 8 — who may do this at all ═══════════════════════════════════════════════════════

    /**
     * The separation this whole script is arranged around, asserted once and on purpose.
     *
     * The account that booked and completed the work may not also release its money, whatever
     * role it holds — `manager` is OPERATIONS and is otherwise on the disbursement path. This is
     * the control that made the first version of this probe fail fourteen checks, which is a
     * fair reason to prove it deliberately rather than trip over it.
     */
    const a4 = await completedAssignment(payee.id, 'duties', 1600);
    if (a4.id) {
      const fee4 = await liveFeePayable(a4.id);
      if (fee4) {
        const before = await one('SELECT status FROM assayer_payables WHERE id = $1', [fee4.id]);
        const sod = await postAndAwait('/billing-engine/payouts/approve', { payableIds: [fee4.id], reason: 'Assayer confirmed the amounts by phone or in person' },
          JOB_STATUS.billingBulk, { token: () => bookerToken });
        const after = await one('SELECT status FROM assayer_payables WHERE id = $1', [fee4.id]);
        const said = sod.result?.refused?.[0]?.reason ?? describeJobOutcome(sod);
        check('ILLEGAL the account that booked the work cannot also approve its payout',
          /segregation of duties/i.test(said) && before.status === after.status && after.status === 'PENDING',
          `${said.slice(0, 140)} · ${before.status}->${after.status}`);

        // ...and the separation is the ONLY thing stopping it: a different account may.
        const ok = await approve([fee4.id], 'Assayer confirmed the amounts by phone or in person');
        const a4After = await one('SELECT status FROM assayer_payables WHERE id = $1', [fee4.id]);
        check('LEGAL a different account approves the very same payout',
          a4After.status === 'APPROVED', `${describeJobOutcome(ok)} -> ${a4After.status}`);
      }
    }

    const weak = await login('validator', env.AC_VALIDATOR_PASSWORD ?? env.AC_PASSWORD);
    if (weak?.token) {
      const target = a2.id ? await liveFeePayable(a2.id) : null;
      if (target) {
        const before = await one('SELECT status FROM assayer_payables WHERE id = $1', [target.id]);
        const r = await req('/billing-engine/payouts/approve',
          { method: 'POST', token: weak.token, body: { payableIds: [target.id], reason: 'Assayer confirmed the amounts by phone or in person' } });
        const after = await one('SELECT status FROM assayer_payables WHERE id = $1', [target.id]);
        check('ILLEGAL a role off the disbursement path cannot approve money, and nothing queues',
          r.status === 403 && before.status === after.status,
          `${r.status} ${String(r.msg).slice(0, 100)} · ${before.status}->${after.status}`);
      }
      const rd = await req('/billing-engine/overview', { token: weak.token });
      check('...and is told so plainly rather than shown an empty book',
        rd.status === 403 || rd.status === 200,
        `overview -> ${rd.status}`);
    } else {
      check('ILLEGAL a role off the disbursement path cannot approve money', false,
        'could not sign in as validator — set AC_VALIDATOR_PASSWORD');
    }

    // ══ ACT 9 — the repair tool must be safe to press twice ══════════════════════════════════
    const pv = dataOf(await get('/billing-engine/reconcile/preview'));
    const beforeCounts = await one(
      `SELECT (SELECT count(*) FROM assayer_payables)::int AS p, (SELECT count(*) FROM billing_entries)::int AS e`);
    const rec = await postAndAwait('/billing-engine/reconcile', {}, JOB_STATUS.billingBulk, { token: () => token })
      .catch(() => null);
    const recResult = rec?.result ?? null;
    const afterCounts = await one(
      `SELECT (SELECT count(*) FROM assayer_payables)::int AS p, (SELECT count(*) FROM billing_entries)::int AS e`);
    check('repair books only what is missing — it never doubles a booking that is already there',
      afterCounts.p - beforeCounts.p === (recResult?.booked ?? 0)
      && afterCounts.e - beforeCounts.e === (recResult?.booked ?? 0),
      `preview said ${pv?.count}; booked ${recResult?.booked ?? '?'}; payables ${beforeCounts.p}->${afterCounts.p}, entries ${beforeCounts.e}->${afterCounts.e}`);
  } finally {
    // Runs on every path out of the block above — the early return, a thrown error, or the end.
    await teardown(restore, payee.id);
  }

  await done();
};

/** Put the fixture back. Ordered by foreign key, deepest first. */
async function teardown(restore, payeeId) {
  const ids = made.assignmentIds;
  try {
    if (ids.length) {
      await sql(`DELETE FROM billing_payments WHERE payable_id IN (SELECT id FROM assayer_payables WHERE assignment_id = ANY($1::uuid[]))`, [ids]);
      await sql(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::uuid[])`, [made.invoiceIds.length ? made.invoiceIds : [null]]);
      await sql(`DELETE FROM billing_history WHERE assignment_id = ANY($1::uuid[])`, [ids]);
      await sql(`DELETE FROM billing_entries WHERE assignment_id = ANY($1::uuid[])`, [ids]);
      if (made.invoiceIds.length) await sql(`DELETE FROM billing_invoices WHERE id = ANY($1::uuid[])`, [made.invoiceIds]);
      await sql(`DELETE FROM assayer_payables WHERE assignment_id = ANY($1::uuid[])`, [ids]);
      if (made.billIds.length) await sql(`DELETE FROM assayer_invoices WHERE id = ANY($1::uuid[])`, [made.billIds]);
      await sql(`DELETE FROM assignments WHERE id = ANY($1::uuid[])`, [ids]);
    }
    if (made.pbIds.length) await sql(`DELETE FROM project_branches WHERE id = ANY($1::uuid[])`, [made.pbIds]);
    if (made.branchIds.length) await sql(`DELETE FROM branches WHERE id = ANY($1::uuid[])`, [made.branchIds]);
    await sql(`UPDATE assayers SET bank_account_number = $2, ifsc_code = $3, pan_number = $4 WHERE id = $1`,
      [payeeId, restore.bank, restore.ifsc, restore.pan]);
    for (const pr of restore.projects ?? []) {
      await sql(`UPDATE projects SET start_date = $2, end_date = $3 WHERE id = $1`, [pr.id, pr.start_date, pr.end_date]);
    }
    console.log(`\ncleaned up: ${ids.length} assignment(s), ${made.branchIds.length} branch(es), ${made.invoiceIds.length} invoice(s)`);
  } catch (e) {
    console.log(`\nTEARDOWN INCOMPLETE — fixture rows may remain, tagged ${TAG}: ${e.message}`);
  }
}

main().catch(async (e) => { console.error(e); await done(); });
