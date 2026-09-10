#!/usr/bin/env node
/**
 * FAPOMS product acceptance — the messy reality.
 *
 * The other probes in this directory drive the product the way the product expects to be driven.
 * This one drives it the way the world actually does: with facts missing, numbers sitting exactly
 * on a boundary, names that are not ASCII, dates that cannot both be true, and the same button
 * pressed twice at once from two phones on a train.
 *
 * Two themes:
 *
 *   A. Incomplete, uncertain and contradictory data. For each hole in the input the question is
 *      only ever one of two things — does the product refuse and NAME what is missing, or does it
 *      accept and produce a quietly wrong number later? A refusal is not automatically the right
 *      answer: refusing a legitimate unicode name is a defect of the same family.
 *
 *   B. Duplicate, stale and concurrent action on every critical mutation. Send it twice, send it
 *      with a version that has moved on, send it three times at once. Exactly one business effect
 *      must exist afterwards, and the row must be read back to prove it. Where an endpoint offers
 *      no concurrency control at all, that absence is itself the finding.
 *
 * Every check reads the database back. A 4xx that nonetheless mutated is a failure; a 2xx that
 * silently did nothing is a failure too.
 *
 * Self-provisioning and re-runnable: it brings its own client, projects, branches and people,
 * prefixed `MESSY-<stamp>`, and removes them children-first at the end. It never writes to
 * `audit_events` — the audit trail is evidence, and a probe that edits evidence has cost more
 * than it found (see docs/incident-2026-09-09-audit-truncate.md).
 *
 *   AC_API=http://127.0.0.1:8080/api/v1 AC_PASSWORD=... \
 *   DB_HOST=127.0.0.1 DB_PORT=55432 DB_USERNAME=fapoms DB_PASSWORD=... DB_DATABASE=fapoms \
 *   node scripts/acceptance/messy-reality.mjs
 *
 * `MESSY_KEEP=1` skips the teardown when you want to go and look at what it left behind.
 */
import { createRequire } from 'node:module';
// `pg` lives in the workspace, not beside this script.
const require = createRequire(
  (process.env.AC_REPO || '/Users/deepstacker/WorkSpace/dupcq/gssAutomation') + '/package.json');
const { Client } = require('pg');

const API = process.env.AC_API || 'http://127.0.0.1:8080/api/v1';
const PW = process.env.AC_PASSWORD;
const KEEP = process.env.MESSY_KEEP === '1';
const DBC = {
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 55432),
  user: process.env.DB_USERNAME || 'fapoms', password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
};
if (!PW) throw new Error('AC_PASSWORD is required — nothing in this script works without it.');

// ── plumbing ──────────────────────────────────────────────────────────────────────────────────
let db;
const results = [];
const notes = [];
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await q(sql, p))[0] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const clip = (s, n = 110) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/**
 * PASS / FAIL / UNKNOWN.
 *
 * UNKNOWN exists because a 429 is the rig's brake, not the product's answer — see `call`. It is
 * reported separately and never counted as either a pass or a denial.
 */
const check = (id, ok, detail) => {
  const state = ok === 'UNKNOWN' ? 'UNKNOWN' : ok ? 'PASS' : 'FAIL';
  results.push({ id, state, detail });
  console.log(`  ${state.padEnd(7)} [${id}] ${detail}`);
};
const note = (id, detail) => { notes.push({ id, detail }); console.log(`  NOTE    [${id}] ${detail}`); };

/**
 * One HTTP call. A 429 is retried once and then surfaces as `throttled`, which every caller turns
 * into UNKNOWN rather than into "the product refused me".
 */
const call = async (token, method, path, body, attempt = 0) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const out = { status: res.status, body: await res.json().catch(() => null) };
  if (out.status === 429) {
    if (attempt === 0) { await sleep(3000); return call(token, method, path, body, 1); }
    out.throttled = true;
  }
  return out;
};
/** The message a refusal actually put in front of the operator, wherever the envelope put it. */
const msg = (r) => String(r?.body?.message ?? r?.body?.error ?? r?.body?.data?.message ?? '');
const okish = (r) => r.status >= 200 && r.status < 300;

/**
 * `POST /auth/login` carries its own brake — 20 a minute per IP, far tighter than the 300 the rest
 * of the API allows — and this rig is shared. A 429 on the way in is the brake, never a bad
 * password, so it is waited out rather than reported.
 */
const login = async (username, password) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await call(null, 'POST', '/auth/login', { username, password });
    if (r.status !== 429) return r;
    console.log(`  (login for ${username} throttled — the shared rig's 20/min brake; waiting)`);
    await sleep(15000);
  }
  return { status: 429, throttled: true, body: null };
};

const signIn = async (username, seedPw, changePath) => {
  let r = await login(username, PW);
  if (!r.body?.data?.accessToken) {
    r = await login(username, seedPw);
    if (!r.body?.data?.accessToken) throw new Error(`cannot sign in ${username}: HTTP ${r.status}`);
    await call(r.body.data.accessToken, 'POST', changePath, { currentPassword: seedPw, newPassword: PW });
    r = await login(username, PW);
  }
  if (!r.body?.data?.accessToken) throw new Error(`cannot sign in ${username} after rotation`);
  return { token: r.body.data.accessToken, id: r.body.data.user.id, username };
};

/** Great-circle km, the same arithmetic the routing fallback uses, to 2 dp. */
const haversineKm = (aLat, aLng, bLat, bLng) => {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat); const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return parseFloat((2 * R * Math.asin(Math.sqrt(h))).toFixed(2));
};

/** Weekdays only — every client in the estate contracts Mon–Fri, so a Saturday is refused. */
const weekdayDates = (count, fromOffset = 0) => {
  const out = []; const d = new Date();
  d.setDate(d.getDate() + fromOffset);
  while (out.length < count) {
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
};

// ── the run ───────────────────────────────────────────────────────────────────────────────────
const stamp = Date.now().toString().slice(-6);
const PREFIX = `MESSY-${stamp}`;
const created = { assayers: [], branches: [], projectBranches: [], projects: [], clients: [], assignments: [] };

(async () => {
  db = new Client(DBC); await db.connect();
  console.log(`\n=== FAPOMS acceptance — the messy reality ===\nAPI ${API}\nprefix ${PREFIX}\n`);

  const admin = await signIn('admin', 'admin123', '/users/me/change-password');
  const admin2 = await signIn('admin2', 'admin123', '/users/me/change-password');
  const exec = await signIn('executive', 'admin123', '/users/me/change-password');

  // ── provisioning ────────────────────────────────────────────────────────────────────────────
  // Cloned from a real branch so the distance and eligibility rules are satisfiable, and given a
  // genuine v4 id: a UUID derived from md5 can land on a version nibble outside 1-5, which
  // `@IsUUID()` rejects outright. Never md5. See final-business-scenario.mjs.
  console.log('provisioning');
  const donor = await one(`SELECT * FROM branches WHERE name='Pune Main Branch' LIMIT 1`);
  if (!donor) throw new Error('no donor branch ("Pune Main Branch") to clone geography from');
  const seedProject = await one(`SELECT * FROM projects ORDER BY created_at LIMIT 1`);
  if (!seedProject) throw new Error('no seeded project to hang project branches on');

  /** A branch of this run's own, optionally with the coordinates struck out. */
  const makeBranch = async (label, { geo = true } = {}) => {
    const row = await one(
      `INSERT INTO branches (id, version, sol_id, name, address, state, district, city, pincode, region,
         latitude, longitude, is_active, organization_id, client_id, created_at, updated_at, created_by, updated_by)
       VALUES (gen_random_uuid(), 1, $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, true, $11, $12, now(), now(), 'acceptance', 'acceptance')
       RETURNING id, latitude, longitude`,
      [`${PREFIX}-${label}`.slice(0, 40), `${PREFIX} ${label}`, donor.address, donor.state, donor.district,
        donor.city, donor.pincode, donor.region, geo ? donor.latitude : null, geo ? donor.longitude : null,
        donor.organization_id, donor.client_id]);
    created.branches.push(row.id);
    return row;
  };
  const makeProjectBranch = async (projectId, branchId) => {
    const row = await one(
      `INSERT INTO project_branches (id, version, project_id, branch_id, status, is_active, created_at, updated_at, created_by, updated_by)
       VALUES (gen_random_uuid(), 1, $1, $2, 'PLANNING', true, now(), now(), 'acceptance', 'acceptance')
       RETURNING id, branch_id`, [projectId, branchId]);
    created.projectBranches.push(row.id);
    return row;
  };

  // A client with no rate card at all: no `client_configurations` row, no `client_billing` row.
  // Nothing about it is malformed — it is a contract that has not been priced yet, which is the
  // ordinary state of a client on the day it is signed.
  const bareClient = await one(
    `INSERT INTO clients (id, version, is_active, client_code, name, display_name, client_type,
       lifecycle_status, priority, organization_id, planning_preferences, created_at, updated_at, created_by, updated_by)
     SELECT gen_random_uuid(), 1, true, $1, $2, $2, c.client_type, c.lifecycle_status, c.priority,
            c.organization_id, '{}'::jsonb, now(), now(), 'acceptance', 'acceptance'
       FROM clients c WHERE c.client_code='SBI' LIMIT 1
     RETURNING id`, [`${PREFIX}-C`.slice(0, 20), `${PREFIX} Unpriced Client`]);
  created.clients.push(bareClient.id);

  const makeProject = async (label, clientId, startDate, endDate) => {
    const row = await one(
      `INSERT INTO projects (id, version, is_active, project_number, name, client_id, status, priority,
         start_date, end_date, organization_id, created_at, updated_at, created_by, updated_by)
       SELECT gen_random_uuid(), 1, true, $1, $2, $3, p.status, p.priority, $4::date, $5::date,
              p.organization_id, now(), now(), 'acceptance', 'acceptance'
         FROM projects p ORDER BY p.created_at LIMIT 1
       RETURNING id`, [`${PREFIX}-${label}`.slice(0, 40), `${PREFIX} ${label}`, clientId, startDate, endDate]);
    created.projects.push(row.id);
    return row;
  };
  const past = new Date(Date.now() - 86400000 * 30).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 86400000 * 365).toISOString().slice(0, 10);
  const bareProject = await makeProject('UNPRICED', bareClient.id, past, future);

  const pool = [];
  for (let i = 0; i < 16; i++) pool.push(await makeProjectBranch(seedProject.id, (await makeBranch(`B${i}`)).id));
  const noGeoBranch = await makeBranch('NOGEO', { geo: false });
  const noGeoPb = await makeProjectBranch(seedProject.id, noGeoBranch.id);
  const barePbs = [];
  for (let i = 0; i < 4; i++) barePbs.push(await makeProjectBranch(bareProject.id, (await makeBranch(`U${i}`)).id));
  let poolAt = 0;
  const takePb = () => { const pb = pool[poolAt++]; if (!pb) throw new Error('ran out of provisioned branches'); return pb; };
  console.log(`  ${created.branches.length} branches, ${created.projectBranches.length} project branches, 2 projects, 1 unpriced client\n`);

  // ── the people ──────────────────────────────────────────────────────────────────────────────
  let personIndex = 0;
  const makePerson = async (label, extra = {}) => {
    const i = personIndex++;
    const r = await call(admin.token, 'POST', '/assayers', {
      fullName: `${PREFIX} ${label}`,
      state: 'MAHARASHTRA', district: 'Pune', city: 'Pune', address: 'Acceptance Address, Pune',
      phone: `9${stamp}${String(i).padStart(3, '0')}`.slice(0, 10),
      email: `messy.${stamp}.${i}@acceptance.invalid`,
      joiningDate: '2026-01-01',
      ...extra,
    });
    if (r.status >= 400) return { failed: r };
    created.assayers.push(r.body.data.id);
    return { id: r.body.data.id, code: r.body.data.assayerCode ?? null, res: r };
  };
  const move = (token, id, to, reason) => call(token, 'POST', `/assayers/${id}/lifecycle`,
    reason === undefined ? { targetStatus: to } : { targetStatus: to, reason });
  const activate = async (id) => {
    for (const s of ['DOCUMENT_VERIFICATION', 'BACKGROUND_VERIFICATION', 'TRAINING', 'ACTIVE']) {
      const r = await move(admin.token, id, s);
      if (r.status >= 400) return r;
    }
    return { status: 200 };
  };

  const PM = await makePerson('Main');           // complete: bank + PAN
  const PN = await makePerson('NoBank');         // no bank details, ever
  const PP = await makePerson('NoPan');          // bank, but no PAN
  const PI = await makePerson('Invited');        // never leaves INVITED
  const PL = await makePerson('Lifecycle');      // lifecycle duplicate/stale/concurrent
  const PE = await makePerson('Empanel');        // empanelment duplicate/stale/concurrent
  for (const p of [PM, PN, PP, PI, PL, PE]) {
    if (p.failed) throw new Error(`could not provision a person: ${JSON.stringify(p.failed.body)}`);
  }
  await call(admin.token, 'PUT', `/assayers/${PM.id}`, {
    bankAccountNumber: '50100111222333', ifscCode: 'HDFC0001111', bankName: 'HDFC Bank', panNumber: 'ABCPM1234M' });
  await call(admin.token, 'PUT', `/assayers/${PP.id}`, {
    bankAccountNumber: '50100444555666', ifscCode: 'HDFC0002222', bankName: 'HDFC Bank' });
  for (const p of [PM, PN, PP, PL]) {
    const r = await activate(p.id);
    if (r.status >= 400) throw new Error(`could not activate ${p.id}: ${clip(msg(r))}`);
  }
  const SBI = seedProject.client_id;
  for (const p of [PM, PN, PP, PL]) {
    await call(admin.token, 'PUT', `/assayers/${p.id}/empanelment/${SBI}`, { status: 'ACTIVE' });
  }
  await call(admin.token, 'PUT', `/assayers/${PM.id}/empanelment/${bareClient.id}`, { status: 'ACTIVE' });

  // The field app's own credentials, so accept and check-in are exercised by the person who owns
  // the work rather than by an operator standing in for them.
  const pmRow = await one(`SELECT assayer_code, latitude, longitude FROM assayers WHERE id=$1`, [PM.id]);
  let pmToken = null;
  {
    const access = await call(admin.token, 'POST', `/assayers/${PM.id}/app-access`, {});
    const temp = access.body?.data?.temporaryPassword ?? access.body?.data?.password;
    if (temp) {
      let l = await login(pmRow.assayer_code, temp);
      if (l.body?.data?.accessToken) {
        await call(l.body.data.accessToken, 'POST', '/assayers/me/change-password',
          { currentPassword: temp, newPassword: PW });
        l = await login(pmRow.assayer_code, PW);
        pmToken = l.body?.data?.accessToken ?? null;
      }
    }
  }
  if (!pmToken) throw new Error('could not issue app access to the main person — the accept path cannot be probed');

  const today = weekdayDates(1)[0];
  const DAY = weekdayDates(12, 1);

  /** Create, and hand back both the answer and whether a row actually landed. */
  const createAssignment = async (token, body) => {
    const r = await call(token, 'POST', '/assignments', body);
    const id = r.body?.data?.id ?? null;
    if (id) created.assignments.push(id);
    const rows = await q(
      `SELECT id, status, proposed_fee, agreed_fee, quoted_distance_km, quoted_distance_source,
              quoted_base_fee, quoted_travel_fee, entity_version
         FROM assignments WHERE project_branch_id=$1 AND is_active`, [body.projectBranchId]);
    return { r, id, rows };
  };
  const cancel = (id, why) => call(exec.token, 'POST', `/assignments/${id}/cancel`,
    { reason: `Acceptance probe: ${why}` });
  /**
   * Take an assignment all the way to a booked payable.
   *
   * Called as soon as each probe assignment is created rather than at the end, because an open
   * offer holds the assayer's whole day — `DAY_EXCLUSIVE_ASSIGNMENT_STATUSES` — and a probe left
   * PENDING would refuse every later booking for that person as a double booking.
   */
  const drive = async (id, { assayerToken = null } = {}) => {
    const st = await one(`SELECT status FROM assignments WHERE id=$1`, [id]);
    if (st?.status === 'PENDING') {
      if (assayerToken) await call(assayerToken, 'POST', `/assignments/${id}/accept`, {});
      else await call(admin.token, 'POST', `/assignments/${id}/transition`, { status: 'ACCEPTED' });
    }
    const geo = { latitude: Number(donor.latitude), longitude: Number(donor.longitude), accuracy: 8 };
    await call(assayerToken ?? exec.token, 'POST', `/assignments/${id}/check-in`, geo);
    const done = await call(exec.token, 'POST', `/assignments/${id}/complete`,
      { reason: 'Acceptance probe: field work finished.' });
    return done;
  };
  /**
   * Close anything this run left open.
   *
   * An offer that is still PENDING holds its assayer's whole day, so a probe that was expected to
   * be refused and was not would otherwise poison every later booking with a double-booking 400
   * that looks nothing like the defect that caused it. Called between sections so a surprise stays
   * a single failed check.
   */
  const clearOpen = async () => {
    const open = await q(
      `SELECT id FROM assignments WHERE remarks LIKE $1 AND is_active
          AND status IN ('PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS')`, [`${PREFIX}%`]);
    for (const o of open) await cancel(o.id, 'clearing work an earlier probe left open');
    if (open.length) note('housekeeping', `${open.length} assignment(s) from an earlier probe were still open and were cancelled`);
  };

  const awaitPayable = async (assignmentId, budgetMs = 90000) => {
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      const rows = await q(`SELECT * FROM assayer_payables WHERE assignment_id=$1`, [assignmentId]);
      if (rows.length) return rows;
      await sleep(2500);
    }
    return [];
  };

  // ══ THEME A — incomplete, uncertain and contradictory data ═══════════════════════════════════
  console.log('\nA1 — work created with information genuinely missing');

  // A1a. No assayer available to do it: named person is still INVITED, and a named person who
  // does not exist at all.
  {
    const pb = takePb();
    const invited = await createAssignment(exec.token, {
      projectBranchId: pb.id, assayerId: PI.id, proposedFee: 1500, scheduledDate: today,
      remarks: `${PREFIX} invited-target` });
    check('A1a-i', invited.r.throttled ? 'UNKNOWN'
      : invited.r.status >= 400 && invited.rows.length === 0
        && /must be ACTIVE|invited|onboard|lifecycle|eligib/i.test(msg(invited.r)),
      `booking a person who has never been onboarded is refused and nothing lands `
      + `(HTTP ${invited.r.status}, rows ${invited.rows.length}) — "${clip(msg(invited.r), 90)}"`);
    if (/INACTIVE/.test(msg(invited.r))) {
      const real = await one(`SELECT lifecycle_status, status FROM assayers WHERE id=$1`, [PI.id]);
      note('A1a-wording', `the refusal calls this person "${real.status}" while their lifecycle record says `
        + `"${real.lifecycle_status}" — an operator told INACTIVE will look for a reactivate button that `
        + `an INVITED person does not have`);
    }

    const ghost = await createAssignment(exec.token, {
      projectBranchId: pb.id, assayerId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', proposedFee: 1500,
      scheduledDate: today, remarks: `${PREFIX} ghost-target` });
    check('A1a-ii', ghost.r.throttled ? 'UNKNOWN' : ghost.r.status === 404 && ghost.rows.length === 0,
      `an assayer id that does not exist is a 404, not a 500 (HTTP ${ghost.r.status}) — "${clip(msg(ghost.r), 80)}"`);
  }

  // A1d. A branch with no coordinates. Distance and therefore travel cannot be computed; the
  // question is whether the offer says so or quietly prices the journey at zero.
  let noGeoAssignmentId = null;
  {
    const g = await createAssignment(exec.token, {
      projectBranchId: noGeoPb.id, assayerId: PM.id, scheduledDate: today,
      remarks: `${PREFIX} nogeo` });
    noGeoAssignmentId = g.id;
    if (g.id) await drive(g.id, { assayerToken: pmToken });
    const row = g.rows[0];
    // The question is not "is travel zero" — on this rig's rate card it is zero either way — but
    // whether the record can ever say the journey was never measured. `quoted_distance_source`
    // exists precisely to distinguish a routed distance from an estimated one; a branch with no
    // coordinates produces neither, and nothing anywhere says so.
    const silentlyUnmeasured = okish(g.r) && row
      && row.quoted_distance_km === null && row.quoted_distance_source === null;
    check('A1d', g.r.throttled ? 'UNKNOWN' : g.r.status >= 400 || !silentlyUnmeasured,
      silentlyUnmeasured
        ? `ACCEPTED against a branch with no coordinates: quoted_distance_km NULL and `
          + `quoted_distance_source NULL, fee ₹${row.proposed_fee} — the offer cannot tell an unmeasurable `
          + `journey from a measured one of zero km`
        : `a branch with no coordinates is handled explicitly (HTTP ${g.r.status}, distance `
          + `${row?.quoted_distance_km ?? 'NULL'}, source ${row?.quoted_distance_source ?? 'NULL'})`);
    if (silentlyUnmeasured) {
      note('A1d-signal', `the create response mentions the missing geography: `
        + `${/coordinat|latitude|location/i.test(JSON.stringify(g.r.body ?? {}))}`);
    }
  }

  // A1e. A client with no rate card: the fee silently comes from platform defaults.
  let bareAssignmentId = null;
  {
    const rates = await call(admin.token, 'GET', `/pricing/rates?clientId=${bareClient.id}`);
    const rd = rates.body?.data ?? rates.body ?? {};
    const unconfigured = rd.clientConfigured === false;
    const seeded = await call(admin.token, 'GET', `/pricing/rates?clientId=${seedProject.client_id}`);
    const sd = seeded.body?.data ?? seeded.body ?? {};
    note('A1e-rates', `unpriced client: base ₹${rd.defaultBaseFee} travel ₹${rd.travelFeePerKm}/km free `
      + `${rd.freeTravelAllowanceKm} km (clientConfigured=${rd.clientConfigured}, baseFeeFromClient=${rd.baseFeeFromClient}); `
      + `the seeded contracted client: base ₹${sd.defaultBaseFee} travel ₹${sd.travelFeePerKm}/km free `
      + `${sd.freeTravelAllowanceKm} km (clientConfigured=${sd.clientConfigured}, baseFeeFromClient=${sd.baseFeeFromClient})`);
    const g = await createAssignment(exec.token, {
      projectBranchId: barePbs[0].id, assayerId: PM.id, scheduledDate: today,
      remarks: `${PREFIX} unpriced-client` });
    bareAssignmentId = g.id;
    if (g.id) await drive(g.id, { assayerToken: pmToken });
    const row = g.rows[0];
    check('A1e', g.r.throttled ? 'UNKNOWN' : okish(g.r) && unconfigured,
      okish(g.r)
        ? `an unpriced client is quoted anyway from platform defaults (clientConfigured=${unconfigured ? 'false' : '?'}, fee ₹${row?.proposed_fee}) — the offer itself records no source`
        : `an unpriced client is refused at assignment time (HTTP ${g.r.status}) — "${clip(msg(g.r), 80)}"`);
  }

  console.log('\nA2 — boundary and degenerate values on money, distance and project windows');

  // What the contract actually says this job is worth, learned from the product rather than
  // assumed: create with no fee at all, read the quote it froze, then take the branch back.
  let QUOTE = null;
  {
    const pb = takePb();
    const g = await createAssignment(exec.token, {
      projectBranchId: pb.id, assayerId: PM.id, scheduledDate: today, remarks: `${PREFIX} quote-probe` });
    QUOTE = g.rows[0] ? Number(g.rows[0].proposed_fee) : null;
    if (g.id) await cancel(g.id, 'quote probe, taking the day back');
    note('A2-quote', `the contracted quote for this pairing is ₹${QUOTE} `
      + `(base ₹${g.rows[0]?.quoted_base_fee}, travel ₹${g.rows[0]?.quoted_travel_fee}, `
      + `${g.rows[0]?.quoted_distance_km} km by ${g.rows[0]?.quoted_distance_source})`);
  }
  if (!QUOTE) throw new Error('could not learn the contracted quote — the fee boundary tests have no reference');
  const CEILING = round2(QUOTE * 2);

  // A2a. Zero fee. Legal input (`@Min(0)`), so what matters is what it books later.
  let zeroFeeAssignmentId = null;
  {
    const pb = takePb();
    const g = await createAssignment(exec.token, {
      projectBranchId: pb.id, assayerId: PM.id, proposedFee: 0, scheduledDate: today,
      remarks: `${PREFIX} zero-fee` });
    zeroFeeAssignmentId = g.id;
    check('A2a', g.r.throttled ? 'UNKNOWN' : okish(g.r) && num(g.rows[0]?.proposed_fee) === 0,
      `a fee of exactly zero is accepted and stored as zero (HTTP ${g.r.status}, proposed_fee ${g.rows[0]?.proposed_fee})`);
    if (g.id) await drive(g.id, { assayerToken: pmToken });
  }

  // A2b/c. Exactly the ceiling, and one paisa past it. `> ceiling` is the rule, so the ceiling
  // itself must be accepted and ceiling+0.01 must be refused with the number named.
  {
    const pbEq = takePb();
    const eq = await createAssignment(exec.token, {
      projectBranchId: pbEq.id, assayerId: PM.id, proposedFee: CEILING, scheduledDate: today,
      remarks: `${PREFIX} ceiling-exact` });
    check('A2b', eq.r.throttled ? 'UNKNOWN' : okish(eq.r) && num(eq.rows[0]?.proposed_fee) === CEILING,
      `a fee of exactly twice the quote (₹${CEILING}) is accepted (HTTP ${eq.r.status}, stored ₹${eq.rows[0]?.proposed_fee})`);
    if (eq.id) await cancel(eq.id, 'ceiling boundary probe');

    const pbOver = takePb();
    const over = await createAssignment(exec.token, {
      projectBranchId: pbOver.id, assayerId: PM.id, proposedFee: round2(CEILING + 0.01), scheduledDate: today,
      remarks: `${PREFIX} ceiling-over` });
    check('A2c', over.r.throttled ? 'UNKNOWN'
      : over.r.status === 400 && over.rows.length === 0 && /twice the contracted quote/i.test(msg(over.r)),
      `one paisa over the ceiling (₹${round2(CEILING + 0.01)}) is refused with the ceiling named, nothing lands `
      + `(HTTP ${over.r.status}, rows ${over.rows.length}) — "${clip(msg(over.r), 80)}"`);
  }

  // A2d/e. Distance exactly at the client's ceiling, and one metre over it. The ceiling is moved
  // rather than the geography, because the routing layer rounds to 2 dp and a distance that
  // cannot be stated exactly cannot be sat exactly on. This runs against this run's OWN client so
  // no shared seeded configuration is disturbed.
  {
    const D = haversineKm(Number(pmRow.latitude), Number(pmRow.longitude),
      Number(donor.latitude), Number(donor.longitude));
    const stored = await one(`SELECT quoted_distance_km FROM assignments WHERE id=$1`, [bareAssignmentId]);
    const agreed = stored && Math.abs(Number(stored.quoted_distance_km) - D) < 0.011;
    note('A2-distance', `home-to-branch is ${D} km computed here; the product froze `
      + `${stored?.quoted_distance_km ?? 'NULL'} km on the offer — ${agreed ? 'agreed' : 'DISAGREED'}`);

    const setCeiling = (v) => q(`UPDATE clients SET planning_preferences = jsonb_set(planning_preferences, '{maxDistanceKm}', to_jsonb($2::numeric)) WHERE id=$1`,
      [bareClient.id, v]);

    await setCeiling(D);
    const at = await createAssignment(exec.token, {
      projectBranchId: barePbs[1].id, assayerId: PM.id, scheduledDate: today, remarks: `${PREFIX} dist-at` });
    check('A2d', at.r.throttled ? 'UNKNOWN' : okish(at.r),
      `a distance sitting exactly on the ${D} km ceiling is allowed (HTTP ${at.r.status})`);
    if (at.id) await cancel(at.id, 'distance boundary probe');

    // One metre, not one paisa: `round2` here would erase the very difference under test.
    const oneMetreUnder = Number((D - 0.001).toFixed(3));
    await setCeiling(oneMetreUnder);
    const over = await createAssignment(exec.token, {
      projectBranchId: barePbs[2].id, assayerId: PM.id, scheduledDate: today, remarks: `${PREFIX} dist-over` });
    check('A2e', over.r.throttled ? 'UNKNOWN'
      : over.r.status >= 400 && over.rows.length === 0 && /out of range|limit/i.test(msg(over.r)),
      `one metre past the ceiling (${oneMetreUnder} km) is refused and nothing lands (HTTP ${over.r.status}, code `
      + `${over.r.body?.code ?? '-'}, rows ${over.rows.length}) — "${clip(msg(over.r), 70)}"`);
    if (over.id) await cancel(over.id, 'distance boundary probe that should not have landed');
    await q(`UPDATE clients SET planning_preferences = planning_preferences - 'maxDistanceKm' WHERE id=$1`, [bareClient.id]);
  }

  // A2f/g. A project window of zero length, and one entirely in the past.
  {
    const day = DAY[4];
    const zero = await call(admin.token, 'POST', '/projects', {
      name: `${PREFIX} Zero Window`, clientId: bareClient.id, priority: 'MEDIUM',
      startDate: day, endDate: day });
    const zeroId = zero.body?.data?.id ?? null;
    if (zeroId) created.projects.push(zeroId);
    const zeroRow = zeroId ? await one(
      `SELECT to_char(start_date,'YYYY-MM-DD') start_date, to_char(end_date,'YYYY-MM-DD') end_date
         FROM projects WHERE id=$1`, [zeroId]) : null;
    check('A2f', zero.throttled ? 'UNKNOWN' : okish(zero) && !!zeroRow,
      `a one-day project window is accepted as a real window (HTTP ${zero.status}, stored `
      + `${zeroRow?.start_date}..${zeroRow?.end_date})`);

    const backwards = await call(admin.token, 'POST', '/projects', {
      name: `${PREFIX} Backwards Window`, clientId: bareClient.id, priority: 'MEDIUM',
      startDate: day, endDate: DAY[3] });
    const backwardsRows = await q(`SELECT id FROM projects WHERE name=$1`, [`${PREFIX} Backwards Window`]);
    check('A2f-ii', backwards.throttled ? 'UNKNOWN' : backwards.status === 400 && backwardsRows.length === 0,
      `a window that ends before it starts is refused and no project lands (HTTP ${backwards.status}, rows ${backwardsRows.length})`);

    const pastEnd = new Date(Date.now() - 86400000 * 10).toISOString().slice(0, 10);
    const pastStart = new Date(Date.now() - 86400000 * 40).toISOString().slice(0, 10);
    const pastProj = await call(admin.token, 'POST', '/projects', {
      name: `${PREFIX} Past Window`, clientId: bareClient.id, priority: 'MEDIUM',
      startDate: pastStart, endDate: pastEnd });
    const pastId = pastProj.body?.data?.id ?? null;
    if (pastId) created.projects.push(pastId);
    if (pastId) {
      // Accepting a closed window is defensible (backfilling history). Booking work into it is not.
      const pb = await makeProjectBranch(pastId, (await makeBranch('PASTWIN')).id);
      const g = await createAssignment(exec.token, {
        projectBranchId: pb.id, assayerId: PM.id, scheduledDate: today, remarks: `${PREFIX} past-window` });
      check('A2g', g.r.throttled ? 'UNKNOWN' : g.r.status >= 400 && g.rows.length === 0,
        `a project whose window closed ${pastEnd} cannot be booked into for ${today} `
        + `(HTTP ${g.r.status}, rows ${g.rows.length}) — "${clip(msg(g.r), 80)}"`);
      if (g.id) await cancel(g.id, 'past-window probe');
    } else {
      check('A2g', pastProj.status === 400,
        `a project window entirely in the past is refused at creation (HTTP ${pastProj.status}) — "${clip(msg(pastProj), 80)}"`);
    }
  }

  await clearOpen();
  console.log('\nA3 — text that breaks naive handling');

  /**
   * `display_name` is where an authored `fullName` lands, not `legal_name`.
   *
   * `legal_name` holds the name copied off a VERIFIED identity document, so it stays NULL until
   * somebody has checked a scan against the record. Asserting an authored name against it would
   * fail every person who has not been through KYC yet, which is not what these checks are about.
   */
  const storedName = async (id) =>
    (await one(`SELECT display_name FROM assayers WHERE id=$1`, [id]))?.display_name ?? null;

  // A3a. A legitimate Indian name carrying combining marks. Refusing this is a defect; so is
  // silently normalising it, because the stored name must match the document it was copied from.
  {
    const unicodeName = `Kṛṣṇa Ānand ${stamp}`;
    const p = await makePerson('X', { fullName: unicodeName });
    if (p.failed) {
      check('A3a', false, `a valid unicode name was REFUSED (HTTP ${p.failed.status}) — "${clip(msg(p.failed), 90)}"`);
    } else {
      const stored = await storedName(p.id);
      check('A3a', stored === unicodeName,
        `a name with combining marks round-trips code point for code point `
        + `(sent ${[...unicodeName].length}, stored ${[...(stored ?? '')].length}, identical=${stored === unicodeName}, `
        + `silently-normalised=${stored !== unicodeName && stored === unicodeName.normalize('NFC')})`);
    }
  }

  // A3b. 500 characters, against varchar(200)/varchar(100) columns and a DTO with no MaxLength.
  {
    const longName = 'Aa'.repeat(250);
    const p = await makePerson('L', { fullName: longName });
    const landed = await q(`SELECT id, display_name, first_name FROM assayers WHERE display_name LIKE 'AaAaAa%'`);
    for (const r of landed) if (!created.assayers.includes(r.id)) created.assayers.push(r.id);
    const refusedCleanly = !!p.failed && p.failed.status === 400 && landed.length === 0;
    check('A3b', refusedCleanly,
      refusedCleanly
        ? `a 500-character name is refused with a 400 that names the field, and nothing lands`
        : (p.failed
          ? `a 500-character name answers HTTP ${p.failed.status} — "${clip(msg(p.failed), 90)}" `
            + `(rows landed ${landed.length})`
          : `a 500-character name was ACCEPTED and stored `
            + `(display_name ${landed[0]?.display_name?.length} chars, first_name ${landed[0]?.first_name?.length} chars)`));
  }

  // A3c. Leading and trailing whitespace on the authored name.
  {
    const padded = `  ${PREFIX} Padded  `;
    const p = await makePerson('P', { fullName: padded });
    if (p.failed) {
      check('A3c', false, `a name with surrounding whitespace was refused (HTTP ${p.failed.status})`);
    } else {
      const stored = await storedName(p.id);
      check('A3c', stored === padded.trim(),
        `surrounding whitespace is trimmed before storage (sent ${JSON.stringify(padded)}, stored ${JSON.stringify(stored)})`);
    }
  }

  // A3d. Absent vs null vs empty vs whitespace, on a reason that MUST be given: reversing a
  // client's rejection of an assayer. All four are the same absence and must be refused the same.
  {
    await call(admin.token, 'PUT', `/assayers/${PE.id}/empanelment/${SBI}`,
      { status: 'REJECTED', statusReason: 'Acceptance probe: client declined.' });
    const shapes = [
      ['absent', { status: 'ACTIVE' }],
      ['null', { status: 'ACTIVE', statusReason: null }],
      ['empty', { status: 'ACTIVE', statusReason: '' }],
      ['blanks', { status: 'ACTIVE', statusReason: '          ' }],
    ];
    const answers = [];
    for (const [label, body] of shapes) {
      const r = await call(admin.token, 'PUT', `/assayers/${PE.id}/empanelment/${SBI}`, body);
      const after = await one(`SELECT status FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`, [PE.id, SBI]);
      answers.push({ label, status: r.status, still: after?.status, m: msg(r) });
    }
    const allRefused = answers.every((a) => a.status >= 400 && a.still === 'REJECTED');
    const sameShape = new Set(answers.map((a) => a.status)).size === 1;
    check('A3d', answers.some((a) => a.status === 429) ? 'UNKNOWN' : allRefused && sameShape,
      `absent / null / "" / "   " are one absence, all refused identically and the rejection stands `
      + `(${answers.map((a) => `${a.label}:${a.status}→${a.still}`).join(' ')})`);
    const good = await call(admin.token, 'PUT', `/assayers/${PE.id}/empanelment/${SBI}`,
      { status: 'ACTIVE', statusReason: 'Acceptance probe: client reconsidered after a site visit.' });
    const afterGood = await one(`SELECT status, status_reason FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`, [PE.id, SBI]);
    check('A3d-ii', okish(good) && afterGood?.status === 'ACTIVE' && !!afterGood?.status_reason,
      `a real reason reverses it, and the reason is kept beside the decision (${afterGood?.status})`);
  }

  // A3e. The same three shapes on an OPTIONAL attribute, where the danger is the mirror image:
  // an absent field must not clear a value somebody typed.
  {
    await call(admin.token, 'PUT', `/assayers/${PE.id}`, { notes: 'Acceptance probe: a note worth keeping.' });
    const withNote = await one(`SELECT notes FROM assayers WHERE id=$1`, [PE.id]);
    await call(admin.token, 'PUT', `/assayers/${PE.id}`, { city: 'Pune' });
    const afterAbsent = await one(`SELECT notes FROM assayers WHERE id=$1`, [PE.id]);
    await call(admin.token, 'PUT', `/assayers/${PE.id}`, { notes: '' });
    const afterEmpty = await one(`SELECT notes FROM assayers WHERE id=$1`, [PE.id]);
    await call(admin.token, 'PUT', `/assayers/${PE.id}`, { notes: null });
    const afterNull = await one(`SELECT notes FROM assayers WHERE id=$1`, [PE.id]);
    check('A3e', withNote?.notes === 'Acceptance probe: a note worth keeping.' && afterAbsent?.notes === withNote?.notes,
      `an absent optional field leaves the stored value alone; "" and null are the caller's own erasure `
      + `(absent=${JSON.stringify(clip(afterAbsent?.notes, 24))} empty=${JSON.stringify(afterEmpty?.notes)} null=${JSON.stringify(afterNull?.notes)})`);
  }

  console.log('\nA4 — dates that cannot both be true');

  // A4a. A date of birth in the future.
  {
    const nextYear = new Date(Date.now() + 86400000 * 400).toISOString().slice(0, 10);
    const p = await makePerson('DOBF', { dateOfBirth: nextYear });
    const landed = await q(`SELECT id FROM assayers WHERE legal_name=$1`, [`${PREFIX} DOBF`]);
    for (const r of landed) if (!created.assayers.includes(r.id)) created.assayers.push(r.id);
    check('A4a', !!p.failed && p.failed.status === 400 && landed.length === 0 && /date of birth/i.test(msg(p.failed)),
      `a date of birth in the future is refused, naming the value, and nothing lands `
      + `(HTTP ${p.failed?.status ?? 'created'}, rows ${landed.length}) — "${clip(msg(p.failed ?? {}), 80)}"`);
  }

  // A4b. A joining date before the date of birth — each date is individually plausible.
  {
    const p = await makePerson('DOBJ', { dateOfBirth: '2005-06-01', joiningDate: '2001-01-01' });
    if (p.failed) {
      check('A4b', p.failed.status === 400,
        `joining before being born is refused (HTTP ${p.failed.status}) — "${clip(msg(p.failed), 80)}"`);
    } else {
      const row = await one(
        `SELECT to_char(date_of_birth,'YYYY-MM-DD') dob, to_char(joining_date,'YYYY-MM-DD') joined
           FROM assayers WHERE id=$1`, [p.id]);
      const years = ((new Date(row.joined) - new Date(row.dob)) / 31557600000).toFixed(1);
      check('A4b', false,
        `ACCEPTED: born ${row.dob}, joined ${row.joined} — a person who started work ${Math.abs(years)} years `
        + `BEFORE they were born is on the roster, and every tenure figure derived from the pair is negative`);
    }
  }

  // A4c. A leave that ends before it starts — and what that does to the availability check that
  // reads it. Put on the ACTIVE, empanelled person so the consequence is bookable.
  {
    const dayAt = (offset) => {
      const d = new Date(); d.setDate(d.getDate() + offset);
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const leaveStart = dayAt(40); const leaveEnd = dayAt(25); const inside = dayAt(32);
    const r = await call(admin.token, 'PUT', `/assayers/${PL.id}`,
      { leaves: [{ startDate: leaveStart, endDate: leaveEnd }] });
    const row = await one(`SELECT leaves FROM assayers WHERE id=$1`, [PL.id]);
    const stored = Array.isArray(row?.leaves) ? row.leaves : [];
    const landed = stored.some((l) => l.startDate === leaveStart && l.endDate === leaveEnd);
    check('A4c', r.throttled ? 'UNKNOWN' : r.status >= 400 && !landed,
      landed
        ? `ACCEPTED (HTTP ${r.status}): a leave from ${leaveStart} to ${leaveEnd} is stored verbatim — `
          + `a window of minus fifteen days, and every availability check now reads it`
        : `a leave that ends before it starts is refused (HTTP ${r.status}) — "${clip(msg(r), 70)}"`);
    if (landed) {
      const pb = takePb();
      const g = await createAssignment(exec.token, {
        projectBranchId: pb.id, assayerId: PL.id, proposedFee: 1200, scheduledDate: inside,
        remarks: `${PREFIX} inverted-leave` });
      check('A4c-ii', false,
        `and booking ${inside}, a date inside the dates the clerk meant, is `
        + `${okish(g.r) ? 'ALLOWED' : `refused (${clip(msg(g.r), 50)})`} — the leave the clerk thought they `
        + `had recorded protects nothing`);
      if (g.id) await cancel(g.id, 'inverted-leave consequence probe');
    }
    await call(admin.token, 'PUT', `/assayers/${PL.id}`, { leaves: [] });
  }

  // A4d. A check-in claiming a moment before the assignment existed. The device clock is the
  // caller's; the attendance record is the bank's evidence.
  {
    const pb = takePb();
    const g = await createAssignment(exec.token, {
      projectBranchId: pb.id, assayerId: PM.id, scheduledDate: today, remarks: `${PREFIX} clock-skew` });
    const asg = g.id;
    if (!asg) throw new Error(`could not stage the clock-skew assignment: ${clip(msg(g.r), 140)}`);
    await call(pmToken, 'POST', `/assignments/${asg}/accept`, {});
    const beforeCreation = new Date(Date.now() - 86400000 * 30).toISOString();
    const ci = await call(pmToken, 'POST', `/assignments/${asg}/check-in`, {
      latitude: Number(donor.latitude), longitude: Number(donor.longitude), accuracy: 8,
      timestamp: beforeCreation, checkedInAt: beforeCreation, recordedAt: beforeCreation });
    const row = await one(
      `SELECT created_at, checked_in_at,
              to_char(created_at,'YYYY-MM-DD HH24:MI:SS') c, to_char(checked_in_at,'YYYY-MM-DD HH24:MI:SS') i
         FROM assignments WHERE id=$1`, [asg]);
    const honest = row?.checked_in_at && new Date(row.checked_in_at) >= new Date(row.created_at);
    check('A4d', ci.throttled ? 'UNKNOWN' : !!honest,
      `a check-in carrying a timestamp 30 days before the job existed is stamped by the server, not `
      + `the device (sent ${beforeCreation.slice(0, 19)}, created ${row?.c}, stored ${row?.i ?? 'NULL'})`);

    // The movement trail is the other place a device clock reaches the record.
    const ping = await call(pmToken, 'POST', `/assayers/${PM.id}/location-pings`, {
      pings: [{ latitude: Number(donor.latitude), longitude: Number(donor.longitude),
        recordedAt: '2020-01-01T00:00:00.000Z', assignmentId: asg, accuracyMeters: 9 }] });
    const pings = await q(
      `SELECT recorded_at, received_at, source, is_mocked FROM assayer_location_pings
        WHERE assayer_id=$1 AND recorded_at < '2021-01-01'`, [PM.id]);
    check('A4d-ii', ping.throttled ? 'UNKNOWN' : ping.status >= 400 || pings.length === 0,
      pings.length
        ? `ACCEPTED (HTTP ${ping.status}): a position fix dated 2020-01-01 is filed against an assignment `
          + `created today — ${pings.length} trail row(s) predate the work they belong to `
          + `(source ${pings[0].source}, mocked ${pings[0].is_mocked}, received ${String(pings[0].received_at).slice(0, 24)}), `
          + `and nothing on the row marks the six-year gap between the device clock and the server's`
        : `a position fix from 2020 is refused (HTTP ${ping.status}) — "${clip(msg(ping), 70)}"`);
    await cancel(asg, 'clock-skew probe');
  }

  // ══ THEME B — duplicate, stale and concurrent on every critical mutation ═════════════════════
  await clearOpen();
  console.log('\nB1 — assignment create: twice, and three at once');
  {
    const key = `${PREFIX}-create-key`;
    const pb = takePb();
    const body = { projectBranchId: pb.id, assayerId: PM.id, proposedFee: QUOTE, scheduledDate: today,
      remarks: `${PREFIX} dup-create`, clientRequestId: key };
    const first = await createAssignment(exec.token, body);
    const second = await call(exec.token, 'POST', '/assignments', body);
    const rows = await q(`SELECT id FROM assignments WHERE project_branch_id=$1`, [pb.id]);
    const audits = await one(
      `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND event_type='ASSIGNMENT_CREATED'`, [first.id]);
    check('B1-DUP-KEY', second.throttled ? 'UNKNOWN'
      : okish(second) && second.body?.data?.id === first.id && rows.length === 1 && audits.c === 1,
      `the same create with the same clientRequestId twice is one assignment `
      + `(HTTP ${second.status}, same id=${second.body?.data?.id === first.id}, rows ${rows.length}, ASSIGNMENT_CREATED ${audits.c})`);
    if (first.id) await cancel(first.id, 'duplicate-create probe');
  }
  {
    const pb = takePb();
    const body = { projectBranchId: pb.id, assayerId: PM.id, proposedFee: QUOTE, scheduledDate: today,
      remarks: `${PREFIX} dup-create-nokey` };
    const first = await createAssignment(exec.token, body);
    const second = await call(exec.token, 'POST', '/assignments', body);
    const rows = await q(`SELECT id, status FROM assignments WHERE project_branch_id=$1 AND is_active`, [pb.id]);
    check('B1-DUP-NOKEY', second.throttled ? 'UNKNOWN' : rows.length === 1 && second.status >= 400,
      `the same create with NO idempotency key twice is refused the second time and still one row `
      + `(HTTP ${second.status}, rows ${rows.length}) — "${clip(msg(second), 70)}"`);
    if (first.id) await cancel(first.id, 'duplicate-create-nokey probe');
  }
  note('B1-STALE', 'assignment create carries no expectedVersion and cannot: there is no prior version '
    + 'of a row that does not exist yet. Not a gap.');
  {
    const pb = takePb();
    const body = { projectBranchId: pb.id, assayerId: PM.id, proposedFee: QUOTE, scheduledDate: today,
      remarks: `${PREFIX} conc-create` };
    const fired = await Promise.all([1, 2, 3].map(() => call(exec.token, 'POST', '/assignments', body)));
    const rows = await q(`SELECT id, status FROM assignments WHERE project_branch_id=$1`, [pb.id]);
    const wins = fired.filter(okish).length;
    const fives = fired.filter((r) => r.status >= 500).length;
    check('B1-CONC', fired.some((r) => r.throttled) ? 'UNKNOWN' : rows.length === 1 && wins === 1 && fives === 0,
      `three simultaneous creates leave exactly one assignment (statuses ${fired.map((r) => r.status).join('/')}, `
      + `rows ${rows.length}, 2xx ${wins}, 5xx ${fives})`);
    if (fives) note('B1-CONC-shape', `the losing racers answered ${fired.filter((r) => r.status >= 500).map((r) => `${r.status} "${clip(msg(r), 50)}"`).join(' | ')}`);
    for (const r of rows) { created.assignments.push(r.id); await cancel(r.id, 'concurrent-create probe'); }
  }

  // The assignment that carries the rest of Theme B, and the money behind it.
  await clearOpen();
  const mainPb = takePb();
  const main = await createAssignment(exec.token, {
    projectBranchId: mainPb.id, assayerId: PM.id, proposedFee: QUOTE, scheduledDate: today,
    remarks: `${PREFIX} theme-b` });
  if (!main.id) throw new Error(`could not create the Theme B assignment: ${JSON.stringify(main.r.body)}`);
  const ASG = main.id;

  console.log('\nB2 — assignment accept: twice, stale, and three at once');
  {
    const v = (await one(`SELECT entity_version FROM assignments WHERE id=$1`, [ASG])).entity_version;
    const stale = await call(pmToken, 'POST', `/assignments/${ASG}/accept`, { expectedVersion: v - 1 });
    const after = await one(`SELECT status, entity_version FROM assignments WHERE id=$1`, [ASG]);
    check('B2-STALE', stale.throttled ? 'UNKNOWN'
      : stale.status === 409 && after.status === 'PENDING' && Number(after.entity_version) === Number(v),
      `an accept carrying version ${v - 1} when the row is at ${v} answers 409 and changes nothing `
      + `(HTTP ${stale.status}, still ${after.status} at v${after.entity_version})`);

    const key = `${PREFIX}-accept-key`;
    const a1 = await call(pmToken, 'POST', `/assignments/${ASG}/accept`, { clientRequestId: key });
    const a2 = await call(pmToken, 'POST', `/assignments/${ASG}/accept`, { clientRequestId: key });
    const a3 = await call(pmToken, 'POST', `/assignments/${ASG}/accept`, {});
    const accepted = await one(
      `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND event_type='ASSIGNMENT_ACCEPTED'`, [ASG]);
    const row = await one(`SELECT status FROM assignments WHERE id=$1`, [ASG]);
    check('B2-DUP', [a1, a2, a3].some((r) => r.throttled) ? 'UNKNOWN' : row.status === 'ACCEPTED' && accepted.c === 1,
      `accept twice with a key and once without is one acceptance `
      + `(HTTP ${a1.status}/${a2.status}/${a3.status}, ASSIGNMENT_ACCEPTED rows ${accepted.c})`);
  }
  {
    // Concurrency on accept is probed on a second offer, because the first is already accepted.
    const pb = takePb();
    const g = await createAssignment(exec.token, {
      projectBranchId: pb.id, assayerId: PL.id, proposedFee: QUOTE, scheduledDate: today,
      remarks: `${PREFIX} conc-accept` });
    if (g.id) {
      const before = await one(`SELECT entity_version FROM assignments WHERE id=$1`, [g.id]);
      const fired = await Promise.all([1, 2, 3].map(() =>
        call(admin.token, 'POST', `/assignments/${g.id}/transition`, { status: 'ACCEPTED' })));
      const audits = await one(
        `SELECT count(*) FILTER (WHERE event_type='ASSIGNMENT_ACCEPTED')::int c,
                count(*) FILTER (WHERE event_type='NOTIFICATION_ASSIGNMENT_ACCEPTED')::int n
           FROM audit_events WHERE entity_id=$1`, [g.id]);
      const row = await one(`SELECT status, entity_version FROM assignments WHERE id=$1`, [g.id]);
      check('B2-CONC', fired.some((r) => r.throttled) ? 'UNKNOWN' : row.status === 'ACCEPTED' && audits.c === 1,
        `three simultaneous acceptances through POST :id/transition produce one business event `
        + `(statuses ${fired.map((r) => r.status).join('/')}, ASSIGNMENT_ACCEPTED rows ${audits.c}, `
        + `acceptance notifications ${audits.n}, entity_version ${before.entity_version}→${row.entity_version}, `
        + `DB ${row.status}) — POST :id/accept, the other door to the same event, answered one`);
      await cancel(g.id, 'concurrent-accept probe');
    } else {
      check('B2-CONC', 'UNKNOWN', `could not stage a second offer to race (HTTP ${g.r.status})`);
    }
  }

  console.log('\nB3 — assignment complete: twice, stale, and three at once');
  await call(pmToken, 'POST', `/assignments/${ASG}/check-in`,
    { latitude: Number(donor.latitude), longitude: Number(donor.longitude), accuracy: 8 });
  {
    const v = (await one(`SELECT entity_version FROM assignments WHERE id=$1`, [ASG])).entity_version;
    const stale = await call(exec.token, 'POST', `/assignments/${ASG}/complete`,
      { reason: 'Acceptance probe: stale completion.', expectedVersion: v - 1 });
    const after = await one(`SELECT status FROM assignments WHERE id=$1`, [ASG]);
    check('B3-STALE', stale.throttled ? 'UNKNOWN' : stale.status === 409 && after.status === 'CHECKED_IN',
      `a completion carrying version ${v - 1} when the row is at ${v} answers 409 and the work is not closed `
      + `(HTTP ${stale.status}, still ${after.status})`);

    const fired = await Promise.all([1, 2, 3].map(() =>
      call(exec.token, 'POST', `/assignments/${ASG}/complete`, { reason: 'Acceptance probe: field work verified.' })));
    const dup = await call(exec.token, 'POST', `/assignments/${ASG}/complete`,
      { reason: 'Acceptance probe: the operator pressed it again.' });
    const audits = await one(
      `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND new_state='COMPLETED'`, [ASG]);
    const row = await one(`SELECT status FROM assignments WHERE id=$1`, [ASG]);
    check('B3-CONC', fired.some((r) => r.throttled) ? 'UNKNOWN' : row.status === 'COMPLETED' && audits.c === 1,
      `three simultaneous completions plus one late duplicate are one completion `
      + `(statuses ${fired.map((r) => r.status).join('/')}, then ${dup.status}, COMPLETED audit rows ${audits.c})`);

    const payables = await awaitPayable(ASG);
    const entries = await q(`SELECT * FROM billing_entries WHERE assignment_id=$1`, [ASG]);
    check('B3-EFFECT', payables.length === 1 && entries.length === 1,
      `and exactly one payable and one client line downstream (payables ${payables.length}, entries ${entries.length})`);
    if (payables.length !== 1) throw new Error('no single payable — the money mutations cannot be probed');

    const pay = payables[0];
    const gross = round2(num(pay.base_amount) + num(pay.travel_amount));
    check('B3-MONEY', Math.abs(gross - num(pay.tds_amount) - num(pay.total_amount)) < 0.01 && Math.abs(gross - QUOTE) < 0.01,
      `the money recomputed independently: ${gross} - TDS ${num(pay.tds_amount)} = ${num(pay.total_amount)}, against the offered ₹${QUOTE}`);
  }
  const PAYABLE = (await q(`SELECT * FROM assayer_payables WHERE assignment_id=$1`, [ASG]))[0];

  console.log('\nB4 — payable approve: twice, stale, and three at once');
  {
    const probe = await call(admin.token, 'POST', '/billing-engine/payouts/approve',
      { payableIds: [PAYABLE.id], expectedVersion: Number(PAYABLE.version) - 1 });
    const after = await one(`SELECT status, version FROM assayer_payables WHERE id=$1`, [PAYABLE.id]);
    const rejectedTheField = probe.status === 400 && /expectedVersion/i.test(JSON.stringify(probe.body ?? {}));
    check('B4-STALE', probe.throttled ? 'UNKNOWN' : rejectedTheField && after.status === 'PENDING',
      rejectedTheField
        ? `payout approval offers NO optimistic concurrency: expectedVersion is rejected as an unknown `
          + `property (HTTP ${probe.status}), so a stale approval cannot be expressed, let alone refused`
        : `expectedVersion on approve answered HTTP ${probe.status} — "${clip(msg(probe), 70)}" (payable ${after.status})`);

    const fired = await Promise.all([1, 2, 3].map(() =>
      call(admin.token, 'POST', '/billing-engine/payouts/approve', { payableIds: [PAYABLE.id] })));
    const dup = await call(admin.token, 'POST', '/billing-engine/payouts/approve', { payableIds: [PAYABLE.id] });
    const approvals = await one(
      `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND event_type='PAYABLE_APPROVED' AND outcome='SUCCESS'`,
      [PAYABLE.id]);
    const after2 = await one(`SELECT status, approved_by, approved_at FROM assayer_payables WHERE id=$1`, [PAYABLE.id]);
    check('B4-CONC', fired.some((r) => r.throttled) ? 'UNKNOWN' : after2.status === 'APPROVED' && approvals.c === 1,
      `three simultaneous approvals plus one duplicate are one approval `
      + `(statuses ${fired.map((r) => r.status).join('/')}, then ${dup.status}, PAYABLE_APPROVED rows ${approvals.c}, DB ${after2.status})`);
    note('B4-DUP-KEY', 'POST /billing-engine/payouts/approve accepts no idempotency key of any kind — '
      + 'PayoutIdsDto is { payableIds } only. Duplicate suppression rests entirely on the payable\'s '
      + 'own status transition, which is the right last line but the only one.');
  }

  console.log('\nB5 — payable pay: twice, with a second reference, and three at once');
  {
    const ref = `${PREFIX}-PAYREF`;
    const probe = await call(admin2.token, 'POST', '/billing-engine/payouts/pay',
      { payableIds: [PAYABLE.id], paymentReference: ref, method: 'NEFT', expectedVersion: 1 });
    const rejectedTheField = probe.status === 400 && /expectedVersion/i.test(JSON.stringify(probe.body ?? {}));
    check('B5-STALE', probe.throttled ? 'UNKNOWN' : rejectedTheField,
      rejectedTheField
        ? `payout disbursement offers no optimistic concurrency either (HTTP ${probe.status}); the payment `
          + `reference is the only key, and it is chosen by the caller`
        : `expectedVersion on pay answered HTTP ${probe.status} — "${clip(msg(probe), 70)}"`);

    const fired = await Promise.all([1, 2, 3].map(() =>
      call(admin2.token, 'POST', '/billing-engine/payouts/pay',
        { payableIds: [PAYABLE.id], paymentReference: ref, method: 'NEFT' })));
    const dup = await call(admin2.token, 'POST', '/billing-engine/payouts/pay',
      { payableIds: [PAYABLE.id], paymentReference: ref, method: 'NEFT' });
    const payments = await q(`SELECT id, amount FROM billing_payments WHERE payable_id=$1 AND is_active`, [PAYABLE.id]);
    const after = await one(`SELECT status, paid_amount FROM assayer_payables WHERE id=$1`, [PAYABLE.id]);
    check('B5-CONC', fired.some((r) => r.throttled) ? 'UNKNOWN'
      : after.status === 'PAID' && payments.length === 1,
      `three simultaneous payments plus one duplicate are one payment `
      + `(statuses ${fired.map((r) => r.status).join('/')}, then ${dup.status}, billing_payments ${payments.length}, `
      + `paid ${after.paid_amount})`);

    // The reference is caller-chosen, so the interesting duplicate is the one that changes it.
    const second = await call(admin2.token, 'POST', '/billing-engine/payouts/pay',
      { payableIds: [PAYABLE.id], paymentReference: `${ref}-AGAIN`, method: 'NEFT' });
    const paymentsAfter = await q(`SELECT id FROM billing_payments WHERE payable_id=$1 AND is_active`, [PAYABLE.id]);
    check('B5-DUP-NEWREF', second.throttled ? 'UNKNOWN' : paymentsAfter.length === 1,
      `paying the same payable again under a NEW reference does not pay it twice `
      + `(HTTP ${second.status}, billing_payments ${paymentsAfter.length}) — "${clip(msg(second), 60)}"`);
  }

  console.log('\nB6 — assayer lifecycle transition: twice, stale, and three at once');
  {
    const v0 = (await one(`SELECT version FROM assayers WHERE id=$1`, [PL.id])).version;
    const stale = await call(admin.token, 'POST', `/assayers/${PL.id}/lifecycle`,
      { targetStatus: 'ON_LEAVE', reason: 'Acceptance probe: stale lifecycle write.', expectedVersion: Number(v0) - 1 });
    const after = await one(`SELECT lifecycle_status, version FROM assayers WHERE id=$1`, [PL.id]);
    check('B6-STALE', stale.throttled ? 'UNKNOWN'
      : stale.status === 409 && after.lifecycle_status === 'ACTIVE' && Number(after.version) === Number(v0),
      `a lifecycle move carrying version ${Number(v0) - 1} when the row is at ${v0} answers 409 and the person `
      + `does not move (HTTP ${stale.status}, still ${after.lifecycle_status} at v${after.version})`);

    const before = Number((await one(
      `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND event_type='ASSAYER_LIFECYCLE_TRANSITION'`, [PL.id])).c);
    const fired = await Promise.all([1, 2, 3].map(() => call(admin.token, 'POST', `/assayers/${PL.id}/lifecycle`,
      { targetStatus: 'ON_LEAVE', reason: 'Acceptance probe: concurrent leave.' })));
    const dup = await call(admin.token, 'POST', `/assayers/${PL.id}/lifecycle`,
      { targetStatus: 'ON_LEAVE', reason: 'Acceptance probe: the operator pressed it again.' });
    const addedRow = await one(
      `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND event_type='ASSAYER_LIFECYCLE_TRANSITION'`, [PL.id]);
    const added = Number(addedRow.c) - before;
    const now = await one(`SELECT lifecycle_status FROM assayers WHERE id=$1`, [PL.id]);
    const wins = fired.filter(okish).length;
    check('B6-CONC', fired.some((r) => r.throttled) ? 'UNKNOWN'
      : now.lifecycle_status === 'ON_LEAVE' && wins === 1 && added === 1,
      `three simultaneous ACTIVE→ON_LEAVE moves are one move `
      + `(statuses ${fired.map((r) => r.status).join('/')}, then duplicate ${dup.status}, `
      + `new lifecycle audit rows ${added}, DB ${now.lifecycle_status})`);
  }

  console.log('\nB7 — empanelment set: twice, stale, and three at once');
  {
    const probe = await call(admin.token, 'PUT', `/assayers/${PE.id}/empanelment/${SBI}`,
      { status: 'DOCUMENTS_PENDING', expectedVersion: 1 });
    const rejectedTheField = probe.status === 400 && /expectedVersion/i.test(JSON.stringify(probe.body ?? {}));
    const after = await one(`SELECT status, version FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`, [PE.id, SBI]);
    check('B7-STALE', probe.throttled ? 'UNKNOWN' : rejectedTheField && after.status === 'ACTIVE',
      rejectedTheField
        ? `empanelment offers no optimistic concurrency: expectedVersion is rejected as an unknown property `
          + `(HTTP ${probe.status}) and the standing is unchanged (${after.status} at v${after.version})`
        : `expectedVersion on empanelment answered HTTP ${probe.status}, standing ${after.status}`);

    const beforeRow = await one(
      `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND event_type='EMPANELMENT_SET'`, [PE.id]);
    const fired = await Promise.all([1, 2, 3].map(() => call(admin.token, 'PUT',
      `/assayers/${PE.id}/empanelment/${SBI}`, { status: 'DOCUMENTS_PENDING', statusReason: 'Acceptance probe: concurrent set.' })));
    const rows = await q(`SELECT id, status FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`, [PE.id, SBI]);
    const fives = fired.filter((r) => r.status >= 500).length;
    check('B7-CONC', fired.some((r) => r.throttled) ? 'UNKNOWN'
      : rows.length === 1 && rows[0].status === 'DOCUMENTS_PENDING' && fives === 0,
      `three simultaneous standings leave exactly one row and no 500s `
      + `(statuses ${fired.map((r) => r.status).join('/')}, rows ${rows.length}, final ${rows[0]?.status}, 5xx ${fives})`);
    if (fives) note('B7-CONC-shape', `losers answered ${fired.filter((r) => r.status >= 500).map((r) => `${r.status} "${clip(msg(r), 60)}"`).join(' | ')}`);

    /**
     * The same three at once, each carrying a DIFFERENT decision.
     *
     * `setEmpanelment` is a read-modify-write with no row lock and no version: it reads the
     * standing, overwrites every column from the DTO and saves. Three desks answering at the same
     * moment are therefore all told their answer was recorded, and only the last one was — which
     * is invisible with identical payloads and is what this probe makes visible.
     */
    const wanted = ['RECOMMENDED', 'NOT_RECOMMENDED', 'DOCUMENTS_PENDING'];
    const raced = await Promise.all(wanted.map((s) => call(admin.token, 'PUT',
      `/assayers/${PE.id}/empanelment/${SBI}`, { status: s, statusReason: `Acceptance probe: ${s}.` })));
    const settled = await one(
      `SELECT status, status_reason, version FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`,
      [PE.id, SBI]);
    const toldYes = raced.filter(okish).length;
    check('B7-CONC-ii', raced.some((r) => r.throttled) ? 'UNKNOWN' : toldYes === 1,
      `three desks recording three DIFFERENT standings at once: ${toldYes} of 3 were told it was saved `
      + `(${raced.map((r, i) => `${wanted[i]}:${r.status}`).join(' ')}), and the row now reads `
      + `${settled.status} — the other ${toldYes - 1} decision(s) were acknowledged and lost`);

    const dup = await call(admin.token, 'PUT', `/assayers/${PE.id}/empanelment/${SBI}`,
      { status: 'DOCUMENTS_PENDING', statusReason: 'Acceptance probe: concurrent set.' });
    const rowsAfter = await q(`SELECT id FROM assayer_client_empanelments WHERE assayer_id=$1 AND client_id=$2`, [PE.id, SBI]);
    const afterRow = await one(
      `SELECT count(*)::int c FROM audit_events WHERE entity_id=$1 AND event_type='EMPANELMENT_SET'`, [PE.id]);
    check('B7-DUP', dup.throttled ? 'UNKNOWN' : rowsAfter.length === 1,
      `setting the identical standing again is still one standing (HTTP ${dup.status}, rows ${rowsAfter.length}, `
      + `EMPANELMENT_SET audit rows grew by ${Number(afterRow.c) - Number(beforeRow.c)} across four writes)`);
  }

  console.log('\nB8 — document verify: twice, stale, and three at once');
  {
    await call(admin.token, 'PUT', `/assayers/${PM.id}/document/PAN_CARD`,
      { documentNumber: 'ABCPM1234M', softCopyReceived: true });
    const doc = await one(`SELECT id, version FROM assayer_documents WHERE assayer_id=$1 AND requirement='PAN_CARD'`, [PM.id]);
    const pdf = new Blob([Uint8Array.from(Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'))], { type: 'application/pdf' });
    const form = new FormData();
    form.append('file', pdf, 'pan.pdf');
    const up = await fetch(`${API}/assayers/${PM.id}/document/PAN_CARD/file`,
      { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: form });
    const attested = {
      verdict: 'VERIFIED', holderName: `${PREFIX} Main`,
      holderDateOfBirth: '1990-04-12', holderGuardianName: 'Acceptance Guardian',
    };
    const fresh = await one(`SELECT id, version FROM assayer_documents WHERE id=$1`, [doc.id]);

    const stale = await call(admin.token, 'POST', `/assayers/document/${doc.id}/verify`,
      { ...attested, expectedDocVersion: Number(fresh.version) - 1 });
    const afterStale = await one(`SELECT verification_status, version FROM assayer_documents WHERE id=$1`, [doc.id]);
    check('B8-STALE', stale.throttled ? 'UNKNOWN'
      : stale.status === 409 && afterStale.verification_status !== 'VERIFIED',
      `a verification carrying document version ${Number(fresh.version) - 1} when the row is at ${fresh.version} `
      + `answers 409 and the document is not marked verified (HTTP ${stale.status}, status `
      + `${afterStale.verification_status ?? 'NULL'})`);

    const preVersion = (await one(`SELECT version FROM assayer_documents WHERE id=$1`, [doc.id])).version;
    const fired = await Promise.all([1, 2, 3].map(() =>
      call(admin.token, 'POST', `/assayers/document/${doc.id}/verify`, attested)));
    const dup = await call(admin.token, 'POST', `/assayers/document/${doc.id}/verify`, attested);
    const after = await one(
      `SELECT verification_status, verified_at, verified_by, version FROM assayer_documents WHERE id=$1`, [doc.id]);
    const audits = await one(
      `SELECT count(*)::int c FROM audit_events WHERE event_type='IDENTITY_DOCUMENT_VERIFICATION_CHANGED' AND entity_id IN ($1,$2)`,
      [doc.id, PM.id]);
    check('B8-CONC', fired.some((r) => r.throttled) ? 'UNKNOWN'
      : after.verification_status === 'VERIFIED' && Number(audits.c) === 1,
      `three simultaneous verifications plus one duplicate are one verification `
      + `(upload ${up.status}, statuses ${fired.map((r) => r.status).join('/')}, then ${dup.status}, `
      + `VERIFICATION_CHANGED rows ${audits.c}, row version ${preVersion}→${after.version}, `
      + `DB ${after.verification_status})`);
    note('B8-DUP-KEY', 'POST /assayers/document/:id/verify accepts no clientRequestId; expectedDocVersion is '
      + 'the only concurrency control, and it is optional.');
  }

  // ══ back to Theme A: the money the missing facts produce ═════════════════════════════════════
  console.log('\nA1 (continued) — what missing bank details and a missing PAN actually cost');
  await clearOpen();
  {
    const pbN = takePb();
    const gN = await createAssignment(exec.token, {
      projectBranchId: pbN.id, assayerId: PN.id, proposedFee: QUOTE, scheduledDate: today,
      acceptOnBehalf: true, acceptanceReason: 'Acceptance probe: desk confirmed on the assayer behalf.',
      remarks: `${PREFIX} nobank` });
    if (gN.id) {
      await drive(gN.id);
      const payables = await awaitPayable(gN.id);
      if (payables.length === 1) {
        const approve = await call(admin.token, 'POST', '/billing-engine/payouts/approve', { payableIds: [payables[0].id] });
        const after = await one(`SELECT status FROM assayer_payables WHERE id=$1`, [payables[0].id]);
        const reason = String(approve.body?.data?.refused?.[0]?.reason ?? msg(approve));
        check('A1b', approve.throttled ? 'UNKNOWN'
          : after.status === 'PENDING' && /bank|ifsc/i.test(reason),
          `a payout to somebody with no bank details is refused, naming what is missing, and the payable `
          + `stays ${after.status} — "${clip(reason, 90)}"`);
      } else {
        check('A1b', 'UNKNOWN', `no payable appeared for the no-bank person within the budget`);
      }
    } else {
      check('A1b', 'UNKNOWN', `could not stage the no-bank assignment (HTTP ${gN.r.status}) — "${clip(msg(gN.r), 70)}"`);
    }
  }
  {
    const pbP = takePb();
    const gP = await createAssignment(exec.token, {
      projectBranchId: pbP.id, assayerId: PP.id, proposedFee: QUOTE, scheduledDate: today,
      acceptOnBehalf: true, acceptanceReason: 'Acceptance probe: desk confirmed on the assayer behalf.',
      remarks: `${PREFIX} nopan` });
    if (gP.id) {
      await drive(gP.id);
      const payables = await awaitPayable(gP.id);
      if (payables.length === 1) {
        const p = payables[0];
        const gross = round2(num(p.base_amount) + num(p.travel_amount));
        const rate = gross > 0 ? round2((num(p.tds_amount) / gross) * 100) : 0;
        // s.206AA: no PAN furnished means withholding at the higher rate, not the professional one.
        check('A1c', Math.abs(rate - 20) < 0.51,
          `no PAN on file withholds at ${rate}% (₹${num(p.tds_amount)} of ₹${gross}), the s.206AA rate, `
          + `not the ordinary professional rate — snapshot ${JSON.stringify(p.rate_snapshot ?? {}).slice(0, 90)}`);
      } else {
        check('A1c', 'UNKNOWN', `no payable appeared for the no-PAN person within the budget`);
      }
    } else {
      check('A1c', 'UNKNOWN', `could not stage the no-PAN assignment (HTTP ${gP.r.status}) — "${clip(msg(gP.r), 70)}"`);
    }
  }
  // The unpriced client's money, and the zero-fee job's, recomputed rather than read back.
  {
    if (bareAssignmentId) {
      const payables = await awaitPayable(bareAssignmentId, 60000);
      const entries = await q(`SELECT * FROM billing_entries WHERE assignment_id=$1`, [bareAssignmentId]);
      const e = entries[0];
      const expectedTax = e ? round2(num(e.taxable_amount) * num(e.tax_rate) / 100) : null;
      check('A1e-ii', payables.length === 1 && entries.length === 1
        && Math.abs(num(e.tax_amount) - expectedTax) < 0.02,
        `the unpriced client is still invoiced: base ₹${e?.taxable_amount} at a default GST of `
        + `${e?.tax_rate}% = ₹${expectedTax} (stored ₹${e?.tax_amount}) and TDS ${e?.tds_rate}% — every rate a `
        + `platform default nobody negotiated`);
    }
    if (zeroFeeAssignmentId) {
      const payables = await awaitPayable(zeroFeeAssignmentId, 60000);
      const entries = await q(`SELECT id, total_amount FROM billing_entries WHERE assignment_id=$1`, [zeroFeeAssignmentId]);
      check('A2a-ii', payables.length <= 1 && (payables.length === 0 || num(payables[0].total_amount) === 0),
        `a zero-fee job books ${payables.length} payable(s) worth ₹${payables.length ? num(payables[0].total_amount) : 0} `
        + `and ${entries.length} client line(s) worth ₹${entries.length ? num(entries[0].total_amount) : 0}`);
    }
    if (noGeoAssignmentId) {
      const payables = await awaitPayable(noGeoAssignmentId, 60000);
      const p = payables[0];
      check('A1d-ii', payables.length === 1 && num(p.travel_amount) === 0,
        `the coordinate-less branch pays ₹${p ? num(p.travel_amount) : '?'} of travel on a real journey — `
        + `base ₹${p ? num(p.base_amount) : '?'}, total ₹${p ? num(p.total_amount) : '?'}`);
    }
  }

  // A1a (continued): the revoke path's reason, absent vs null vs empty vs blanks.
  {
    const shapes = [['absent', {}], ['null', { reason: null }], ['empty', { reason: '' }], ['blanks', { reason: '           ' }]];
    const answers = [];
    for (const [label, body] of shapes) {
      const r = await call(admin.token, 'POST', `/assayers/${PI.id}/recovery/revoke-invitation`, body);
      const after = await one(`SELECT lifecycle_status FROM assayers WHERE id=$1`, [PI.id]);
      answers.push({ label, status: r.status, still: after.lifecycle_status });
    }
    const uniform = answers.every((a) => a.status === 400 && a.still === 'INVITED');
    check('A3d-iii', answers.some((a) => a.status === 429) ? 'UNKNOWN' : uniform,
      `on a second reason-bearing endpoint the same four absences are refused identically `
      + `(${answers.map((a) => `${a.label}:${a.status}→${a.still}`).join(' ')})`);
  }

  // ── summary ─────────────────────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.state === 'FAIL');
  const unknown = results.filter((r) => r.state === 'UNKNOWN');
  console.log(`\n=== ${results.filter((r) => r.state === 'PASS').length}/${results.length} checks passed ===`);
  if (unknown.length) {
    console.log(`${unknown.length} UNKNOWN (throttled or unstageable, never counted as a denial):`);
    for (const u of unknown) console.log(`  [${u.id}] ${u.detail}`);
  }
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  [${f.id}] ${f.detail}`);
  }
  console.log(`\nassignment ${ASG}\npayable ${PAYABLE.id}\npeople ${created.assayers.length}\n`);

  if (!KEEP) await teardown();
  await db.end();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\nABORTED:', e.stack || e.message);
  try { if (!KEEP) await teardown(); } catch (t) { console.error('teardown also failed:', t.message); }
  try { await db?.end(); } catch {}
  process.exit(2);
});

/**
 * Children first, and never `audit_events`.
 *
 * Rather than hand-listing every table that might reference what this run made, the sweep asks the
 * catalogue which tables carry each foreign key column and empties those. Several passes, because
 * the graph is deeper than one level, and every failure is swallowed until the last pass so one
 * stubborn child cannot strand the whole cleanup.
 */
async function teardown() {
  if (!db) return;
  const FORBIDDEN = /audit|outbox/i;
  const tablesWith = async (column) => (await db.query(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema='public' AND t.table_type='BASE TABLE'
      WHERE c.table_schema='public' AND c.column_name=$1`, [column])).rows
    .map((r) => r.table_name).filter((t) => !FORBIDDEN.test(t));

  const sweeps = [
    ['assignment_id', created.assignments],
    ['assayer_id', created.assayers],
    ['branch_id', created.branches],
    ['project_id', created.projects],
    ['client_id', created.clients],
  ];
  let removed = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const [column, ids] of sweeps) {
      if (!ids.length) continue;
      for (const table of await tablesWith(column)) {
        // The parent tables themselves are handled below, by id, in order.
        if (['assignments', 'assayers', 'branches', 'projects', 'clients'].includes(table)) continue;
        try {
          const r = await db.query(`DELETE FROM "${table}" WHERE "${column}" = ANY($1::uuid[])`, [ids]);
          removed += r.rowCount;
        } catch { /* a deeper child still holds it; the next pass will get it */ }
      }
    }
    for (const [table, ids] of [
      ['assignments', created.assignments], ['project_branches', created.projectBranches],
      ['assayers', created.assayers], ['branches', created.branches],
      ['projects', created.projects], ['clients', created.clients],
    ]) {
      if (!ids.length) continue;
      try {
        const r = await db.query(`DELETE FROM "${table}" WHERE id = ANY($1::uuid[])`, [ids]);
        removed += r.rowCount;
      } catch { /* same */ }
    }
  }
  const left = await db.query(
    `SELECT (SELECT count(*) FROM assayers WHERE id = ANY($1::uuid[]))::int a,
            (SELECT count(*) FROM assignments WHERE id = ANY($2::uuid[]))::int g,
            (SELECT count(*) FROM branches WHERE id = ANY($3::uuid[]))::int b,
            (SELECT count(*) FROM projects WHERE id = ANY($4::uuid[]))::int p,
            (SELECT count(*) FROM clients WHERE id = ANY($5::uuid[]))::int c`,
    [created.assayers, created.assignments, created.branches, created.projects, created.clients]);
  const r = left.rows[0];
  console.log(`teardown: ${removed} rows removed; left behind — assayers ${r.a}, assignments ${r.g}, `
    + `branches ${r.b}, projects ${r.p}, clients ${r.c}`);
}
