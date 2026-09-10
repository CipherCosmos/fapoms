/**
 * FAPOMS — does the WRITE ceiling agree with the READ ceiling?
 *
 * A region-assigned account (`users.regions = ['EAST']`) is refused reads outside its region.
 * This probe asks the same question of every write and export that reaches a region-anchored
 * resource, and it asks it the only way the answer is trustworthy:
 *
 *  - every probe runs TWICE — once against a fixture the account HOLDS (the control) and once
 *    against one it does not (the test), differing only in region. A refused control means the
 *    account cannot do this at all and the test result says nothing about region; that pair is
 *    reported INCONCLUSIVE rather than counted as a pass;
 *  - every token is proved alive on a permitted read first, so a blanket 401 (expired token,
 *    forced rotation, throttle) can never be written up as a correct denial;
 *  - 403 and 404 are reported separately. A route that answers 404 for an out-of-region record
 *    is denying, but it is denying by a different rule and the report should say which;
 *  - a 429 that survives the retry budget is UNKNOWN, never a denial.
 *
 * No branch in this database is in EAST, so the EAST controls are built here (cloned from a real
 * WEST row and re-pointed) rather than assumed.
 *
 * Usage:  AC_ENV_FILE=… node scripts/acceptance/region-parity.mjs
 */
import { API, req, login, sql, one, tally, env } from './_lib.mjs';

const TAG = `RP${Date.now()}`;
const ADMIN_PASSWORD = env.AC_PASSWORD;
const EAST_STATE = 'West Bengal';
const WEST_STATE = 'Maharashtra';

// ── row cloning ────────────────────────────────────────────────────────────
//
// Fixtures are cloned from a row the seed already produced rather than assembled column by
// column: a hand-written INSERT drifts from the schema the moment a NOT NULL column is added,
// and a fixture that fails to insert reads exactly like a route that refused.

const columnCache = new Map();
async function columnsOf(table) {
  if (!columnCache.has(table)) {
    const rows = await sql(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
    columnCache.set(table, rows.map((r) => r.column_name));
  }
  return columnCache.get(table);
}

/** Copy one row, overriding the named columns with literal SQL expressions. */
async function cloneRow(table, sourceId, overrides = {}) {
  const cols = await columnsOf(table);
  const select = cols.map((c) => (c in overrides ? `${overrides[c]} AS "${c}"` : `"${c}"`)).join(', ');
  const list = cols.map((c) => `"${c}"`).join(', ');
  const rows = await sql(
    `INSERT INTO ${table} (${list}) SELECT ${select} FROM ${table} WHERE id = $1 RETURNING id`, [sourceId]);
  if (!rows[0]) throw new Error(`clone ${table} ${sourceId}: source row not found`);
  return rows[0].id;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── fixtures ───────────────────────────────────────────────────────────────

async function buildFixtures(adminId) {
  // The WEST source: a completed assignment whose branch is WEST, with a payable and a client
  // line already booked against it. Everything else is cloned off this one row.
  const src = await one(
    `SELECT a.id AS "assignmentId", pb.id AS "pbId", b.id AS "branchId", b.region,
            p.id AS "projectId", p.client_id AS "clientId", a.assayer_id AS "assayerId"
       FROM assignments a
       JOIN project_branches pb ON pb.id = a.project_branch_id
       JOIN branches b ON b.id = pb.branch_id
       JOIN projects p ON p.id = pb.project_id
      WHERE b.region = 'WEST' AND a.status = 'COMPLETED'
      ORDER BY a.created_at DESC LIMIT 1`);
  if (!src) throw new Error('no WEST completed assignment to clone from');

  const mk = async (label, region, state) => {
    const branchId = await cloneRow('branches', src.branchId, {
      id: 'gen_random_uuid()', sol_id: q(`SOL-${TAG}-${label}`), name: q(`${TAG} ${label} Branch`),
      region: q(region), state: q(state), created_by: q(adminId), updated_by: q(adminId),
      created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
    });
    const pbId = await cloneRow('project_branches', src.pbId, {
      id: 'gen_random_uuid()', branch_id: q(branchId), status: `'PLANNING'`,
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    });
    // A second branch and project_branch, so a probe that consumes one (unable-to-cover) still
    // leaves a pristine one for the probes that follow. `project_branches` is unique on
    // (project_id, branch_id), so a spare needs a branch of its own.
    const branchId2 = await cloneRow('branches', src.branchId, {
      id: 'gen_random_uuid()', sol_id: q(`SOL-${TAG}-${label}-2`), name: q(`${TAG} ${label} Branch 2`),
      region: q(region), state: q(state), created_by: q(adminId), updated_by: q(adminId),
      created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
    });
    const pbId2 = await cloneRow('project_branches', src.pbId, {
      id: 'gen_random_uuid()', branch_id: q(branchId2), status: `'PLANNING'`,
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    });
    // created_by is the ADMIN, not the probing account: payout approval enforces
    // maker-checker against the ASSIGNMENT's creator, and a fixture the prober "created"
    // would be refused for that reason and read as a region denial.
    const assignmentId = await cloneRow('assignments', src.assignmentId, {
      id: 'gen_random_uuid()', assignment_number: q(`ASN-${TAG}-${label}`),
      project_branch_id: q(pbId), status: `'COMPLETED'`,
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    });
    const payableSrc = await one(
      `SELECT id FROM assayer_payables WHERE assignment_id = $1 LIMIT 1`, [src.assignmentId])
      ?? await one(`SELECT id FROM assayer_payables ORDER BY created_at DESC LIMIT 1`);
    const payableId = payableSrc ? await cloneRow('assayer_payables', payableSrc.id, {
      id: 'gen_random_uuid()', assignment_id: q(assignmentId), status: `'PENDING'`,
      on_hold: 'false', approved_by: 'NULL', approved_at: 'NULL', paid_at: 'NULL',
      payable_number: q(`PAY-${TAG}-${label}`),
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    }) : null;
    const entrySrc = await one(
      `SELECT id FROM billing_entries WHERE assignment_id = $1 LIMIT 1`, [src.assignmentId])
      ?? await one(`SELECT id FROM billing_entries ORDER BY created_at DESC LIMIT 1`);
    const entryId = entrySrc ? await cloneRow('billing_entries', entrySrc.id, {
      id: 'gen_random_uuid()', assignment_id: q(assignmentId), state: `'UNBILLED'`,
      invoice_id: 'NULL', on_hold: 'false', entry_number: q(`BE-${TAG}-${label}`),
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    }) : null;
    // A contact and a document row on the branch, for the child-row-keyed routes.
    const contactSrc = await one(`SELECT id FROM branch_contacts ORDER BY created_at DESC LIMIT 1`);
    const contactId = contactSrc ? await cloneRow('branch_contacts', contactSrc.id, {
      id: 'gen_random_uuid()', branch_id: q(branchId), is_primary: 'false',
      name: q(`${TAG} ${label} Contact`), created_by: q(adminId), updated_by: q(adminId),
      created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
    }) : null;
    const docSrc = await one(`SELECT id FROM branch_documents ORDER BY created_at DESC LIMIT 1`);
    const documentId = docSrc ? await cloneRow('branch_documents', docSrc.id, {
      id: 'gen_random_uuid()', branch_id: q(branchId), file_name: q(`${TAG}-${label}.pdf`),
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    }) : null;
    return { label, region, state, branchId, branchId2, pbId, pbId2, assignmentId, payableId, entryId, contactId, documentId };
  };

  const east = await mk('EAST', 'EAST', EAST_STATE);
  const west = await mk('WEST', 'WEST', WEST_STATE);

  // An assayer in each region, for the assayer-anchored routes.
  const assayerSrc = await one(`SELECT id FROM assayers ORDER BY created_at DESC LIMIT 1`);
  if (assayerSrc) {
    east.assayerId = await cloneRow('assayers', assayerSrc.id, {
      id: 'gen_random_uuid()', region: `'EAST'`, assayer_code: q(`AS-${TAG}-E`),
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    });
    west.assayerId = await cloneRow('assayers', assayerSrc.id, {
      id: 'gen_random_uuid()', region: `'WEST'`, assayer_code: q(`AS-${TAG}-W`),
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    });
  }

  return { east, west, projectId: src.projectId, clientId: src.clientId };
}

// ── verdicts ───────────────────────────────────────────────────────────────

const OK = (r) => r.status >= 200 && r.status < 300;
const DENIED = (r) => r.status === 403 || r.status === 404;

function classify(r) {
  if (r.status === 429) return 'UNKNOWN(429)';
  if (r.status === 401) return 'UNKNOWN(401)';
  if (r.status === 403) return '403';
  if (r.status === 404) return '404';
  if (OK(r)) return `ALLOWED(${r.status})`;
  return `OTHER(${r.status})`;
}

export async function main() {
  const t = tally();
  const results = [];

  // ── tokens, each proved alive before anything is concluded from a refusal ──
  if (!ADMIN_PASSWORD) throw new Error('AC_PASSWORD is required (admin builds the fixtures)');
  const admin = await login('admin', ADMIN_PASSWORD);
  const adminRow = await one(`SELECT id FROM users WHERE username = 'admin'`);
  const ops = await login('cert_ops_east');
  const desk = await login('cert_desk_east');

  const alive = async (label, token, path) => {
    const r = await req(path, { token });
    t.check(`token alive: ${label} ${path}`, OK(r), `${r.status} ${r.msg ?? ''}`);
    return OK(r);
  };
  const adminAlive = await alive('admin', admin.token, '/branches?limit=1');
  const opsAlive = await alive('cert_ops_east', ops.token, '/branches?limit=1');
  const deskAlive = await alive('cert_desk_east', desk.token, '/validation?limit=1');
  if (!adminAlive || !opsAlive || !deskAlive) {
    console.log('\nA token is not alive — every later refusal would be unattributable. Stopping.');
    return t.done();
  }

  const F = await buildFixtures(adminRow.id);
  console.log(`\nfixtures ${TAG}: EAST branch ${F.east.branchId}  WEST branch ${F.west.branchId}\n`);

  // The read ceiling, which is the thing the writes are being compared against.
  const readEast = await req(`/branches/${F.east.branchId}`, { token: ops.token });
  const readWest = await req(`/branches/${F.west.branchId}`, { token: ops.token });
  t.check('READ ceiling: EAST branch readable by EAST account', OK(readEast), `${readEast.status}`);
  t.check('READ ceiling: WEST branch refused to EAST account', readWest.status === 403,
    `${classify(readWest)} ${readWest.msg ?? ''}`);

  /**
   * One paired probe. `run(fixture)` is called for the control and then for the test; the
   * verdict is only about region when the control succeeded.
   */
  const pair = async (name, run, { expect = 'denied' } = {}) => {
    const control = await run(F.east, 'EAST');
    const test = await run(F.west, 'WEST');
    const cls = classify(test);
    let verdict, ok, detail;
    if (!OK(control)) {
      verdict = 'INCONCLUSIVE';
      ok = false;
      detail = `control (EAST) itself was ${classify(control)} ${control.msg ?? ''} — cannot attribute the test result to region`;
    } else if (cls.startsWith('UNKNOWN')) {
      verdict = 'UNKNOWN';
      ok = false;
      detail = `${cls} — throttled/unauthenticated, not a denial`;
    } else if (expect === 'denied') {
      ok = DENIED(test);
      verdict = ok ? `DENIED ${cls}` : `LEAK ${cls}`;
      detail = `control EAST ${classify(control)} | test WEST ${cls} ${test.msg ?? ''}`;
    } else {
      ok = OK(test);
      verdict = ok ? `ALLOWED ${cls}` : `REFUSED ${cls}`;
      detail = `control EAST ${classify(control)} | test WEST ${cls} ${test.msg ?? ''}`;
    }
    results.push({ name, verdict, control: classify(control), test: cls });
    t.check(name, ok, detail);
    return { control, test };
  };

  // ── branch writes ────────────────────────────────────────────────────────

  await pair('PUT /branches/:id', (f) =>
    req(`/branches/${f.branchId}`, { method: 'PUT', token: ops.token, body: { managerName: `${TAG} mgr` } }));

  await pair('POST /branches/:id/contacts', (f) =>
    req(`/branches/${f.branchId}/contacts`, {
      method: 'POST', token: ops.token,
      body: { name: `${TAG} c`, email: `${TAG.toLowerCase()}@example.com`, phone: '9876500011' },
    }));

  await pair('POST /branches/:id/documents', (f) =>
    req(`/branches/${f.branchId}/documents`, {
      method: 'POST', token: ops.token,
      body: { fileName: `${TAG}.pdf`, filePath: `/tmp/${TAG}.pdf`, fileSize: 12, category: 'OTHER' },
    }));

  await pair('PUT /branches/:id/contacts/:contactId (child-row keyed)', (f) =>
    f.contactId
      ? req(`/branches/${f.branchId}/contacts/${f.contactId}`, {
          method: 'PUT', token: ops.token, body: { notes: `${TAG} touched` } })
      : Promise.resolve({ status: 599, msg: 'no contact fixture' }));

  await pair('DELETE /branches/:id/documents/:documentId (child-row keyed)', (f) =>
    f.documentId
      ? req(`/branches/${f.branchId}/documents/${f.documentId}`, { method: 'DELETE', token: ops.token })
      : Promise.resolve({ status: 599, msg: 'no document fixture' }));

  // POST /branches has no existing record to anchor on — the region comes from the BODY.
  await pair('POST /branches (region named in body)', (f) =>
    req('/branches', {
      method: 'POST', token: ops.token,
      body: {
        solId: `SOL-${TAG}-NEW-${f.region}`, name: `${TAG} new ${f.region}`,
        state: f.state, region: f.region, clientId: F.clientId,
      },
    }));

  // The laundering case: the branch the caller HOLDS, moved to a region it does not.
  {
    const launderTarget = await one(`SELECT id FROM branches WHERE name = $1`, [`${TAG} EAST Branch`]);
    const r = await req(`/branches/${launderTarget.id}`, {
      method: 'PUT', token: ops.token, body: { region: 'WEST' },
    });
    const row = await one(`SELECT region FROM branches WHERE id = $1`, [launderTarget.id]);
    const ok = DENIED(r) && row.region === 'EAST';
    results.push({ name: 'PUT /branches/:id — region laundering', verdict: ok ? 'DENIED' : 'LEAK', control: 'n/a', test: classify(r) });
    t.check('PUT /branches/:id refuses moving a held branch OUT of the ceiling (region laundering)',
      ok, `${classify(r)} ${r.msg ?? ''} | branches.region is now ${row.region}`);
    if (row.region !== 'EAST') await sql(`UPDATE branches SET region = 'EAST' WHERE id = $1`, [launderTarget.id]);
  }

  // The same laundering through `state`, which the service resolves a region from.
  {
    const launderTarget = await one(`SELECT id FROM branches WHERE name = $1`, [`${TAG} EAST Branch`]);
    const r = await req(`/branches/${launderTarget.id}`, {
      method: 'PUT', token: ops.token, body: { state: WEST_STATE },
    });
    const row = await one(`SELECT region, state FROM branches WHERE id = $1`, [launderTarget.id]);
    const ok = DENIED(r) && row.region === 'EAST';
    results.push({ name: 'PUT /branches/:id — laundering via state', verdict: ok ? 'DENIED' : 'LEAK', control: 'n/a', test: classify(r) });
    t.check('PUT /branches/:id refuses moving a held branch out of the ceiling via `state`',
      ok, `${classify(r)} ${r.msg ?? ''} | region ${row.region}, state ${row.state}`);
    if (row.region !== 'EAST') {
      await sql(`UPDATE branches SET region = 'EAST', state = $2 WHERE id = $1`, [launderTarget.id, EAST_STATE]);
    }
  }

  // ── billing writes ───────────────────────────────────────────────────────

  await pair('POST /billing-engine/payouts/approve', (f) =>
    f.payableId
      ? req('/billing-engine/payouts/approve', { method: 'POST', token: ops.token, body: { payableIds: [f.payableId] } })
      : Promise.resolve({ status: 599, msg: 'no payable fixture' }));

  await pair('PATCH /billing-engine/payouts/:id/hold', (f) =>
    f.payableId
      ? req(`/billing-engine/payouts/${f.payableId}/hold`, { method: 'PATCH', token: ops.token, body: { onHold: true, reason: TAG } })
      : Promise.resolve({ status: 599, msg: 'no payable fixture' }));

  await pair('POST /billing-engine/payouts/bank-file', (f) =>
    f.payableId
      ? req('/billing-engine/payouts/bank-file', { method: 'POST', token: ops.token, body: { payableIds: [f.payableId] } })
      : Promise.resolve({ status: 599, msg: 'no payable fixture' }));

  await pair('PATCH /billing-engine/assignments/:id/client-line', (f) =>
    req(`/billing-engine/assignments/${f.assignmentId}/client-line`, {
      method: 'PATCH', token: ops.token, body: { adjustmentAmount: -100, adjustmentReason: TAG } }));

  await pair('POST /billing-engine/invoices', (f) =>
    req('/billing-engine/invoices', {
      method: 'POST', token: ops.token,
      body: { clientId: F.clientId, assignmentIds: [f.assignmentId], notes: TAG } }));

  await pair('POST /billing-engine/reconcile', () =>
    req('/billing-engine/reconcile', { method: 'POST', token: ops.token, body: {} }), { expect: 'allowed' });

  // ── project / coverage writes ────────────────────────────────────────────

  await pair('POST /projects/branches/:pbId/unable-to-cover', (f) =>
    req(`/projects/branches/${f.pbId2}/unable-to-cover`, {
      method: 'POST', token: ops.token, body: { reason: `${TAG} probe` } }));

  await pair('POST /projects/branches/:pbId/reopen-coverage', (f) =>
    req(`/projects/branches/${f.pbId2}/reopen-coverage`, { method: 'POST', token: ops.token }));

  await pair('PUT /projects/:id (project spanning regions)', () =>
    req(`/projects/${F.projectId}`, { method: 'PUT', token: ops.token, body: { scope: `${TAG}` } }),
    { expect: 'denied' });

  // ── validation (DESK) ────────────────────────────────────────────────────

  await pair('POST /validation', (f) =>
    req('/validation', { method: 'POST', token: desk.token, body: { projectBranchId: f.pbId } }));

  {
    const r = await req('/validation?limit=100', { token: desk.token });
    const ids = (r.body?.data ?? []).map((c) => c.id);
    const outside = ids.length
      ? await sql(
          `SELECT count(*)::int AS n FROM validation_cases vc
             JOIN project_branches pb ON pb.id = vc.project_branch_id
             JOIN branches b ON b.id = pb.branch_id
            WHERE vc.id = ANY($1) AND b.region IS NOT NULL AND b.region <> 'EAST'`, [ids])
      : [{ n: 0 }];
    const ok = OK(r) && outside[0].n === 0;
    results.push({ name: 'GET /validation', verdict: ok ? 'SCOPED' : 'LEAK', control: 'n/a', test: `${outside[0].n} of ${ids.length} out of region` });
    t.check('GET /validation returns no out-of-region case to an EAST desk', ok,
      `${r.status}: ${outside[0].n} of ${ids.length} returned cases are outside EAST`);
  }

  // ── call logs & remarks ──────────────────────────────────────────────────

  await pair('GET /call-logs?projectBranchId=', (f) =>
    req(`/call-logs?projectBranchId=${f.pbId}`, { token: ops.token }));

  await pair('POST /call-logs', (f) =>
    f.assayerId
      ? req('/call-logs', { method: 'POST', token: ops.token,
          body: { projectBranchId: f.pbId, assayerId: f.assayerId, outcome: 'NO_ANSWER', notes: TAG } })
      : Promise.resolve({ status: 599, msg: 'no assayer fixture' }));

  await pair('POST /assayer-remarks', (f) =>
    f.assayerId
      ? req('/assayer-remarks', { method: 'POST', token: ops.token,
          body: { assayerId: f.assayerId, rating: 4, category: 'PROFESSIONALISM', text: `${TAG} probe remark` } })
      : Promise.resolve({ status: 599, msg: 'no assayer fixture' }));

  // ── exports ──────────────────────────────────────────────────────────────
  //
  // An export is a read with a different Content-Type; the interesting number is not the status
  // but how many out-of-region rows the workbook carries. The bytes are counted rather than
  // parsed: the WEST fixture's entry number is a literal string in the sheet's XML.

  const workbookHas = async (path, token, needle) => {
    const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status !== 200) return { status: r.status, found: null };
    const buf = Buffer.from(await r.arrayBuffer());
    // xlsx is a zip; the shared-strings part stores the text uncompressed enough of the time
    // that a raw scan is unreliable — so inflate it properly.
    const { default: XLSX } = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const text = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
    return { status: 200, found: text.includes(needle), rows: text.split('\n').length };
  };

  {
    const westEntry = await one(`SELECT entry_number FROM billing_entries WHERE id = $1`, [F.west.entryId]);
    const eastEntry = await one(`SELECT entry_number FROM billing_entries WHERE id = $1`, [F.east.entryId]);
    const west = await workbookHas('/reports/billing', ops.token, westEntry?.entry_number ?? ' ');
    const east = await workbookHas('/reports/billing', ops.token, eastEntry?.entry_number ?? ' ');
    const ok = west.status === 200 && west.found === false && east.found === true;
    results.push({ name: 'GET /reports/billing (export)', verdict: ok ? 'SCOPED' : 'LEAK', control: `east row present: ${east.found}`, test: `west row present: ${west.found}` });
    t.check('GET /reports/billing workbook carries the EAST line and NOT the WEST line', ok,
      `status ${west.status}; EAST line present=${east.found}; WEST line present=${west.found}`);
  }

  {
    const r = await req(`/reports/coverage/${F.projectId}`, { token: ops.token });
    // The project spans regions, so the whole export is refused rather than silently narrowed.
    const ok = DENIED(r);
    results.push({ name: 'GET /reports/coverage/:projectId', verdict: ok ? `DENIED ${classify(r)}` : `LEAK ${classify(r)}`, control: 'n/a', test: classify(r) });
    t.check('GET /reports/coverage/:projectId refuses a cross-region project to an EAST account',
      ok, `${classify(r)} ${r.msg ?? ''}`);
  }

  {
    const r = await req('/reports/billing/jobs', { method: 'POST', token: ops.token });
    const ok = OK(r);
    t.check('POST /reports/billing/jobs accepted (its scope is checked in the worker payload)', ok, `${r.status}`);
  }

  // ── report ───────────────────────────────────────────────────────────────
  console.log('\n─── per-route verdicts ───');
  for (const r of results) console.log(`  ${r.verdict.padEnd(18)} ${r.name}   [control ${r.control} | test ${r.test}]`);

  await t.done();
}

main().catch((e) => { console.error(e); process.exit(2); });
