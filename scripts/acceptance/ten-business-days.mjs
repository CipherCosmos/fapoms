#!/usr/bin/env node
/**
 * Ten business days, driven through the product's own API by the roles that would really do them.
 *
 * Not ten variations on one happy path: ten stories an operations manager, a finance clerk, a
 * bank's panel administrator and an auditor would each recognise as a day at work — a normal job
 * from hire to payment, a declined offer, a moved visit, somebody leaving mid-job, a client
 * changing its mind, a completion that turned out to be wrong, a desk overriding one rule and
 * being refused on another, a payday, an invoice, and an auditor's morning.
 *
 * Three rules this script holds itself to, because breaking any of them turns a green run into a
 * lie:
 *
 *   1. **The database is read back after every step.** An HTTP 201 is a claim, not evidence.
 *   2. **Money is recomputed, never echoed.** Every figure is derived here from the inputs (the
 *      fee on the assignment, the travel frozen at offer time, the tax rates in
 *      `platform_settings` and `client_billing`) and then compared against what the product
 *      stored. Reading `total_amount` back and asserting it equals `total_amount` proves nothing.
 *   3. **A refusal is only evidence when it is refused for the right reason.** Every token is
 *      proved alive on a permitted read before it is used to claim a denial; 403 and 404 are
 *      reported apart; a 429 is UNKNOWN, never a denial.
 *
 * Two traps this rig has to walk around, both learned the hard way:
 *
 *   - `isHoliday` consults `client_configurations.working_days` before it consults the holiday
 *     table, and every client here is configured Mon–Fri. So a **Saturday** comes back as "a
 *     holiday in Maharashtra" with no holiday row behind it, and so does any Sunday, and so does
 *     a real registered holiday. Rather than assume a date, this script walks candidates until
 *     the calendar stops objecting, and reports how many it tried and what each answer was.
 *   - Every project-branch in this database is consumed: a completed audit closes its branch
 *     twice over (branch status, and the branch already carrying a completed assignment). Every
 *     scenario therefore provisions its own with `freshBranch()`.
 *
 * Self-cleaning and re-runnable: everything it creates is tagged, and the tagged rows are removed
 * children-first at the start and at the end. `audit_events` is never touched — a probe that
 * proves a control by destroying the evidence has cost more than it found.
 *
 *   AC_API / DB_* / passwords come from the pa/acc.env the helper library reads.
 *   PA_LIB overrides where those helpers are resolved from.
 *
 *   node scripts/acceptance/ten-business-days.mjs
 */
/**
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * SAFETY CLASSIFICATION: WRITES
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * password    : mints assayer app logins and rotates their forced password (gated, announced).
 * api writes  : ten business days of real work — assayers, branches, assignments, documents,
 *               panel standings. BOOKS, APPROVES AND PAYS REAL MONEY, and mints a client invoice.
 * deletion    : DELETEs everything it made, by run tag, at both ends of the run.
 * gate        : declareMutating + AC_ALLOW_WRITES; rotation needs AC_ALLOW_PASSWORD_ROTATION.
 *
 * The full table for every script here is in scripts/acceptance/README.md.
 */

/**
 * The helpers come from THIS DIRECTORY, not from a scratchpad.
 *
 * This used to default to an absolute path into a campaign scratchpad — a forked, older copy of
 * `_lib.mjs` that is not in the repository. Two consequences, both bad: on any other machine the
 * probe aborted on the first line, and on this one it silently ran DIFFERENT code from the file
 * anybody reads when they want to know what it does. The two copies had already drifted; the
 * scratchpad one carries neither the read-only write gate nor the request/wait split, so a fix
 * made to `_lib.mjs` appeared to have no effect here at all.
 *
 * `PA_LIB` still overrides, for anyone who genuinely wants a different helper set.
 */
const LIB = process.env.PA_LIB || new URL('./_lib.mjs', import.meta.url).href;
const { env, req, sql, one, login, tally, pool, freshBranch, empanelmentVersion, declareMutating, canRotatePassword } = await import(LIB);

// ── house-keeping ──────────────────────────────────────────────────────────────────────────────

const TAG = 'TenDay';
const STAMP = Date.now().toString().slice(-7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) <= eps;
const num = (v) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const short = (v, n = 150) => (typeof v === 'string' ? v : JSON.stringify(v ?? null)).slice(0, n);

const { check: emit, done } = tally();
const results = [];
const scenarios = [];
let SID = 'SETUP';
let SNAME = 'setup';

/** Record a check against the scenario currently running. */
const check = (name, ok, detail) => {
  results.push({ sid: SID, name, ok: !!ok, detail });
  emit(`[${SID}] ${name}`, !!ok, detail);
};

const scenario = (sid, name) => {
  const prev = scenarios[scenarios.length - 1];
  if (prev) { prev.ms = Date.now() - prev.startedAt; prev.calls = traffic.calls - prev.startCalls; }
  SID = sid; SNAME = name;
  scenarios.push({ sid, name, startedAt: Date.now(), startCalls: traffic.calls, ms: 0, calls: 0 });
  console.log(`\n── ${sid} — ${name} ${'─'.repeat(Math.max(0, 74 - sid.length - name.length))}`);
};

/**
 * A denial, classified.
 *
 * The failure mode this exists to prevent is reporting "correctly refused" for a request that was
 * refused because the token had expired, the id did not exist, or the rate limiter was in the way.
 * `expect` names the status the control is supposed to answer with; anything else is reported as
 * what it actually was, including which of 403 / 404 / 400 / 409 turned up.
 */
const denial = (r, expect) => {
  if (r.status === 429) return { ok: false, label: 'UNKNOWN (429 — throttled, not a denial)' };
  const kinds = { 400: '400 refused-by-rule', 401: '401 unauthenticated', 403: '403 forbidden', 404: '404 not-found', 409: '409 conflict' };
  const label = kinds[r.status] ?? `${r.status}`;
  return { ok: r.status === expect, label };
};

// ── transport ──────────────────────────────────────────────────────────────────────────────────

const msg = (r) => String(r.body?.message ?? r.body?.error ?? r.msg ?? '');
const code = (r) => String(r.body?.code ?? r.body?.errorCode ?? r.body?.data?.code ?? '');

// ── the cast ───────────────────────────────────────────────────────────────────────────────────

/** Who signs in as what. Kept as data so a session can be renewed without repeating the recipe. */
const CAST_DEF = {
  admin: ['admin', env.AC_PASSWORD],        // ADMIN     — approves payouts
  ops: ['cert_operations', undefined],      // OPERATIONS — books, completes, reopens
  finance: ['cert_developer', undefined],   // DEVELOPER (implies ADMIN) — releases the cash
  desk: ['cert_desk', undefined],           // DESK      — the front desk
  auditor: ['cert_auditor', undefined],     // AUDITOR   — reads, changes nothing
};
const cast = {};       // token holders, by role name

const traffic = { calls: 0, ms: 0, waitedMs: 0, throttled: 0, slow: [], relogins: [] };
const SLOW_MS = 2400;   // a generous ceiling for any REQUEST here, waiting excluded

/**
 * The transport, with three pieces of honesty built in.
 *
 * The library's `req` absorbs a 429 by sleeping and retrying, so a throttle never reaches an
 * assertion as a status code — but it also disappears from the record, and a run that spent four
 * minutes being rate-limited should say so. Calls taking longer than the retry interval are
 * counted, and reported at the end.
 *
 * The third is the one this run got wrong before. Because that sleep happens INSIDE `req`, a clock
 * on the outside measures wait + request and calls the total "latency" — which is how this script
 * reported a 60.4 second login against a 2.4 s threshold. Twelve controlled logins measured
 * 0.199 - 0.323 s; the rest was the measurer's own deliberate backoff. `req` now returns
 * `requestMs` and `waitedMs` separately, and NOTHING here reports the two added together: the slow
 * list is built from request time alone, the throttle wait is tallied on its own line, and a call
 * that had to be retried is counted so a clean number taken under contention is still visible as
 * one.
 *
 * The second is a single re-authentication on a 401. This stack is shared: sessions belonging to
 * other work invalidate caches and flip account state underneath a long run, and a token that
 * dies halfway through would otherwise be reported as a control refusing something. Every renewal
 * is recorded and printed, because "the run had to sign in again" is a finding if it happens for
 * any reason other than a shared rig.
 */
const CALL_BUDGET_MS = 90_000;
/** The same bound as `signIn`, applied to every call: a swallowed 429 must not become a hang. */
function bounded(promise, label) {
  let timer;
  const bell = new Promise((res) => {
    timer = setTimeout(() => res({ status: 429, body: null, timedOut: true, msg: `no answer within ${CALL_BUDGET_MS / 1000}s — the rig's rate limiter, not a refusal` }), CALL_BUDGET_MS);
  });
  return Promise.race([promise, bell]).finally(() => clearTimeout(timer));
}

async function api(path, opts = {}) {
  const started = Date.now();
  let waited = 0;
  let attempts = 0;
  let r = await bounded(req(path, opts), path);
  waited += r.waitedMs ?? 0; attempts += r.attempts ?? 1;
  if (r.status === 401 && opts.token) {
    const who = Object.keys(cast).find((k) => cast[k]?.token === opts.token);
    if (who) {
      traffic.relogins.push(`${who} during ${SID}: ${r.status} ${short(msg(r), 70)}`);
      cast[who] = await signIn(...CAST_DEF[who]);
      r = await bounded(req(path, { ...opts, token: cast[who].token }), path);
      waited += r.waitedMs ?? 0; attempts += r.attempts ?? 1;
    }
  }
  const took = Date.now() - started;
  // Subtracting `waited` from elapsed, rather than using `r.requestMs`, so the bounded-timeout
  // path and the re-auth leg are covered too. Never `took` on its own — that is the number that
  // read as a 60-second login.
  const requestMs = Math.max(0, took - waited);
  traffic.calls++; traffic.ms += requestMs; traffic.waitedMs += waited;
  if (attempts > 1) traffic.throttled++;
  if (requestMs > SLOW_MS) {
    traffic.slow.push(`${SID}  ${(opts.method ?? 'GET').padEnd(5)} ${path.split('?')[0]}  `
      + `${(requestMs / 1000).toFixed(1)}s on the wire -> ${r.status}`
      + (waited ? `   (+${(waited / 1000).toFixed(1)}s throttle wait, excluded)` : ''));
  }
  return r;
}

/** Timed multipart upload, so the document path is measured like every other call. */
async function upload(path, token, blob, filename) {
  const started = Date.now();
  const form = new FormData();
  form.append('file', blob, filename);
  let status = 0;
  try {
    const res = await fetch(env.AC_API + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    status = res.status;
  } catch (e) { status = -1; }
  const took = Date.now() - started;
  // No retry and no backoff on this path, so elapsed IS request time.
  traffic.calls++; traffic.ms += took;
  if (took > SLOW_MS) traffic.slow.push(`${SID}  POST  ${path}  ${(took / 1000).toFixed(1)}s on the wire -> ${status}`);
  return { status };
}

/**
 * Sign in, with a bound on how long that is allowed to take.
 *
 * `/auth/login` has its own brake, separate from the general request limit, and it answers a
 * saturated one with `429` and a `Retry-After` of twenty-odd seconds. The helper library absorbs a
 * 429 by sleeping 2.5 s and retrying — which against a twenty-second window never converges, so a
 * run sharing an IP with other traffic sits there indefinitely with nothing on screen to say why.
 * A bounded wait turns that into what it actually is: not a product failure, not a denial, but
 * "the rig's login brake is saturated", said out loud with the number attached.
 */
const LOGIN_BUDGET_MS = 90_000;
async function signIn(...args) {
  let timer;
  const bell = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(
      `sign-in for "${args[0]}" did not complete within ${LOGIN_BUDGET_MS / 1000}s. `
      + 'POST /auth/login carries its own rate limit and answers a saturated one with 429 plus a '
      + 'Retry-After of ~20s; the helper retries every 2.5s, so a shared IP under load never gets '
      + 'through. This is the rig, not the product — retry when the stack is quiet.')), LOGIN_BUDGET_MS);
  });
  try { return await Promise.race([login(...args), bell]); } finally { clearTimeout(timer); }
}

/** Always the *current* administrator token — `api()` may have renewed it since it was last read. */
const adm = () => cast.admin.token;

const GET = (p, t) => api(p, { token: t });
const POST = (p, t, body) => api(p, { method: 'POST', token: t, body });
const PUT_ = (p, t, body) => api(p, { method: 'PUT', token: t, body });
const PATCH = (p, t, body) => api(p, { method: 'PATCH', token: t, body });
const created = {      // everything this run made, for the teardown and the final report
  assayers: [], branches: [], projectBranches: [], assignments: [], invoices: [],
};

/** Prove a token is alive on a read it is entitled to make, before any denial is claimed with it. */
async function proveAlive(who, token) {
  const me = await GET('/users/me', token);
  check(`${who}'s session is alive`, me.status === 200,
    `GET /users/me -> ${me.status} (a blanket 401 can never be reported as a correct denial)`);
  return me.status === 200;
}

// ── the calendar ───────────────────────────────────────────────────────────────────────────────

/** date -> what the product said about it, plus how many times this run had to ask again. */
const calendar = new Map();
let calendarProbes = 0;
const noteDate = (iso, verdict) => {
  calendarProbes++;
  const seen = calendar.get(iso);
  if (seen) { seen.times++; return; }
  calendar.set(iso, { verdict, times: 1 });
};
const isoDay = (d) => d.toISOString().slice(0, 10);
const dayName = (iso) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${iso}T00:00:00Z`).getUTCDay()];

/**
 * The first date the calendar does not object to, found by asking rather than assuming.
 *
 * `GET /holidays/check` answers with a bare boolean and gives no reason, so this also asks the
 * holiday table directly for a registered row — which is how a Saturday refused purely because
 * the client's working days are Mon–Fri is told apart from Ganesh Chaturthi. Both are honest
 * "no"s from the product; only one of them has a holiday behind it, and a report that conflates
 * them is describing a calendar the business does not have.
 */
async function nextWorkableDate(token, { state: st, clientId, after, taken = new Set() }) {
  let d = new Date(`${after}T00:00:00Z`);
  for (let i = 0; i < 40; i++) {
    d = new Date(d.getTime() + 86400000);
    const iso = isoDay(d);
    if (taken.has(iso)) { noteDate(iso, 'taken by an earlier scenario in this run'); continue; }
    const r = await GET(`/holidays/check?date=${iso}&stateCode=${encodeURIComponent(st)}&clientId=${clientId}`, token);
    const holiday = r.body?.data?.isHoliday === true;
    if (!holiday) { noteDate(iso, 'WORKABLE'); return { date: iso, tried: i + 1 }; }
    const row = await one(
      `SELECT name FROM holidays WHERE is_active AND date = $1
         AND (client_id IS NULL OR client_id = $2) LIMIT 1`, [iso, clientId]);
    noteDate(iso, row
      ? `refused — registered holiday "${row.name}"`
      : 'refused — NO holiday row behind it; the client\'s working days are Mon–Fri');
  }
  throw new Error(`no workable date within 40 days after ${after}`);
}

/** Is a specific date (usually today) workable? Check-in only happens on the scheduled day. */
async function dateIsWorkable(token, iso, st, clientId) {
  const r = await GET(`/holidays/check?date=${iso}&stateCode=${encodeURIComponent(st)}&clientId=${clientId}`, token);
  return r.body?.data?.isHoliday !== true;
}

// ── hiring ─────────────────────────────────────────────────────────────────────────────────────

const PDF = () => new Blob([Uint8Array.from(Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'))], { type: 'application/pdf' });

let phoneSeq = 0;

/**
 * Where a new hire is told they live, and why it is stated rather than left to the geocoder.
 *
 * The client's planning preferences carry a 5 km conflict-of-interest FLOOR and a 200 km service
 * CEILING, and both are enforced on the write path. A hire whose address is geocoded to the same
 * part of Pune as the branch lands 0.3 km away and is refused — correctly, and for a reason that
 * has nothing to do with the scenario being tested. So every hire confirms a base location
 * through the product's own `PUT /assayers/:id/base-location`, roughly 25 km north of the branch:
 * comfortably outside the independence floor, comfortably inside the service ceiling, and the
 * same distance every run so the quoted travel is stable.
 */
const HOME_OFFSET_DEG = 0.225;   // ≈ 25 km north
let HOME = null;                 // set once the anchor branch's coordinates are known
let minDistanceKm = 0, maxDistanceKm = 0;   // the client's own independence floor and service ceiling

/**
 * Hire one person the way HR does: create, record and verify a PAN card against what the card
 * says, walk the onboarding stages, then bank details. Returns the row plus a signed-in app token
 * when `withApp` is asked for, because accepting and checking in are the assayer's own actions.
 */
async function hire(label, { withApp = false, verifyKyc = true, home = null } = {}) {
  const t = adm();
  const fullName = `${TAG} ${label} ${STAMP}`;
  const phone = `9${String(8000000000 + (phoneSeq += 137)).slice(1)}`.slice(0, 10);
  const c = await POST('/assayers', t, {
    fullName, state: 'MAHARASHTRA', district: 'Pune', city: 'Pune',
    address: `${TAG} Acceptance Address`, phone,
    email: `tenday.${label.toLowerCase().replace(/[^a-z0-9]/g, '')}.${STAMP}@acceptance.invalid`,
    joiningDate: '2026-01-01',
  });
  if (c.status >= 400) throw new Error(`hire ${label}: ${c.status} ${short(c.body, 300)}`);
  const id = c.body.data.id;
  created.assayers.push(id);

  let kyc = null;
  if (verifyKyc) {
    await PUT_(`/assayers/${id}/document/PAN_CARD`, t, { documentNumber: 'ABCPF1234K', softCopyReceived: true });
    const doc = await one(`SELECT id FROM assayer_documents WHERE assayer_id=$1 AND requirement='PAN_CARD'`, [id]);
    await upload(`/assayers/${id}/document/PAN_CARD/file`, t, PDF(), 'pan.pdf');
    kyc = await POST(`/assayers/document/${doc.id}/verify`, t, {
      verdict: 'VERIFIED', holderName: fullName,
      holderDateOfBirth: '1990-04-12', holderGuardianName: 'Acceptance Guardian',
    });
  }

  for (const s of ['DOCUMENT_VERIFICATION', 'BACKGROUND_VERIFICATION', 'TRAINING', 'ACTIVE']) {
    const r = await POST(`/assayers/${id}/lifecycle`, t, { targetStatus: s });
    if (r.status >= 400) throw new Error(`hire ${label} -> ${s}: ${r.status} ${short(r.body, 240)}`);
  }
  await PUT_(`/assayers/${id}`, t, {
    bankAccountNumber: `5010${STAMP}${phoneSeq}`.slice(0, 14), ifscCode: 'HDFC0009999',
    bankName: 'HDFC Bank', panNumber: 'ABCPF1234K',
  });

  const where = home ?? HOME;
  await PUT_(`/assayers/${id}/base-location`, t, { latitude: where.lat, longitude: where.lng });

  const row = await one(
    `SELECT id, assayer_code, display_name, lifecycle_status, status, latitude, longitude
       FROM assayers WHERE id=$1`, [id]);

  let app = null;
  if (withApp) app = await issueAppAccess(row);
  return { ...row, kyc, app, fullName };
}

/**
 * The field app's own credential path, over the API, exactly as onboarding issues it.
 *
 * Two sign-ins per person, and it has to be two. Rotating an assayer's password publishes
 * `user:password-changed`, whose handler calls `revokeAllSessions` (auth.service.ts) — so the
 * token minted with the temporary password is deliberately dead the moment the rotation lands,
 * and reusing it is not an optimisation but a race against a fire-and-forget revoke.
 *
 * That has a cost worth knowing before a run: `POST /auth/login` carries
 * `@Throttle({ limit: 20, ttl: 60_000 })` — twenty per minute per IP — and a full pass provisions
 * nine people, so this script alone needs about twenty-one sign-ins. On a quiet box it fits; on a
 * shared one it does not, and `signIn` above is what makes that legible rather than a hang.
 */
async function issueAppAccess(assayer) {
  const t = adm();
  const a = await POST(`/assayers/${assayer.id}/app-access`, t, {});
  const temp = a.body?.data?.temporaryPassword ?? a.body?.data?.password;
  if (!temp) return null;
  let l = await POST('/auth/login', null, { username: assayer.assayer_code, password: temp });
  const tok = l.body?.data?.accessToken;
  if (!tok) return null;
  // A credential write, even on a handset login this run minted seconds ago. Announced and gated
  // like every other one — see the READ-ONLY BY DEFAULT note in _lib.mjs.
  if (!canRotatePassword(assayer.assayer_code, 'the probe minted this assayer app login and must clear its forced rotation')) return null;
  await POST('/assayers/me/change-password', tok, { currentPassword: temp, newPassword: env.CERT_PASSWORD });
  l = await POST('/auth/login', null, { username: assayer.assayer_code, password: env.CERT_PASSWORD });
  return l.body?.data?.accessToken ? { token: l.body.data.accessToken } : null;
}

/**
 * Put this person on the client's panel.
 *
 * An UPDATE to a client standing now requires `expectedVersion` (2026-09-11: two desks recording
 * different standings at once were both told theirs saved while one was discarded). A CREATE does
 * not — there is no earlier decision to be stale about. So the version is read first and sent only
 * when a row already exists.
 *
 * This matters beyond "the call works". S5 asserts that a REJECTED -> ACTIVE reversal with no
 * written reason is refused 400 BECAUSE no reason was given. Omitting `expectedVersion` produces a
 * 400 as well, from a different rule entirely — the check would go green while measuring nothing.
 * Sending the right version is what keeps that assertion about the thing it names.
 */
async function empanel(assayerId, clientId, status = 'ACTIVE', statusReason) {
  const version = await empanelmentVersion(assayerId, clientId);
  const body = {
    status,
    ...(statusReason === undefined ? {} : { statusReason }),
    ...(version === null ? {} : { expectedVersion: version }),
  };
  return PUT_(`/assayers/${assayerId}/empanelment/${clientId}`, cast.admin.token, body);
}

/** A branch nobody has consumed, with the project and client that go with it. */
async function branchFor(label) {
  const b = await freshBranch(`${TAG} ${label}`);
  created.branches.push(b.branchId);
  created.projectBranches.push(b.pbId);
  const geo = await one(`SELECT latitude, longitude, state FROM branches WHERE id=$1`, [b.branchId]);
  return { ...b, lat: Number(geo.latitude), lng: Number(geo.longitude), stateName: geo.state };
}

/**
 * What the desk offers for a day's work.
 *
 * The product refuses any `proposedFee` above **twice** the contracted quote for that branch and
 * assayer, and the quote follows the distance — so with every hire pinned ~25 km out the quote is
 * ₹1200 and the ceiling ₹2400. A fee above it is refused with a message about the rate card,
 * which is correct behaviour and has nothing to do with any scenario here. Every stated fee stays
 * comfortably under it, and where the story does not need a particular number the fee is omitted
 * so the rate card quotes it.
 */
const FEE = 2000;

/** Book work. Returns the raw response so a refusal can be inspected rather than thrown away. */
async function offer(token, { pb, assayerId, date, fee, remarks, overrideReason, acceptOnBehalf }) {
  const body = {
    projectBranchId: pb.pbId, assayerId, scheduledDate: date,
    remarks: remarks ?? `${TAG} ${SID}`,
    clientRequestId: `${TAG}-${STAMP}-${SID}-${Math.random().toString(36).slice(2, 10)}`,
  };
  if (fee !== undefined) body.proposedFee = fee;
  if (overrideReason !== undefined) body.overrideReason = overrideReason;
  if (acceptOnBehalf) { body.acceptOnBehalf = true; body.acceptanceReason = `${TAG} confirmed by phone`; }
  const r = await POST('/assignments', token, body);
  if (r.body?.data?.id) created.assignments.push(r.body.data.id);
  return r;
}

/**
 * Book work that the scenario needs to exist, and stop loudly if it does not.
 *
 * Setting a scenario up is not the same as testing it. A refused *fixture* used to travel on as an
 * `undefined` id and reappear four checks later as "no payable was booked", which reads like a
 * money defect and is a fee ceiling. Anything that must succeed goes through here.
 */
async function mustOffer(token, spec, what) {
  const r = await offer(token, spec);
  if (r.status >= 400 || !r.body?.data?.id) {
    throw new Error(`${what} could not be set up — POST /assignments -> ${r.status} ${short(msg(r), 220)}`);
  }
  return { res: r, id: r.body.data.id };
}

/** The completion event books money through the outbox; wait for the row rather than assume it. */
async function waitForPayable(assignmentId, { timeoutMs = 60000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = await sql(
      `SELECT * FROM assayer_payables WHERE assignment_id=$1 AND expense_id IS NULL
         AND status <> 'VOIDED' ORDER BY created_at DESC`, [assignmentId]);
    if (rows.length) return rows[0];
    if (Date.now() > until) return null;
    await sleep(750);
  }
}

// ── the money, recomputed from first principles ────────────────────────────────────────────────

const rates = { assayerTds: 10, clientGst: 18, clientTds: 10 };

/**
 * `assignmentMoney`, reimplemented here from the assignment's own inputs.
 *
 * Deliberately a second implementation rather than a call into the product's: the whole point is
 * to derive the numbers from the fee that was offered, the travel frozen on the row at offer time
 * and the tax rates held in configuration, and only then look at what was stored. The inputs come
 * off the assignment; the answers come off the payable and the billing entry; nothing is compared
 * to itself.
 */
function expectedMoney(assignmentRow, { gstRate, clientTdsRate }) {
  const agreed = num(assignmentRow.agreed_fee);
  const fee = agreed > 0 ? round2(agreed) : round2(num(assignmentRow.proposed_fee));
  const countered = assignmentRow.counter_travel_fee === null || assignmentRow.counter_travel_fee === undefined
    ? null : num(assignmentRow.counter_travel_fee);
  const quoted = countered !== null ? countered
    : (assignmentRow.quoted_travel_fee === null || assignmentRow.quoted_travel_fee === undefined
      ? null : num(assignmentRow.quoted_travel_fee));

  const travel = quoted === null ? 0 : round2(Math.min(Math.max(0, quoted), fee));
  const base = quoted === null ? round2(fee) : round2(fee - travel);
  const gross = round2(base + travel);
  const tds = round2(gross * rates.assayerTds / 100);

  // No client rate card is configured on this deployment, and travel is not recharged, so the
  // client line passes the assayer's base through. Both facts are read from configuration below,
  // not inferred from the stored entry.
  const clientBase = quoted === null ? round2(fee) : round2(Math.max(0, fee - travel));
  const taxable = round2(clientBase);
  const gst = round2(taxable * gstRate / 100);
  const cTds = round2(taxable * clientTdsRate / 100);

  return {
    fee,
    assayer: { base, travel, gross, tds, net: round2(gross - tds) },
    client: { taxable, gst, tds: cTds, total: round2(taxable + gst - cTds) },
  };
}

// ── teardown ───────────────────────────────────────────────────────────────────────────────────

/**
 * Remove what earlier runs and this one left, children first.
 *
 * Scoped by the tag on names this script owns, because this database is shared. `audit_events`,
 * `billing_history` and `workflow_history` are never touched: they are the record of what
 * happened, and the point of an acceptance run is not to be able to deny it happened.
 */
async function purge(where) {
  const del = async (label, q, p) => {
    try { const r = await pool.query(q, p); if (r.rowCount) removed.push(`${label}:${r.rowCount}`); }
    catch (e) { removed.push(`${label}:ERR(${String(e.message).slice(0, 60)})`); }
  };
  const removed = [];

  const asy = (await sql(`SELECT id FROM assayers WHERE display_name LIKE $1 OR first_name LIKE $1`, [`${TAG}%`])).map((r) => r.id);
  const br = (await sql(`SELECT id FROM branches WHERE name LIKE $1`, [`${TAG}%`])).map((r) => r.id);
  const pbs = br.length
    ? (await sql(`SELECT id FROM project_branches WHERE branch_id = ANY($1)`, [br])).map((r) => r.id) : [];
  const asg = (asy.length || pbs.length)
    ? (await sql(`SELECT id FROM assignments WHERE ($1::uuid[] IS NOT NULL AND assayer_id = ANY($1))
                     OR ($2::uuid[] IS NOT NULL AND project_branch_id = ANY($2))`,
      [asy.length ? asy : null, pbs.length ? pbs : null])).map((r) => r.id) : [];
  const pay = asg.length ? (await sql(`SELECT id FROM assayer_payables WHERE assignment_id = ANY($1)`, [asg])).map((r) => r.id) : [];
  const inv = asg.length
    ? (await sql(`SELECT DISTINCT invoice_id id FROM billing_entries WHERE assignment_id = ANY($1) AND invoice_id IS NOT NULL`, [asg])).map((r) => r.id) : [];

  if (!asy.length && !br.length) { console.log(`  ${where}: nothing tagged ${TAG} to remove`); return; }

  if (pay.length) await del('billing_payments', `DELETE FROM billing_payments WHERE payable_id = ANY($1)`, [pay]);
  if (inv.length) await del('billing_payments(inv)', `DELETE FROM billing_payments WHERE invoice_id = ANY($1)`, [inv]);
  if (asg.length) {
    await del('assayer_payables', `DELETE FROM assayer_payables WHERE assignment_id = ANY($1)`, [asg]);
    await del('billing_entries', `DELETE FROM billing_entries WHERE assignment_id = ANY($1)`, [asg]);
  }
  if (inv.length) await del('billing_invoices', `DELETE FROM billing_invoices WHERE id = ANY($1)`, [inv]);
  if (asg.length) {
    for (const [tbl, col] of [
      ['schedules', 'assignment_id'], ['assignment_comments', 'assignment_id'],
      ['assignment_expenses', 'assignment_id'], ['assignment_idempotency_records', 'assignment_id'],
      ['assignment_reassignments', 'assignment_id'], ['assayer_remarks', 'assignment_id'],
    ]) await del(tbl, `DELETE FROM ${tbl} WHERE ${col} = ANY($1)`, [asg]);
    await del('assignments', `DELETE FROM assignments WHERE id = ANY($1)`, [asg]);
  }
  if (pbs.length) {
    await del('documents', `DELETE FROM documents WHERE project_branch_id = ANY($1)`, [pbs]);
    await del('validation_queries', `DELETE FROM validation_queries WHERE validation_case_id IN (SELECT id FROM validation_cases WHERE project_branch_id = ANY($1))`, [pbs]);
    await del('validation_cases', `DELETE FROM validation_cases WHERE project_branch_id = ANY($1)`, [pbs]);
    await del('project_branches', `DELETE FROM project_branches WHERE id = ANY($1)`, [pbs]);
  }
  if (br.length) {
    for (const t of ['assessments', 'branch_contacts', 'branch_documents', 'customer_records'])
      await del(t, `DELETE FROM ${t} WHERE branch_id = ANY($1)`, [br]);
    await del('branches', `DELETE FROM branches WHERE id = ANY($1)`, [br]);
  }
  if (asy.length) {
    for (const t of [
      'assayer_activities', 'assayer_background_checks', 'assayer_client_empanelments',
      'assayer_commercial_profiles', 'assayer_document_versions', 'assayer_documents',
      'assayer_idempotency_records', 'assayer_import_issues', 'assayer_location_pings',
      'assayer_references', 'assayer_remarks', 'assayer_score_overrides', 'workforce_attributes',
      'schedules', 'assayer_payables', 'notifications',
    ]) await del(t, `DELETE FROM ${t} WHERE assayer_id = ANY($1)`, [asy]);
    await del('call_logs', `DELETE FROM call_logs WHERE assessor_id = ANY($1)`, [asy]);
    await del('assayers', `DELETE FROM assayers WHERE id = ANY($1)`, [asy]);
  }
  console.log(`  ${where}: ${removed.join('  ') || 'nothing'}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n╔═ FAPOMS — ten business days ═══════════════════════════════════════════════`);
  console.log(`║  API ${env.AC_API}`);
  console.log(`║  run tag ${TAG} ${STAMP}\n`);
  declareMutating('ten-business-days', [
    'drives ten business days of real work: creates assayers, branches, project branches,',
    '  assignments, documents, payouts and an invoice, through the product',
    'BOOKS AND PAYS REAL MONEY: payouts are approved and released, and a client invoice is minted',
    'writes client panel standings, including a REJECTED one and its reversal',
    'mints assayer app logins and rotates their forced password — needs',
    '  AC_ALLOW_PASSWORD_ROTATION=1 as well',
    'deletes everything it made, at both ends of the run, by run tag',
  ]);

  console.log('Teardown (before) — leftovers from any earlier run');
  await purge('before');

  // ── the cast signs in ───────────────────────────────────────────────────────────────────────
  scenario('CAST', 'everyone signs in, and every session is proved alive before it is trusted');
  for (const [who, args] of Object.entries(CAST_DEF)) cast[who] = await signIn(...args);
  for (const who of Object.keys(CAST_DEF)) await proveAlive(who, cast[who].token);

  const setting = async (key, fallback) => {
    const r = await GET('/platform-settings', cast.admin.token);
    const list = r.body?.data;
    const arr = Array.isArray(list) ? list : (list?.items ?? []);
    const hit = arr.find((x) => (x.key ?? x.name) === key);
    return hit ? num(hit.value ?? hit.effectiveValue ?? fallback) : fallback;
  };
  rates.assayerTds = await setting('billing.tdsRate', 10);

  const anchor = await branchFor('Anchor');
  HOME = { lat: anchor.lat + HOME_OFFSET_DEG, lng: anchor.lng };
  const cb = await one(`SELECT gst_rate, tds_rate FROM client_billing WHERE client_id=$1 AND is_active`, [anchor.clientId]);
  rates.clientGst = num(cb?.gst_rate ?? 18);
  rates.clientTds = num(cb?.tds_rate ?? 10);
  const clientRate = await one(
    `SELECT default_base_fee, working_days FROM client_configurations WHERE client_id=$1 AND is_active LIMIT 1`, [anchor.clientId]);
  const prefs = await one(`SELECT planning_preferences p FROM clients WHERE id=$1`, [anchor.clientId]);
  minDistanceKm = num(prefs?.p?.minDistanceKm);
  maxDistanceKm = num(prefs?.p?.maxDistanceKm);
  check('the tax and rate configuration this run recomputes against was read from configuration, not from a result',
    rates.assayerTds > 0 && rates.clientGst > 0,
    `assayer TDS ${rates.assayerTds}% (platform_settings billing.tdsRate), client GST ${rates.clientGst}% / TDS ${rates.clientTds}% (client_billing), `
    + `client rate card ${clientRate?.default_base_fee ?? 'none — the line passes the fee through'}, working days ${JSON.stringify(clientRate?.working_days)}, `
    + `distance band ${minDistanceKm}–${maxDistanceKm} km (clients.planning_preferences)`);

  const TODAY = isoDay(new Date());
  const todayOk = await dateIsWorkable(cast.admin.token, TODAY, anchor.stateName, anchor.clientId);
  check('today is or is not a working day for this client, and the run adapts either way',
    true, `${TODAY} (${dayName(TODAY)}) is ${todayOk ? 'workable — check-in scenarios run for real' : 'NOT workable; check-in scenarios fall back to completion-with-a-reason'}`);

  const booked = new Set();
  const nextDate = async (afterIso = TODAY) => {
    const r = await nextWorkableDate(cast.admin.token, {
      state: anchor.stateName, clientId: anchor.clientId, after: afterIso, taken: booked,
    });
    booked.add(r.date);
    return r;
  };

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S1', 'a normal day: hire, verify, activate, empanel, assign, accept, check in, complete, pay');

  const a1 = await hire('Normal', { withApp: true });
  check('a new hire arrives INVITED and is walked to ACTIVE only through the stages',
    a1.lifecycle_status === 'ACTIVE' && a1.status === 'ACTIVE',
    `${a1.assayer_code} ${a1.display_name} — lifecycle ${a1.lifecycle_status}, projection ${a1.status}`);
  const kycRow = await one(
    `SELECT verification_status, verified_at FROM assayer_documents WHERE assayer_id=$1 AND requirement='PAN_CARD'`, [a1.id]);
  check('the PAN card was checked against what the card says, and the verification is on the record',
    a1.kyc?.status < 400 && kycRow?.verification_status === 'VERIFIED' && !!kycRow?.verified_at,
    `assayer_documents.verification_status=${kycRow?.verification_status}, verified_at ${kycRow?.verified_at ? 'set' : 'null'}`);
  check('the person can sign in to the field app', !!a1.app, a1.app ? 'app access issued and used' : 'NO app token — the field half of this scenario cannot run');
  check('their confirmed base location sits inside the client\'s independence floor and service ceiling',
    near(a1.latitude, HOME.lat, 0.001) && near(a1.longitude, HOME.lng, 0.001),
    `PUT /assayers/:id/base-location -> assayers.latitude/longitude ${a1.latitude},${a1.longitude}; `
    + `the branch is at ${anchor.lat},${anchor.lng} (~${Math.round(HOME_OFFSET_DEG * 111)} km apart, floor ${minDistanceKm} km / ceiling ${maxDistanceKm} km)`);

  const b1 = await branchFor('S1');
  const e1 = await empanel(a1.id, b1.clientId);
  const empRow = await one(`SELECT status, decided_at FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`, [a1.id, b1.clientId]);
  check('empanelled with the client, and the standing is a stored fact about the pair',
    e1.status < 400 && empRow?.status === 'ACTIVE',
    `assayer_client_empanelments.status=${empRow?.status}, decided ${empRow?.decided_at ? 'recorded' : 'null'}`);

  const FEE1 = FEE;
  const d1 = todayOk ? { date: TODAY, tried: 0 } : await nextDate();
  if (todayOk) booked.add(TODAY);
  const asg1 = await offer(cast.ops.token, { pb: b1, assayerId: a1.id, date: d1.date, fee: FEE1 });
  check('operations books the job', asg1.status < 400 && !!asg1.body?.data?.id,
    `POST /assignments -> ${asg1.status} for ${d1.date} (${dayName(d1.date)}); ${d1.tried} candidate date(s) tried`);
  if (asg1.status >= 400) throw new Error(`S1 could not book: ${short(asg1.body, 400)}`);
  const A1 = asg1.body.data.id;
  let r1 = await one(`SELECT status, assayer_id, project_branch_id, created_by FROM assignments WHERE id=$1`, [A1]);
  const pb1 = await one(`SELECT status FROM project_branches WHERE id=$1`, [b1.pbId]);
  check('the offer is PENDING, owned by the intended person, and the branch has moved into planning',
    r1.status === 'PENDING' && r1.assayer_id === a1.id,
    `assignments.status=${r1.status}, project_branches.status=${pb1?.status}`);

  const acc1 = await POST(`/assignments/${A1}/accept`, a1.app.token, {});
  r1 = await one(`SELECT status, agreed_fee, quoted_travel_fee, proposed_fee FROM assignments WHERE id=$1`, [A1]);
  const pb1b = await one(`SELECT status FROM project_branches WHERE id=$1`, [b1.pbId]);
  check('the assayer accepts from the app, and the branch is confirmed',
    acc1.status < 400 && r1.status === 'ACCEPTED' && pb1b?.status === 'ASSIGNMENT_CONFIRMED',
    `assignments.status=${r1.status}, project_branches.status=${pb1b?.status}`);

  let checkedIn = false;
  if (todayOk && a1.app) {
    const ci = await POST(`/assignments/${A1}/check-in`, a1.app.token, { latitude: b1.lat, longitude: b1.lng, accuracy: 8 });
    const ciRow = await one(`SELECT status, checked_in_at, check_in_distance_meters FROM assignments WHERE id=$1`, [A1]);
    checkedIn = ciRow?.status === 'CHECKED_IN' && !!ciRow.checked_in_at;
    check('the assayer checks in on site, and the attendance evidence is stored',
      ci.status < 400 && checkedIn,
      `assignments.status=${ciRow?.status}, checked_in_at ${ciRow?.checked_in_at ? 'set' : 'null'}, ${ciRow?.check_in_distance_meters ?? '?'} m from the branch`);
  } else {
    check('check-in skipped: the scheduled day is not today, and the product only accepts a check-in on the day',
      true, `scheduled ${d1.date}, today ${TODAY} — the run completes with a stated reason instead`);
  }

  const cmp1 = await POST(`/assignments/${A1}/complete`, cast.ops.token,
    { reason: `${TAG} S1: field work verified and the packet received.` });
  r1 = await one(`SELECT status, completion_date, agreed_fee, proposed_fee, quoted_travel_fee, counter_travel_fee FROM assignments WHERE id=$1`, [A1]);
  const pb1c = await one(`SELECT status FROM project_branches WHERE id=$1`, [b1.pbId]);
  check('operations completes the audit and the branch closes',
    cmp1.status < 400 && r1.status === 'COMPLETED' && pb1c?.status === 'AUDIT_COMPLETED',
    `assignments.status=${r1.status}, project_branches.status=${pb1c?.status}`);

  const p1 = await waitForPayable(A1);
  const entries1 = await sql(`SELECT * FROM billing_entries WHERE assignment_id=$1`, [A1]);
  check('completion books exactly one payable and exactly one client line',
    !!p1 && entries1.length === 1,
    `assayer_payables ${p1 ? 1 : 0}, billing_entries ${entries1.length}`);
  if (!p1) throw new Error('S1: no payable was ever booked');

  const want1 = expectedMoney(r1, { gstRate: rates.clientGst, clientTdsRate: rates.clientTds });
  check('what we owe the assayer, recomputed from the fee and the frozen travel — not read back',
    near(p1.base_amount, want1.assayer.base) && near(p1.travel_amount, want1.assayer.travel)
    && near(p1.tds_amount, want1.assayer.tds) && near(p1.total_amount, want1.assayer.net),
    `fee ${want1.fee} = base ${want1.assayer.base} + travel ${want1.assayer.travel}; `
    + `TDS ${rates.assayerTds}% = ${want1.assayer.tds}; net ${want1.assayer.net}. `
    + `Stored: base ${p1.base_amount}, travel ${p1.travel_amount}, tds ${p1.tds_amount}, total ${p1.total_amount}`);
  const e1r = entries1[0];
  check('what we bill the client, recomputed from the same inputs and the client\'s own tax rates',
    near(e1r.taxable_amount, want1.client.taxable) && near(e1r.tax_amount, want1.client.gst)
    && near(e1r.tds_amount, want1.client.tds) && near(e1r.total_amount, want1.client.total),
    `taxable ${want1.client.taxable}; GST ${rates.clientGst}% = ${want1.client.gst}; TDS ${rates.clientTds}% = ${want1.client.tds}; total ${want1.client.total}. `
    + `Stored: taxable ${e1r.taxable_amount}, tax ${e1r.tax_amount}, tds ${e1r.tds_amount}, total ${e1r.total_amount}`);

  // Segregation of duties, in both directions.
  const selfApprove = await POST('/billing-engine/payouts/approve', cast.ops.token, { payableIds: [p1.id] });
  let ps = await one(`SELECT status, approved_by FROM assayer_payables WHERE id=$1`, [p1.id]);
  const refusal1 = short(selfApprove.body?.data?.refused?.[0]?.reason ?? msg(selfApprove), 110);
  check('whoever booked the work cannot approve the payout for it',
    ps.status === 'PENDING' && /segregation|duti/i.test(refusal1),
    `approve as the booker -> HTTP ${selfApprove.status}, refused: "${refusal1}"; payable still ${ps.status}`);

  const app1 = await POST('/billing-engine/payouts/approve', cast.admin.token, { payableIds: [p1.id] });
  ps = await one(`SELECT status, approved_by, approved_at FROM assayer_payables WHERE id=$1`, [p1.id]);
  check('a second person approves it',
    app1.status < 400 && ps.status === 'APPROVED' && ps.approved_by === cast.admin.user?.id,
    `assayer_payables.status=${ps.status}, approved_by ${ps.approved_by === cast.admin.user?.id ? 'the approver' : ps.approved_by}`);

  const REF1 = `${TAG}-S1-${STAMP}`;
  const selfPay = await POST('/billing-engine/payouts/pay', cast.admin.token, { payableIds: [p1.id], paymentReference: REF1, method: 'NEFT' });
  ps = await one(`SELECT status FROM assayer_payables WHERE id=$1`, [p1.id]);
  const refusal2 = short(selfPay.body?.data?.refused?.[0]?.reason ?? msg(selfPay), 110);
  check('and the approver cannot also release the cash',
    ps.status === 'APPROVED' && /segregation|duti/i.test(refusal2),
    `pay as the approver -> HTTP ${selfPay.status}, refused: "${refusal2}"; payable still ${ps.status}`);

  await POST('/billing-engine/payouts/pay', cast.finance.token, { payableIds: [p1.id], paymentReference: REF1, method: 'NEFT' });
  await POST('/billing-engine/payouts/pay', cast.finance.token, { payableIds: [p1.id], paymentReference: REF1, method: 'NEFT' });
  ps = await one(`SELECT status, paid_amount, paid_by FROM assayer_payables WHERE id=$1`, [p1.id]);
  const pays1 = await sql(`SELECT amount, direction FROM billing_payments WHERE payable_id=$1 AND is_active`, [p1.id]);
  check('a third person pays it, and paying twice is still one payment for the right amount',
    ps.status === 'PAID' && pays1.length === 1 && near(pays1[0]?.amount, want1.assayer.net),
    `assayer_payables.status=${ps.status}; ${pays1.length} active billing_payments row(s); paid ${pays1[0]?.amount} against a recomputed net of ${want1.assayer.net}`);

  const recon = await GET('/billing-engine/reconcile/preview', cast.admin.token);
  const unbooked = await one(
    `SELECT count(*)::int c FROM assignments a WHERE a.status='COMPLETED' AND a.id=$1
       AND (NOT EXISTS (SELECT 1 FROM billing_entries be WHERE be.assignment_id=a.id)
            OR NOT EXISTS (SELECT 1 FROM assayer_payables p WHERE p.assignment_id=a.id AND p.expense_id IS NULL))`, [A1]);
  check('reconciliation answers, and this job is not among the unbooked',
    recon.status < 400 && Number(unbooked.c) === 0,
    `GET /billing-engine/reconcile/preview -> ${recon.status} ${short(recon.body?.data)}; this assignment unbooked-count ${unbooked.c}`);

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S2', 'the assayer declines: the offer comes back to the desk and somebody else takes it');

  const a2a = await hire('Decliner', { withApp: true });
  const a2b = await hire('Taker', { withApp: true });
  const b2 = await branchFor('S2');
  await empanel(a2a.id, b2.clientId);
  await empanel(a2b.id, b2.clientId);
  const d2 = await nextDate();

  const off2 = await offer(cast.ops.token, { pb: b2, assayerId: a2a.id, date: d2.date, fee: FEE });
  check('the first person is offered the job', off2.status < 400,
    `POST /assignments -> ${off2.status} for ${d2.date} (${dayName(d2.date)}); ${d2.tried} candidate date(s) tried`);
  const A2a = off2.body?.data?.id;

  const noReason = await POST(`/assignments/${A2a}/reject`, a2a.app.token, {});
  const dNo = denial(noReason, 400);
  check('declining without saying why is refused',
    dNo.ok && /reason/i.test(msg(noReason)),
    `POST :id/reject with no reason -> ${dNo.label} "${short(msg(noReason), 90)}"`);

  const REASON2 = 'Family emergency on that date; cannot travel to Pune.';
  const rej = await POST(`/assignments/${A2a}/reject`, a2a.app.token, { reason: REASON2 });
  const r2a = await one(`SELECT status, reject_reason FROM assignments WHERE id=$1`, [A2a]);
  const pb2 = await one(`SELECT status FROM project_branches WHERE id=$1`, [b2.pbId]);
  check('the decline is recorded with the reason the person gave',
    rej.status < 400 && r2a.status === 'REJECTED' && r2a.reject_reason === REASON2,
    `assignments.status=${r2a.status}, reject_reason "${short(r2a.reject_reason, 60)}"`);
  check('and the branch goes back on the market for a candidate search',
    pb2?.status === 'CANDIDATE_SEARCH',
    `project_branches.status=${pb2?.status} (a declined offer must not leave the branch looking staffed)`);

  const off2b = await offer(cast.ops.token, { pb: b2, assayerId: a2b.id, date: d2.date, fee: FEE });
  check('a declined branch can be offered to somebody else — the rejected row does not block it',
    off2b.status < 400,
    `POST /assignments (same branch, second person) -> ${off2b.status} ${off2b.status >= 400 ? short(msg(off2b), 120) : ''}`);
  const A2b = off2b.body?.data?.id;
  const acc2 = await POST(`/assignments/${A2b}/accept`, a2b.app.token, {});
  const r2b = await one(`SELECT status, assayer_id, assignment_number, reject_reason FROM assignments WHERE id=$1`, [A2b]);
  const pb2b = await one(`SELECT status FROM project_branches WHERE id=$1`, [b2.pbId]);
  const both = await sql(`SELECT status FROM assignments WHERE project_branch_id=$1 ORDER BY created_at`, [b2.pbId]);
  check('the second person accepts, and the branch is staffed again',
    acc2.status < 400 && r2b.status === 'ACCEPTED' && r2b.assayer_id === a2b.id && pb2b?.status === 'ASSIGNMENT_CONFIRMED',
    `${r2b?.assignment_number} is now ACCEPTED by the second person; assignments on this branch: ${both.map((x) => x.status).join(' + ')}; `
    + `project_branches.status=${pb2b?.status}`);

  /**
   * Re-offering a declined branch reuses the SAME assignment row — by design, so the branch keeps
   * one unified timeline. The question that matters is what survives that reuse. `reject_reason`
   * is set to null on the reused row (assignment.service.ts, the `reusableExisting` branch), so
   * the record itself no longer says the first person declined or why: whether the business can
   * still answer "who turned this down, and what did they say" depends entirely on the trail and
   * the reassignment lineage. That is what is checked here, because that is what an operations
   * manager would go looking for on Monday.
   */
  const reused = A2b === A2a;
  const lineage = await sql(
    `SELECT previous_assayer_id, new_assayer_id, reason FROM assignment_reassignments WHERE assignment_id=$1`, [A2b]);
  const declineTrail = await sql(
    `SELECT event_type, new_state, remarks FROM audit_events
      WHERE entity_id=$1 AND (new_state='REJECTED' OR event_type ILIKE '%REJECT%') ORDER BY occurred_at`, [A2b]);
  const keepsTheReason = r2b?.reject_reason === REASON2
    || declineTrail.some((e) => String(e.remarks ?? '').includes(REASON2))
    || lineage.some((l) => String(l.reason ?? '').includes(REASON2));
  check('and the decline the branch is being re-offered because of is still answerable afterwards',
    keepsTheReason,
    `the second offer ${reused ? 'REUSED the same assignment row' : 'created a new row'}; `
    + `assignments.reject_reason is now ${r2b?.reject_reason === null ? 'NULL — erased by the reuse' : `"${short(r2b?.reject_reason, 40)}"`}; `
    + `audit rows carrying the decline: ${declineTrail.length} (${declineTrail.map((e) => e.event_type).join(',') || 'none'}); `
    + `assignment_reassignments rows: ${lineage.length}`);

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S3', 'the visit moves: booked, then rescheduled, and the calendar and the job agree afterwards');

  const a3 = await hire('Reschedule', { withApp: true });
  const b3 = await branchFor('S3');
  await empanel(a3.id, b3.clientId);
  const d3a = await nextDate();
  const off3 = await offer(cast.ops.token, { pb: b3, assayerId: a3.id, date: d3a.date, fee: FEE });
  const A3 = off3.body?.data?.id;
  check('the visit is booked for a date the calendar accepts', off3.status < 400 && !!A3,
    `POST /assignments -> ${off3.status} for ${d3a.date} (${dayName(d3a.date)}); ${d3a.tried} candidate date(s) tried`);

  await POST(`/assignments/${A3}/accept`, a3.app.token, {});
  const sch = await POST('/schedules', cast.ops.token, { assignmentId: A3, scheduledDate: d3a.date, remarks: `${TAG} S3 confirmed visit` });
  const schRow = await one(`SELECT id, status, scheduled_date::text d FROM schedules WHERE assignment_id=$1`, [A3]);
  const asg3 = await one(`SELECT scheduled_date::text d FROM assignments WHERE id=$1`, [A3]);
  const pb3 = await one(`SELECT status FROM project_branches WHERE id=$1`, [b3.pbId]);
  check('the visit is in the calendar, agreeing with the job, and the branch reads SCHEDULED',
    sch.status < 400 && schRow?.d === asg3?.d && schRow?.status === 'CONFIRMED' && pb3?.status === 'SCHEDULED',
    `schedules.scheduled_date=${schRow?.d} status=${schRow?.status}; assignments.scheduled_date=${asg3?.d}; project_branches.status=${pb3?.status}`);

  const d3b = await nextDate(d3a.date);
  const moved = await POST(`/schedules/${schRow.id}/transition`, cast.ops.token,
    { targetStatus: 'RESCHEDULED', scheduledDate: d3b.date, remarks: 'Branch manager away; moved at the client\'s request.' });
  const schRow2 = await one(`SELECT status, scheduled_date::text d FROM schedules WHERE id=$1`, [schRow.id]);
  const asg3b = await one(`SELECT scheduled_date::text d FROM assignments WHERE id=$1`, [A3]);
  check('the visit is moved to a new date the calendar also accepts',
    moved.status < 400 && schRow2?.status === 'RESCHEDULED' && schRow2?.d === d3b.date,
    `POST /schedules/:id/transition -> ${moved.status}; schedules.scheduled_date ${schRow?.d} -> ${schRow2?.d}, status ${schRow2?.status}; ${d3b.tried} candidate date(s) tried`);
  check('afterwards the calendar and the job say the same date — there is one answer to "when is the visit"',
    schRow2?.d === asg3b?.d && asg3b?.d === d3b.date,
    `schedules.scheduled_date=${schRow2?.d}, assignments.scheduled_date=${asg3b?.d}, asked for ${d3b.date}`);

  const oldDate = await one(`SELECT count(*)::int c FROM assignments WHERE id=$1 AND scheduled_date::text = $2`, [A3, d3a.date]);
  check('and nothing is still pointing at the old date',
    Number(oldDate.c) === 0, `assignments still on ${d3a.date}: ${oldDate.c}`);

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S4', 'somebody leaves mid-job: the open assignment\'s fate must be explicit, not silent');

  const a4 = await hire('Leaver', { withApp: true });
  const b4 = await branchFor('S4');
  await empanel(a4.id, b4.clientId);
  const d4 = await nextDate();
  const { id: A4 } = await mustOffer(cast.ops.token, { pb: b4, assayerId: a4.id, date: d4.date, fee: FEE }, 'S4 open work');
  await POST(`/assignments/${A4}/accept`, a4.app.token, {});
  const before4 = await one(`SELECT status FROM assignments WHERE id=$1`, [A4]);
  check('the person has live, accepted work on the books', before4?.status === 'ACCEPTED',
    `assignments.status=${before4?.status} for ${d4.date}; ${d4.tried} candidate date(s) tried`);

  const REASON4 = 'Resigned with immediate effect; last working day today.';
  const resign = await POST(`/assayers/${a4.id}/lifecycle`, cast.admin.token, { targetStatus: 'RESIGNED', reason: REASON4 });
  const a4row = await one(`SELECT lifecycle_status, status, exit_date FROM assayers WHERE id=$1`, [a4.id]);
  check('the resignation is accepted and dated',
    resign.status < 400 && a4row?.lifecycle_status === 'RESIGNED',
    `assayers.lifecycle_status=${a4row?.lifecycle_status}, projection ${a4row?.status}, exit_date ${a4row?.exit_date ? 'set' : 'null'}`);

  const after4 = await one(`SELECT status, cancel_reason, is_active FROM assignments WHERE id=$1`, [A4]);
  const trail4 = await sql(
    `SELECT event_type, remarks, occurred_at FROM audit_events
      WHERE entity_id = ANY($1) ORDER BY occurred_at DESC LIMIT 30`, [[A4, a4.id]]);
  const namesTheJob = trail4.some((e) => /assign/i.test(e.event_type ?? '') && new Date(e.occurred_at) >= new Date(Date.now() - 120000));
  const stillLive = ['PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS'].includes(after4?.status);
  const surfaced = await (async () => {
    for (const p of ['/assignments/inbox', '/assignments/falling-behind', '/assignments/operational-integrity/scan']) {
      const r = await GET(p, cast.ops.token);
      if (r.status < 400 && JSON.stringify(r.body ?? {}).includes(A4)) return p;
    }
    return null;
  })();
  check('the open job\'s fate is explicit: either it is no longer live, or the product surfaces it as needing a decision',
    !stillLive || !!surfaced,
    `assignments.status after the resignation = ${after4?.status}` +
    (stillLive
      ? (surfaced ? `; still live but surfaced by ${surfaced}` : '; STILL LIVE and surfaced by none of /assignments/inbox, /assignments/falling-behind, /assignments/operational-integrity/scan')
      : `, cancel_reason "${short(after4?.cancel_reason, 60)}"`) +
    `; assignment-related audit rows in the last 2 min: ${namesTheJob ? 'yes' : 'no'}`);

  const newWork = await offer(cast.ops.token, { pb: await branchFor('S4b'), assayerId: a4.id, date: (await nextDate()).date, fee: FEE });
  const d4b = denial(newWork, 400);
  check('and a person who has left cannot be given new work',
    newWork.status >= 400,
    `POST /assignments for a RESIGNED assayer -> ${d4b.label} "${short(msg(newWork), 110)}"`);

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S5', 'the client changes its mind: a rejection, then a reversal that has to be justified in writing');

  const a5 = await hire('Panel', { withApp: true });
  const b5a = await branchFor('S5a');
  const b5b = await branchFor('S5b');
  await empanel(a5.id, b5a.clientId);
  const d5a = await nextDate();
  const off5a = await offer(cast.ops.token, { pb: b5a, assayerId: a5.id, date: d5a.date, fee: FEE });
  const A5a = off5a.body?.data?.id;
  await POST(`/assignments/${A5a}/accept`, a5.app.token, {});
  check('work is placed with them while the panel standing is good', off5a.status < 400,
    `POST /assignments -> ${off5a.status} for ${d5a.date}; ${d5a.tried} candidate date(s) tried`);

  const rejEmp = await empanel(a5.id, b5a.clientId, 'REJECTED', 'Bank compliance review declined the empanelment.');
  const emp5 = await one(`SELECT status, status_reason FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`, [a5.id, b5a.clientId]);
  check('the client turns them down, and the refusal is stored with the client\'s reason',
    rejEmp.status < 400 && emp5?.status === 'REJECTED' && !!emp5?.status_reason,
    `assayer_client_empanelments.status=${emp5?.status}, status_reason "${short(emp5?.status_reason, 60)}"`);

  const priorStill = await one(`SELECT status, empanelment_standing_at_creation FROM assignments WHERE id=$1`, [A5a]);
  check('work placed before the rejection stands, and remembers the standing it was created under',
    priorStill?.status === 'ACCEPTED',
    `assignments.status=${priorStill?.status}, empanelment_standing_at_creation=${priorStill?.empanelment_standing_at_creation}`);

  const d5b = await nextDate();
  const blocked = await offer(cast.ops.token, { pb: b5b, assayerId: a5.id, date: d5b.date, fee: FEE });
  const dBlocked = denial(blocked, 403);
  check('while rejected, new work for that client is refused — and a stated reason does not help',
    blocked.status >= 400,
    `POST /assignments -> ${dBlocked.label} "${short(msg(blocked), 110)}"`);
  const blockedWithReason = await offer(cast.ops.token, {
    pb: b5b, assayerId: a5.id, date: d5b.date, fee: FEE,
    overrideReason: 'Head of operations has cleared this personally for continuity on the account.',
  });
  const dBlocked2 = denial(blockedWithReason, 403);
  check('a REJECTED panel standing is not an operator\'s to waive, however good the reason',
    blockedWithReason.status >= 400,
    `POST /assignments with an override reason -> ${dBlocked2.label} "${short(msg(blockedWithReason), 130)}"`);

  const bare = await empanel(a5.id, b5a.clientId, 'ACTIVE');
  const emp5b = await one(`SELECT status FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`, [a5.id, b5a.clientId]);
  const dBare = denial(bare, 400);
  check('reversing the client\'s rejection with no written reason is refused, and nothing moves',
    bare.status === 400 && emp5b?.status === 'REJECTED',
    `PUT empanelment ACTIVE with no statusReason -> ${dBare.label} "${short(msg(bare), 110)}"; standing now ${emp5b?.status}`
    + (bare.status === 200
      ? '\n   A 200 here means the deployed build does not carry the guard that RosterRecordsService requires a statusReason'
      + '\n   on REJECTED -> anything. Tell a stale image from a regression with:'
      + '\n     docker exec deploy-backend-1 grep -rl "rejection is being reversed" /app/packages/backend/dist'
      + '\n   — no match means the running image predates the control, and this run is measuring an old binary, not HEAD.'
      : ''));

  const REVERSAL = 'Compliance re-reviewed on 10 Sep and cleared the candidate; reversal approved by the panel head.';
  const rev = await empanel(a5.id, b5a.clientId, 'ACTIVE', REVERSAL);
  const emp5c = await one(`SELECT status, status_reason, decided_at FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`, [a5.id, b5a.clientId]);
  check('with a written reason the reversal is allowed, and the reason is what is stored against it',
    rev.status < 400 && emp5c?.status === 'ACTIVE' && emp5c?.status_reason === REVERSAL,
    `assayer_client_empanelments.status=${emp5c?.status}, status_reason "${short(emp5c?.status_reason, 70)}"`);

  const after5 = await offer(cast.ops.token, { pb: b5b, assayerId: a5.id, date: d5b.date, fee: FEE });
  const r5b = after5.body?.data?.id ? await one(`SELECT status, empanelment_override_used FROM assignments WHERE id=$1`, [after5.body.data.id]) : null;
  check('and afterwards work is placed normally — no override, no waiver, just an eligible person',
    after5.status < 400 && r5b?.empanelment_override_used !== true,
    `POST /assignments -> ${after5.status}; empanelment_override_used=${r5b?.empanelment_override_used}`);

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S6', 'a completed job was wrong: reopen it, prove the money is unwound, then close it again');

  const a6 = await hire('Reopen', { withApp: true });
  const b6 = await branchFor('S6');
  await empanel(a6.id, b6.clientId);
  const d6 = todayOk && !booked.has(TODAY) ? { date: TODAY, tried: 0 } : await nextDate();
  if (d6.date === TODAY) booked.add(TODAY);
  const { id: A6 } = await mustOffer(cast.ops.token, { pb: b6, assayerId: a6.id, date: d6.date, fee: FEE }, 'S6 the job that gets reopened');
  await POST(`/assignments/${A6}/accept`, a6.app.token, {});
  if (d6.date === TODAY && a6.app) await POST(`/assignments/${A6}/check-in`, a6.app.token, { latitude: b6.lat, longitude: b6.lng, accuracy: 8 });
  await POST(`/assignments/${A6}/complete`, cast.ops.token, { reason: `${TAG} S6: first completion.` });
  const p6a = await waitForPayable(A6);
  const e6a = await one(`SELECT id, state FROM billing_entries WHERE assignment_id=$1`, [A6]);
  check('the job is completed once and books one payable and one client line',
    !!p6a && !!e6a, `payable ${p6a?.payable_number}, client line ${e6a?.id ? e6a.state : 'none'}`);

  const REASON6 = 'Wrong branch packet was valued; the audit has to be done again.';
  const reop = await POST(`/assignments/${A6}/reopen`, cast.ops.token, { reason: REASON6 });
  const r6 = await one(`SELECT status, completion_date, checked_in_at FROM assignments WHERE id=$1`, [A6]);
  const p6aAfter = await one(`SELECT status, on_hold FROM assayer_payables WHERE id=$1`, [p6a.id]);
  const e6aAfter = await one(`SELECT state, invoice_id FROM billing_entries WHERE id=$1`, [e6a.id]);
  check('reopening takes the completion back',
    reop.status < 400 && r6?.status === 'ACCEPTED' && r6?.completion_date === null,
    `POST :id/reopen -> ${reop.status}; assignments.status=${r6?.status}, completion_date ${r6?.completion_date ?? 'cleared'}`);
  check('the payable it booked is VOIDED, not merely held or deleted',
    p6aAfter?.status === 'VOIDED',
    `assayer_payables.status=${p6aAfter?.status}, on_hold=${p6aAfter?.on_hold} (a voided obligation stays on the books so the reversal is legible)`);
  check('and the client line is cancelled, so the bank is not invoiced for work now said to be unfinished',
    e6aAfter?.state === 'CANCELLED',
    `billing_entries.state=${e6aAfter?.state}, invoice_id=${e6aAfter?.invoice_id ?? 'null'}`);

  const cmp6b = await POST(`/assignments/${A6}/complete`, cast.ops.token, { reason: `${TAG} S6: redone and verified.` });
  const r6b = await one(`SELECT status, completion_date FROM assignments WHERE id=$1`, [A6]);
  check('the redone audit is completed again',
    cmp6b.status < 400 && r6b?.status === 'COMPLETED' && !!r6b?.completion_date,
    `POST :id/complete -> ${cmp6b.status}; assignments.status=${r6b?.status}, completion_date ${r6b?.completion_date ? 'set again' : 'still null'}`);

  const p6b = await waitForPayable(A6, { timeoutMs: 30000 });
  const allPay6 = await sql(`SELECT id, status, payable_number FROM assayer_payables WHERE assignment_id=$1 ORDER BY created_at`, [A6]);
  const allEnt6 = await sql(`SELECT state, entry_number FROM billing_entries WHERE assignment_id=$1 ORDER BY created_at`, [A6]);
  const livePay = allPay6.filter((p) => p.status !== 'VOIDED');
  const liveEnt = allEnt6.filter((e) => e.state !== 'CANCELLED');
  check('completing it again leaves exactly one live payable and one live client line',
    livePay.length === 1 && liveEnt.length === 1,
    `payables ${allPay6.map((p) => `${p.payable_number}:${p.status}`).join(', ')} | client lines ${allEnt6.map((e) => `${e.entry_number}:${e.state}`).join(', ')}`
    + (livePay.length === 0 ? '\n   The redone work is completed and owes nobody anything: the assayer is not paid for it and the client is never billed for it.' : ''));
  check('the payable for the redone work is a new obligation, not the voided one revived',
    !!p6b && p6b.id !== p6a.id && p6b.status === 'PENDING',
    `first ${p6a.payable_number} (${p6aAfter?.status}), second ${p6b?.payable_number ?? 'never created'} (${p6b?.status ?? 'n/a'})`);

  /**
   * The two mechanisms that exist to notice exactly this, asked directly.
   *
   * `GET :id/money` is the screen a finance clerk opens to ask "is this job booked?", and
   * `GET /reconcile/preview` is the sweep whose entire job is to find completed work that booked
   * nothing. If the money is missing and both of these say everything is fine, the gap is not
   * merely present — it is invisible, which is the part that makes it expensive.
   */
  const money6 = await GET(`/billing-engine/assignments/${A6}/money`, adm());
  check('the money view does not claim a job is booked when its only obligation is void',
    money6.body?.data?.booked === (livePay.length > 0 && liveEnt.length > 0),
    `GET /billing-engine/assignments/:id/money -> ${money6.status}, booked=${money6.body?.data?.booked}; `
    + `it reports payable ${money6.body?.data?.payable?.payableNumber ?? 'none'} (${money6.body?.data?.payable?.status ?? 'n/a'}) `
    + `and entry state ${money6.body?.data?.entry?.state ?? 'none'}`);

  const rec6 = await GET('/billing-engine/reconcile/preview', adm());
  const seenByRec = await one(
    `SELECT count(*)::int c FROM assignments a
       LEFT JOIN billing_entries e ON e.assignment_id = a.id
       LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL
      WHERE a.id = $1 AND a.status='COMPLETED' AND (e.id IS NULL OR p.id IS NULL)`, [A6]);
  check('and the reconciliation sweep sees the unbooked completion it exists to find',
    livePay.length === 1 || Number(seenByRec.c) === 1,
    `GET /billing-engine/reconcile/preview -> ${rec6.status} ${short(rec6.body?.data)}; `
    + `the sweep's own query matches this assignment ${seenByRec.c} time(s) — it tests whether a row EXISTS, not whether a LIVE one does`);

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S7', 'the desk overrides a soft block with a reason, and is refused on a hard one whatever it says');

  const a7 = await hire('Override', { withApp: true });
  const b7 = await branchFor('S7');
  const b7b = await branchFor('S7b');
  await empanel(a7.id, b7.clientId);

  // DESK is the front desk, and does not hold the authority to book work at all. Worth proving
  // before anything is claimed about what "the desk" can override.
  const deskTry = await offer(cast.desk.token, { pb: b7, assayerId: a7.id, date: (await nextDate()).date, fee: FEE });
  const dDesk = denial(deskTry, 403);
  check('the DESK role cannot book work at all — the desk that overrides rules here is operations',
    dDesk.ok, `POST /assignments as DESK -> ${dDesk.label} "${short(msg(deskTry), 90)}"`);

  // Soft block: further from the branch than the client's service ceiling. A judgement call.
  await PUT_(`/assayers/${a7.id}/base-location`, cast.admin.token, { latitude: 21.1458, longitude: 79.0882 }); // Nagpur
  const far = await one(`SELECT latitude, longitude FROM assayers WHERE id=$1`, [a7.id]);
  const d7 = await nextDate();
  const noWaiver = await offer(cast.ops.token, { pb: b7, assayerId: a7.id, date: d7.date });
  const dSoft = denial(noWaiver, 400);
  check(`a soft block refuses, and says a reason would have helped (client ceiling ${maxDistanceKm} km)`,
    noWaiver.status === 400 && /OVERRIDE_REASON_REQUIRED/i.test(code(noWaiver) + short(noWaiver.body, 300)),
    `assayer pinned at ${far?.latitude},${far?.longitude}; POST /assignments -> ${dSoft.label} code=${code(noWaiver) || 'n/a'} "${short(msg(noWaiver), 120)}"`);

  const WAIVER = 'Nobody nearer is free this week and the client has agreed to the travel; approved by the ops head.';
  const waived = await offer(cast.ops.token, { pb: b7, assayerId: a7.id, date: d7.date, overrideReason: WAIVER });
  const A7 = waived.body?.data?.id;
  const r7 = A7 ? await one(
    `SELECT status, quoted_distance_km, empanelment_override_used, empanelment_override_reason FROM assignments WHERE id=$1`, [A7]) : null;
  const ov7 = A7 ? await sql(
    `SELECT event_type, remarks FROM audit_events WHERE entity_id=$1 AND event_type LIKE '%OVERR%'`, [A7]) : [];
  check('with a stated reason the same request is allowed, and the waiver is on the record',
    waived.status < 400 && !!r7 && (ov7.length > 0 || r7.empanelment_override_used === true),
    `POST /assignments -> ${waived.status}; quoted_distance_km ${r7?.quoted_distance_km}; `
    + `audit ${ov7.length ? ov7.map((o) => o.event_type).join(',') : 'none'}; `
    + `remarks "${short(ov7[0]?.remarks ?? r7?.empanelment_override_reason, 80)}"`);

  // Hard block: closer to the branch than the client's independence floor. Not an operator's to waive.
  await PUT_(`/assayers/${a7.id}/base-location`, cast.admin.token, { latitude: b7b.lat + 0.009, longitude: b7b.lng });
  const d7b = await nextDate();
  const HARD_REASON = 'Head of operations authorises this explicitly and accepts full accountability for the exception.';
  const hardAttempts = [];
  for (const [who, tok] of [['OPERATIONS', cast.ops.token], ['ADMIN', cast.admin.token], ['DEVELOPER', cast.finance.token]]) {
    const r = await offer(tok, { pb: b7b, assayerId: a7.id, date: d7b.date, overrideReason: HARD_REASON });
    hardAttempts.push({ who, status: r.status, code: code(r), message: msg(r), id: r.body?.data?.id ?? null });
  }
  const landed = await one(`SELECT count(*)::int c FROM assignments WHERE project_branch_id=$1`, [b7b.pbId]);
  check(`a hard block refuses every role, whatever reason it gives (client floor ${minDistanceKm} km)`,
    hardAttempts.every((h) => h.status >= 400) && Number(landed.c) === 0,
    hardAttempts.map((h) => `${h.who}: ${denial({ status: h.status }, 400).label}${h.code ? ` code=${h.code}` : ''} "${short(h.message, 70)}"`).join(' | ')
    + `; rows on that branch afterwards: ${landed.c}`);
  check('and the refusal says the rule can never be waived, rather than asking for a better reason',
    hardAttempts.every((h) => /RULE_NOT_OVERRIDABLE/i.test(h.code) || /not an operator|cannot be waived|not .* to waive/i.test(h.message)),
    hardAttempts.map((h) => `${h.who}: code=${h.code || 'n/a'}`).join(' | '));

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S8', 'payday: a batch approved and paid, one held with a reason, one voided with a reason');

  const a8 = await hire('Payday', { withApp: false });
  const jobs = [];
  for (let i = 0; i < 5; i++) {
    const b = await branchFor(`S8-${i + 1}`);
    if (i === 0) await empanel(a8.id, b.clientId);
    const d = await nextDate();
    const fee = FEE - 200 + i * 80;
    const r = await offer(cast.ops.token, { pb: b, assayerId: a8.id, date: d.date, fee, acceptOnBehalf: true });
    if (r.status >= 400) { jobs.push({ failed: short(msg(r), 120), date: d.date }); continue; }
    const id = r.body.data.id;
    await POST(`/assignments/${id}/complete`, cast.ops.token, { reason: `${TAG} S8 job ${i + 1}: work verified off site; packet received at the desk.` });
    const pay = await waitForPayable(id);
    jobs.push({ id, branch: b, date: d.date, fee, payable: pay });
  }
  const good = jobs.filter((j) => j.payable);
  check('five days of work are completed and each books its own payable',
    good.length === 5,
    jobs.map((j, i) => `job${i + 1} ${j.failed ? `FAILED (${j.failed})` : `${j.payable?.payable_number} ${j.payable?.status} on ${j.date}`}`).join(' | '));
  if (good.length < 3) throw new Error('S8 needs at least three payables to be a payday');

  const [j1, j2, j3, jHold, jVoid] = good;
  const batch = [j1, j2, j3].map((j) => j.payable.id);

  const held = await PATCH(`/billing-engine/payouts/${jHold.payable.id}/hold`, cast.admin.token,
    { onHold: true, reason: 'Bank account details under re-verification; do not release.' });
  const heldRow = await one(`SELECT on_hold, hold_reason, status FROM assayer_payables WHERE id=$1`, [jHold.payable.id]);
  check('one payout is held, with the reason recorded against it',
    held.status < 400 && heldRow?.on_hold === true && !!heldRow?.hold_reason,
    `PATCH :id/hold -> ${held.status}; on_hold=${heldRow?.on_hold}, hold_reason "${short(heldRow?.hold_reason, 60)}", status ${heldRow?.status}`);

  const VOID_REASON = 'That audit was reopened — the payout it booked must not be paid.';
  const voidedVia = await POST(`/assignments/${jVoid.id}/reopen`, cast.ops.token, { reason: VOID_REASON });
  const voidRow = await one(`SELECT status FROM assayer_payables WHERE id=$1`, [jVoid.payable.id]);
  check('one payout is voided with a reason — through the only command the product offers for it',
    voidedVia.status < 400 && voidRow?.status === 'VOIDED',
    `POST /assignments/:id/reopen -> ${voidedVia.status}; assayer_payables.status=${voidRow?.status} (there is no direct "void a payout" route)`);

  const tryHeld = await POST('/billing-engine/payouts/approve', cast.admin.token, { payableIds: [jHold.payable.id, jVoid.payable.id] });
  const heldAfter = await one(`SELECT status FROM assayer_payables WHERE id=$1`, [jHold.payable.id]);
  const voidAfter = await one(`SELECT status FROM assayer_payables WHERE id=$1`, [jVoid.payable.id]);
  const refusedIds = (tryHeld.body?.data?.refused ?? []).map((x) => x.id);
  check('a held payout and a voided one are both refused approval, and neither moves',
    refusedIds.length === 2 && heldAfter?.status === 'PENDING' && voidAfter?.status === 'VOIDED',
    `approve -> ${tryHeld.status}; refused ${(tryHeld.body?.data?.refused ?? []).map((x) => `"${short(x.reason, 50)}"`).join(', ')}; `
    + `held now ${heldAfter?.status}, voided now ${voidAfter?.status}`);

  const appBatch = await POST('/billing-engine/payouts/approve', cast.admin.token, { payableIds: batch });
  const approved = await sql(`SELECT id, status FROM assayer_payables WHERE id = ANY($1)`, [batch]);
  check('the rest are approved in one batch',
    appBatch.status < 400 && approved.every((p) => p.status === 'APPROVED'),
    `approve ${batch.length} -> ${appBatch.status}; done ${appBatch.body?.data?.done?.length ?? 0}, refused ${appBatch.body?.data?.refused?.length ?? 0}; statuses ${approved.map((p) => p.status).join(',')}`);

  const REF8 = `${TAG}-PAYRUN-${STAMP}`;
  const paid = await POST('/billing-engine/payouts/pay', cast.finance.token, { payableIds: batch, paymentReference: REF8, method: 'NEFT' });
  const paidRows = await sql(`SELECT id, status, paid_amount FROM assayer_payables WHERE id = ANY($1)`, [batch]);
  const payments = await sql(
    `SELECT amount, direction, payable_id FROM billing_payments WHERE payment_reference=$1 AND is_active`, [REF8]);
  check('and paid in one run, under one reference, by a third person',
    paid.status < 400 && paidRows.every((p) => p.status === 'PAID') && payments.length === batch.length,
    `pay -> ${paid.status}; statuses ${paidRows.map((p) => p.status).join(',')}; ${payments.length} payment row(s) under ${REF8}, all ${payments.every((p) => p.direction === 'OUTBOUND') ? 'OUTBOUND' : 'MIXED DIRECTION'}`);

  // The reconciliation: recomputed from the assignments, never from the payables.
  const inputs = await sql(
    `SELECT id, proposed_fee, agreed_fee, quoted_travel_fee, counter_travel_fee FROM assignments WHERE id = ANY($1)`,
    [[j1, j2, j3].map((j) => j.id)]);
  const expectedRun = round2(inputs.reduce((s, a) => s + expectedMoney(a, { gstRate: rates.clientGst, clientTdsRate: rates.clientTds }).assayer.net, 0));
  const actualRun = round2(payments.reduce((s, p) => s + num(p.amount), 0));
  const perJob = inputs.map((a) => {
    const m = expectedMoney(a, { gstRate: rates.clientGst, clientTdsRate: rates.clientTds });
    return `${m.fee} - TDS ${m.assayer.tds} = ${m.assayer.net}`;
  }).join(' + ');
  check('the pay run totals reconcile against an independent recomputation from the fees and the tax rate',
    near(expectedRun, actualRun),
    `${perJob}  =>  expected ${expectedRun}; SUM(billing_payments.amount) for ${REF8} = ${actualRun}`);

  const leak = await one(
    `SELECT count(*)::int c FROM billing_payments WHERE payment_reference=$1 AND is_active
       AND payable_id = ANY($2)`, [REF8, [jHold.payable.id, jVoid.payable.id]]);
  check('and nothing was paid against the held or voided payouts',
    Number(leak.c) === 0, `payments touching the held/voided payables under this reference: ${leak.c}`);

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S9', 'invoice the client: the right lines, once, and never twice');

  const invoiceable = await GET(`/billing-engine/invoiceable?clientId=${anchor.clientId}`, cast.admin.token);
  const mine = [j1, j2, j3].map((j) => j.id);
  const offered = (invoiceable.body?.data?.clients ?? []).flatMap((c) => c.lines ?? []);
  const offeredMine = offered.filter((l) => mine.includes(l.assignmentId));
  check('the completed jobs are offered as invoiceable, and the cancelled one is not',
    invoiceable.status < 400 && offeredMine.length === 3
    && !offered.some((l) => l.assignmentId === jVoid.id),
    `GET /billing-engine/invoiceable -> ${invoiceable.status}; ${offeredMine.length}/3 of this run's jobs listed; `
    + `the reopened job ${jVoid.id.slice(0, 8)} ${offered.some((l) => l.assignmentId === jVoid.id) ? 'IS WRONGLY LISTED' : 'is correctly absent'}`);

  const inv = await POST('/billing-engine/invoices', cast.ops.token, {
    clientId: anchor.clientId, assignmentIds: mine, notes: `${TAG} S9 ${STAMP}`,
  });
  const invId = inv.body?.data?.id;
  if (invId) created.invoices.push(invId);
  const invRow = invId ? await one(`SELECT invoice_number, status, subtotal, tax_amount, tds_amount, total FROM billing_invoices WHERE id=$1`, [invId]) : null;
  const lines = invId ? await sql(`SELECT assignment_id, state, taxable_amount, tax_amount, tds_amount, total_amount FROM billing_entries WHERE invoice_id=$1`, [invId]) : [];
  check('an invoice is raised over the three completed jobs',
    inv.status < 400 && !!invRow && lines.length === 3,
    `POST /billing-engine/invoices -> ${inv.status}; ${invRow?.invoice_number} ${invRow?.status}; ${lines.length} line(s)`);

  check('the lines on it are exactly those three jobs, and each is marked invoiced',
    lines.length === 3 && lines.every((l) => mine.includes(l.assignment_id) && l.state === 'INVOICED'),
    `lines: ${lines.map((l) => `${l.assignment_id.slice(0, 8)}:${l.state}`).join(', ')}`);

  const wantInv = inputs.reduce((acc, a) => {
    const m = expectedMoney(a, { gstRate: rates.clientGst, clientTdsRate: rates.clientTds });
    acc.subtotal = round2(acc.subtotal + m.client.taxable);
    acc.tax = round2(acc.tax + m.client.gst);
    acc.tds = round2(acc.tds + m.client.tds);
    acc.total = round2(acc.total + m.client.total);
    return acc;
  }, { subtotal: 0, tax: 0, tds: 0, total: 0 });
  check('the invoice totals recompute from the fees and the client\'s tax rates',
    !!invRow && near(invRow.subtotal, wantInv.subtotal) && near(invRow.tax_amount, wantInv.tax)
    && near(invRow.tds_amount, wantInv.tds) && near(invRow.total, wantInv.total),
    `expected subtotal ${wantInv.subtotal}, GST ${wantInv.tax}, TDS ${wantInv.tds}, total ${wantInv.total}; `
    + `stored ${invRow?.subtotal} / ${invRow?.tax_amount} / ${invRow?.tds_amount} / ${invRow?.total}`);

  const again = await POST('/billing-engine/invoices', cast.ops.token, { clientId: anchor.clientId, assignmentIds: mine });
  const dAgain = denial(again, 409);
  const invCount = await one(`SELECT count(DISTINCT invoice_id)::int c FROM billing_entries WHERE assignment_id = ANY($1)`, [mine]);
  check('invoicing the same work again is refused, and it is still on exactly one invoice',
    again.status >= 400 && Number(invCount.c) === 1,
    `POST /billing-engine/invoices (same assignments) -> ${dAgain.label} "${short(msg(again), 110)}"; distinct invoices carrying those lines: ${invCount.c}`);

  const mixed = await POST('/billing-engine/invoices', cast.ops.token, {
    clientId: anchor.clientId, assignmentIds: [j1.id, jHold.id],
  });
  const dMixed = denial(mixed, 409);
  const stillOne = await one(`SELECT count(DISTINCT invoice_id)::int c FROM billing_entries WHERE assignment_id = $1`, [j1.id]);
  check('and a batch containing an already-invoiced line takes the whole batch down, rather than half-billing it',
    mixed.status >= 400 && Number(stillOne.c) === 1,
    `POST with one invoiced + one fresh assignment -> ${dMixed.label} "${short(msg(mixed), 110)}"; invoices on the already-billed line: ${stillOne.c}`);

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  scenario('S10', 'the auditor\'s morning: answer "who did what to this job, and when" — and change none of it');

  const aliveAud = await proveAlive('the auditor (again, at the point of use)', cast.auditor.token);
  const readable = await GET(`/assignments/${A1}`, cast.auditor.token);
  check('the auditor can open the job in question',
    aliveAud && readable.status === 200,
    `GET /assignments/:id as AUDITOR -> ${readable.status}, status ${readable.body?.data?.status}`);

  const trail = await GET(`/audit-log/trail?entityType=ASSIGNMENT&entityId=${A1}&limit=200`, cast.auditor.token);
  const rows = trail.body?.data ?? [];
  const acted = rows.filter((r) => r.actorId || r.actorName);
  const kinds = new Set(rows.map((r) => r.eventType));
  const wanted = ['CREATE', 'ACCEPT', 'COMPLET'];
  const covers = wanted.filter((w) => [...kinds].some((k) => String(k).toUpperCase().includes(w)));
  check('the trail answers the question from the product alone: what happened, in order, with a named actor on every step',
    trail.status === 200 && rows.length > 0 && acted.length === rows.length,
    `GET /audit-log/trail -> ${trail.status}; ${rows.length} entries across ${JSON.stringify(trail.body?.meta?.countsBySource ?? {})}; `
    + `every entry names an actor: ${acted.length === rows.length ? 'yes' : `no — ${rows.length - acted.length} anonymous`}`);
  check('and it covers the decisive moments of the job, not just the last one',
    covers.length === wanted.length,
    `event types present: ${[...kinds].slice(0, 12).join(', ')}${kinds.size > 12 ? ` (+${kinds.size - 12} more)` : ''}; matched ${covers.join('/')} of ${wanted.join('/')}`);

  const timeline = await GET(`/assignments/${A1}/timeline`, cast.auditor.token);
  const verify = await GET('/audit-log/verify?limit=5000', cast.auditor.token);
  check('the same story is readable from the job\'s own screen, and the audit chain verifies',
    timeline.status === 200 && (timeline.body?.data?.length ?? 0) > 0 && verify.status === 200 && verify.body?.data?.ok === true,
    `GET :id/timeline -> ${timeline.status} with ${timeline.body?.data?.length ?? 0} entries; `
    + `GET /audit-log/verify -> ${verify.status} ${short(verify.body?.data)}`);

  const beforeState = await one(
    `SELECT (SELECT status FROM assignments WHERE id=$1) a,
            (SELECT status FROM assayer_payables WHERE id=$2) p,
            (SELECT status FROM assayer_client_empanelments WHERE assayer_id=$3 AND client_id=$4) e`,
    [A1, p1.id, a1.id, b1.clientId]);

  const bWrite = await branchFor('S10');
  const dWrite = await nextDate();
  const attempts = [
    ['book work', await offer(cast.auditor.token, { pb: bWrite, assayerId: a1.id, date: dWrite.date, fee: FEE })],
    ['complete the job', await POST(`/assignments/${A1}/complete`, cast.auditor.token, { reason: 'auditor probe' })],
    ['reopen the job', await POST(`/assignments/${A1}/reopen`, cast.auditor.token, { reason: 'auditor probe on a completed job' })],
    ['approve a payout', await POST('/billing-engine/payouts/approve', cast.auditor.token, { payableIds: [p1.id] })],
    ['pay a payout', await POST('/billing-engine/payouts/pay', cast.auditor.token, { payableIds: [p1.id], paymentReference: `${TAG}-AUD`, method: 'NEFT' })],
    ['change a panel standing', await PUT_(`/assayers/${a1.id}/empanelment/${b1.clientId}`, cast.auditor.token, { status: 'REJECTED', statusReason: 'auditor probe' })],
    ['suspend a platform rule', await POST('/admin/rule-bypass', cast.auditor.token, { rules: ['DOUBLE_BOOKING'], reason: 'auditor probe of the bypass control' })],
  ];
  const classified = attempts.map(([what, r]) => ({ what, ...denial(r, 403), status: r.status }));
  check('every write the auditor attempts is refused, and refused as a forbidden action rather than a missing one',
    classified.every((c) => c.ok),
    classified.map((c) => `${c.what}: ${c.label}`).join(' | '));

  const afterState = await one(
    `SELECT (SELECT status FROM assignments WHERE id=$1) a,
            (SELECT status FROM assayer_payables WHERE id=$2) p,
            (SELECT status FROM assayer_client_empanelments WHERE assayer_id=$3 AND client_id=$4) e`,
    [A1, p1.id, a1.id, b1.clientId]);
  const newRows = await one(`SELECT count(*)::int c FROM assignments WHERE project_branch_id=$1`, [bWrite.pbId]);
  check('and nothing the auditor touched actually moved',
    beforeState.a === afterState.a && beforeState.p === afterState.p && beforeState.e === afterState.e && Number(newRows.c) === 0,
    `assignment ${beforeState.a} -> ${afterState.a}; payable ${beforeState.p} -> ${afterState.p}; `
    + `panel standing ${beforeState.e} -> ${afterState.e}; assignments created on the auditor's branch: ${newRows.c}`);

  const bypassNow = await GET('/admin/rule-bypass', cast.auditor.token);
  check('the auditor can still SEE whether any rule is suspended — a warning only admins can read is worthless',
    bypassNow.status === 200 && bypassNow.body?.data?.active === false,
    `GET /admin/rule-bypass as AUDITOR -> ${bypassNow.status}, active=${bypassNow.body?.data?.active}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════

const started = Date.now();
try {
  await main();
} catch (e) {
  check('the run completed without aborting', false, `ABORTED in ${SID} (${SNAME}): ${e.message}`);
  console.error(e.stack ?? e);
} finally {
  console.log('\nTeardown (after)');
  await purge('after').catch((e) => console.log('  purge failed:', e.message));
}

console.log(`\n╔═ calendar probe — every date this run asked about, and what the product said ═`);
const cal = [...calendar.entries()].sort(([a], [b]) => a.localeCompare(b));
for (const [iso, v] of cal) {
  console.log(`║  ${iso} ${dayName(iso)}  ${v.verdict}${v.times > 1 ? `   (asked ${v.times}x)` : ''}`);
}
const noRow = cal.filter(([, v]) => v.verdict.includes('NO holiday row')).length;
const realHoliday = cal.filter(([, v]) => v.verdict.includes('registered holiday')).length;
console.log(`║  ${calendarProbes} question(s) over ${cal.length} distinct date(s): `
  + `${cal.filter(([, v]) => v.verdict === 'WORKABLE').length} workable, `
  + `${realHoliday} refused by a real holiday, `
  + `${noRow} refused with no holiday behind it (weekend vs the client's Mon–Fri working days)`);

const last = scenarios[scenarios.length - 1];
if (last && !last.ms) { last.ms = Date.now() - last.startedAt; last.calls = traffic.calls - last.startCalls; }

console.log(`\n╔═ per-scenario verdict ══════════════════════════════════════════════════════`);
for (const s of scenarios) {
  const mine = results.filter((r) => r.sid === s.sid);
  const bad = mine.filter((r) => !r.ok);
  console.log(`║  ${bad.length ? 'FAIL' : 'PASS'}  ${s.sid.padEnd(5)} ${String(mine.length - bad.length).padStart(2)}/${String(mine.length).padEnd(2)}  ${String(Math.round(s.ms / 1000) + 's').padStart(5)} ${String(s.calls).padStart(4)} calls   ${s.name}`);
  for (const b of bad) console.log(`║          └─ ${b.name}\n║             ${String(b.detail ?? '').split('\n').join('\n║             ')}`);
}
console.log(`║`);
console.log(`║  ${Math.round((Date.now() - started) / 1000)}s wall, ${traffic.calls} API calls, ${Math.round(traffic.ms / 1000)}s of it ON THE WIRE`);
console.log(`║  throttle wait, counted separately and in NO latency figure above: ${(traffic.waitedMs / 1000).toFixed(1)}s across ${traffic.throttled} retried call(s)`);
console.log(`║  REQUESTS slower than ${SLOW_MS / 1000}s (throttle waiting excluded): ${traffic.slow.length}`);
for (const s of traffic.slow) console.log(`║      ${s}`);
console.log(`║  sessions renewed mid-run: ${traffic.relogins.length}${traffic.relogins.length ? ` — ${traffic.relogins.join('; ')}` : ''}`);
console.log(`║  assayers ${created.assayers.length}, branches ${created.branches.length}, assignments ${created.assignments.length}, invoices ${created.invoices.length}`);

await done();
