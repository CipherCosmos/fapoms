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
import { API, req, login, sql, one, tally, env, declareMutating } from './_lib.mjs';

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
    // A third branch, deliberately left UNassociated: `POST /projects/:id/branches` is run
    // against it by the ADMIN below, because that route is what writes the `assessments` row
    // `POST /call-logs` insists on. `assessments` is empty in this database, so a call-log probe
    // built on a hand-cloned project_branch answers 404 for both halves and proves nothing.
    const branchId3 = await cloneRow('branches', src.branchId, {
      id: 'gen_random_uuid()', sol_id: q(`SOL-${TAG}-${label}-3`), name: q(`${TAG} ${label} Branch 3`),
      region: q(region), state: q(state), created_by: q(adminId), updated_by: q(adminId),
      created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
    });
    // A fourth, for the branch DELETE probe alone — deleting one the other probes are still
    // using would make their later results about the soft delete rather than about region.
    const branchId4 = await cloneRow('branches', src.branchId, {
      id: 'gen_random_uuid()', sol_id: q(`SOL-${TAG}-${label}-4`), name: q(`${TAG} ${label} Branch 4`),
      region: q(region), state: q(state), created_by: q(adminId), updated_by: q(adminId),
      created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
    });
    /**
     * A fifth, untouched by anything else, for the two region-LAUNDERING probes.
     *
     * They cannot share a branch with the contact/document probes: removing a branch contact and
     * then editing that branch is a 500 today — `BranchService.update` re-saves the branch with
     * its (now shorter) `contacts` collection and TypeORM nulls the removed row's `branch_id`,
     * which the NOT NULL constraint refuses. That is a real defect, unrelated to region, and a
     * laundering probe that inherited it would report a 500 where the question is 200-vs-403.
     */
    const branchId5 = await cloneRow('branches', src.branchId, {
      id: 'gen_random_uuid()', sol_id: q(`SOL-${TAG}-${label}-5`), name: q(`${TAG} ${label} Branch 5`),
      region: q(region), state: q(state), created_by: q(adminId), updated_by: q(adminId),
      created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
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
    return { label, region, state, branchId, branchId2, branchId3, branchId4, branchId5, pbId, pbId2, assignmentId, payableId, entryId, contactId, documentId };
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

  /**
   * A project made only of EAST branches, so the coverage export has a CONTROL.
   *
   * `GET /reports/coverage/:projectId` refuses a project that touches a region the caller does
   * not hold. Probed only against the shared (multi-region) project, a 403 would be
   * indistinguishable from "this account can never export coverage at all" — which is a
   * different, and wrong, outcome. This is the project it must still be able to export.
   */
  const eastOnlyProjectId = await cloneRow('projects', src.projectId, {
    id: 'gen_random_uuid()', project_number: q(`PRJ-${TAG}-E`), name: q(`${TAG} EAST-only project`),
    created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
    is_active: 'true', version: '1',
  });
  await cloneRow('project_branches', src.pbId, {
    id: 'gen_random_uuid()', project_id: q(eastOnlyProjectId), branch_id: q(east.branchId),
    status: `'PLANNING'`, created_by: q(adminId), updated_by: q(adminId),
    created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
  });

  return { east, west, projectId: src.projectId, clientId: src.clientId, eastOnlyProjectId };
}

/**
 * A region-scoped ADMIN.
 *
 * Four of the routes under test are `@Roles(ADMIN)` — the branch delete and the three child-row
 * deletes — and the two certification accounts are OPERATIONS and DESK. Probing those with the
 * unrestricted `admin` proves nothing about region, and probing them with `cert_ops_east`
 * produces "Insufficient role permissions", which is a refusal by the WRONG rule. So the probe
 * mints an ADMIN that holds EAST and nothing else, cloned off a certification account so the
 * password (and its hash) is the one `login` already knows.
 */
async function scopedAdmin() {
  const username = `rp_admin_east`;
  const existing = await one(`SELECT id FROM users WHERE username = $1`, [username]);
  const src = await one(`SELECT id FROM users WHERE username = 'cert_ops_east'`);
  const adminRole = await one(`SELECT id FROM roles WHERE name = 'ADMIN'`);
  let id = existing?.id;
  if (!id) {
    id = await cloneRow('users', src.id, {
      id: 'gen_random_uuid()', username: q(username), email: q(`${username}@example.com`),
      regions: `'{EAST}'`, must_change_password: 'false', is_active: 'true',
      failed_login_attempts: '0', locked_until: 'NULL', version: '1',
      created_at: 'now()', updated_at: 'now()',
    });
  }
  await sql(`UPDATE users SET regions = '{EAST}', is_active = true, must_change_password = false,
             failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [id]);
  await sql(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
  await sql(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [id, adminRole.id]);
  return username;
}

/**
 * Associate the spare branch through the real route, as the ADMIN, so an `assessments` row
 * exists for it. Returns the project_branch id, or null if the association was refused.
 */
async function associateAsAdmin(adminToken, projectId, branchId) {
  const r = await req(`/projects/${projectId}/branches`, {
    method: 'POST', token: adminToken, body: { branchIds: [branchId] },
  });
  if (!(r.status >= 200 && r.status < 300)) return null;
  const row = await one(
    `SELECT id FROM project_branches WHERE project_id = $1 AND branch_id = $2`, [projectId, branchId]);
  return row?.id ?? null;
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
  declareMutating('region-parity', [
    'SQL: sets users.regions, is_active and must_change_password on a probe account, and rewrites',
    '  its user_roles rows (DELETE then INSERT) so it holds the admin role scoped to one region',
    'SQL: moves a branch between regions/states to build the laundering fixture',
    'creates branches, contacts, documents, remarks and other child rows through the API, and',
    '  deletes them again to measure whether a region-scoped account may write outside its region',
    'THIS IS THE POINT OF THE PROBE: writes that SUCCEED here are the finding. On a deployment',
    '  those are real rows on real records',
  ]);
  const admin = await login('admin', ADMIN_PASSWORD);
  const adminRow = await one(`SELECT id FROM users WHERE username = 'admin'`);
  const ops = await login('cert_ops_east');
  const desk = await login('cert_desk_east');
  const radmin = await login(await scopedAdmin());

  const alive = async (label, token, path) => {
    const r = await req(path, { token });
    t.check(`token alive: ${label} ${path}`, OK(r), `${r.status} ${r.msg ?? ''}`);
    return OK(r);
  };
  const adminAlive = await alive('admin', admin.token, '/branches?limit=1');
  const opsAlive = await alive('cert_ops_east', ops.token, '/branches?limit=1');
  const deskAlive = await alive('cert_desk_east', desk.token, '/validation?limit=1');
  const radminAlive = await alive('rp_admin_east (ADMIN, regions=[EAST])', radmin.token, '/branches?limit=1');
  if (!adminAlive || !opsAlive || !deskAlive || !radminAlive) {
    console.log('\nA token is not alive — every later refusal would be unattributable. Stopping.');
    return t.done();
  }

  const F = await buildFixtures(adminRow.id);
  F.east.pbId3 = await associateAsAdmin(admin.token, F.projectId, F.east.branchId3);
  F.west.pbId3 = await associateAsAdmin(admin.token, F.projectId, F.west.branchId3);
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

  // The document rows this creates (when the route allows it) are what the DELETE probe below
  // keys on — `branch_documents` is empty in this database, so there is nothing else to key on,
  // and once the POST is guarded the EAST half still produces one while the WEST half does not.
  const madeDocs = {};
  const docPost = await pair('POST /branches/:id/documents', async (f) => {
    const r = await req(`/branches/${f.branchId}/documents`, {
      method: 'POST', token: ops.token,
      body: { fileName: `${TAG}-${f.region}.pdf`, filePath: `/tmp/${TAG}.pdf`, fileSize: 12, category: 'OTHER' },
    });
    if (OK(r)) madeDocs[f.region] = r.body?.data?.id;
    return r;
  });
  void docPost;
  // When the WEST post is (correctly) refused there is no WEST document to try to delete, so
  // the admin plants one directly — the DELETE probe must test the DELETE, not the POST.
  for (const f of [F.east, F.west]) {
    if (madeDocs[f.region]) { f.documentId = madeDocs[f.region]; continue; }
    const src = await one(`SELECT id FROM branch_documents ORDER BY created_at DESC LIMIT 1`);
    if (src) {
      f.documentId = await cloneRow('branch_documents', src.id, {
        id: 'gen_random_uuid()', branch_id: q(f.branchId), file_name: q(`${TAG}-${f.region}-del.pdf`),
        created_by: q(adminRow.id), updated_by: q(adminRow.id),
        created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
      });
    }
  }

  await pair('PUT /branches/:id/contacts/:contactId (child-row keyed)', (f) =>
    f.contactId
      ? req(`/branches/${f.branchId}/contacts/${f.contactId}`, {
          method: 'PUT', token: ops.token, body: { notes: `${TAG} touched` } })
      : Promise.resolve({ status: 599, msg: 'no contact fixture' }));

  // ADMIN-only routes, probed with the region-scoped ADMIN so a refusal is about region and
  // not about the role.
  await pair('DELETE /branches/:id/documents/:documentId (child-row keyed, ADMIN)', (f) =>
    f.documentId
      ? req(`/branches/${f.branchId}/documents/${f.documentId}`, { method: 'DELETE', token: radmin.token })
      : Promise.resolve({ status: 599, msg: 'no document fixture' }));

  await pair('DELETE /branches/:id/contacts/:contactId (child-row keyed, ADMIN)', (f) =>
    f.contactId
      ? req(`/branches/${f.branchId}/contacts/${f.contactId}`, { method: 'DELETE', token: radmin.token })
      : Promise.resolve({ status: 599, msg: 'no contact fixture' }));

  await pair('DELETE /branches/:id (ADMIN)', (f) =>
    req(`/branches/${f.branchId4}`, { method: 'DELETE', token: radmin.token }));

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
    const launderTarget = { id: F.east.branchId5 };
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
    const launderTarget = { id: F.east.branchId5 };
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

  /**
   * Expected ALLOWED, and that is the finding rather than a gap.
   *
   * A project is not region-anchored: it is a set of branches and may legitimately span several,
   * which is why `assertProjectInScope` refuses a project outright rather than narrowing it.
   * Applying that here would stop a regional operator editing the project their own branches sit
   * in, and the fields this route writes — name, dates, budget, priority — carry no region. Its
   * read sibling `GET /projects/:id` is deliberately open for the same reason, so guarding the
   * write alone would invert the asymmetry rather than close it. Recorded in
   * `write-region-parity.spec.ts` as a by-design exemption with this reasoning.
   */
  await pair('PUT /projects/:id (project row is not region-anchored — allowed by design)', () =>
    req(`/projects/${F.projectId}`, { method: 'PUT', token: ops.token, body: { scope: `${TAG}` } }),
    { expect: 'allowed' });

  // A branch upload is a bulk POST /branches, and it goes through the same ceiling now.
  {
    const { default: XLSX } = await import('xlsx');
    const sheetFor = (state) => {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([
        ['BRANCH', 'BRANCH_NAME', 'Branch Address', 'STATE', 'DISTRICT', 'City', 'Pincode'],
        [`SOL-${TAG}-UP-${state}`, `${TAG} upload ${state}`, '1 Test Road', state, 'TESTDIST', 'Testtown', '400001'],
      ]);
      XLSX.utils.book_append_sheet(wb, ws, 'Branches');
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    const upload = async (state) => {
      const form = new FormData();
      form.append('file', new Blob([sheetFor(state)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }), `${TAG}-${state}.xlsx`);
      const r = await fetch(`${API}/projects/${F.projectId}/branches/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${ops.token}` }, body: form,
      });
      let j = null; try { j = await r.json(); } catch {}
      return { status: r.status, body: j, msg: j?.message ?? null };
    };
    const control = await upload(EAST_STATE);
    const test = await upload(WEST_STATE);
    const ok = OK(control) && DENIED(test);
    results.push({
      name: 'POST /projects/:id/branches/upload (bulk branch create)',
      verdict: ok ? `DENIED ${classify(test)}` : `LEAK ${classify(test)}`,
      control: classify(control), test: classify(test),
    });
    t.check('POST /projects/:id/branches/upload refuses a workbook of out-of-region branches',
      ok, `control ${EAST_STATE} ${classify(control)} ${control.msg ?? ''} | test ${WEST_STATE} ${classify(test)} ${test.msg ?? ''}`);
  }

  // ── validation (DESK) ────────────────────────────────────────────────────

  await pair('POST /validation', (f) =>
    req('/validation', { method: 'POST', token: desk.token, body: { projectBranchId: f.pbId } }));

  {
    /**
     * Both halves, because "zero rows" is what a scoped list AND a broken list look like.
     *
     * The control is the EAST case this probe registered a moment ago: it must still be in the
     * response. Only then does "no WEST case came back" mean the ceiling, rather than the query
     * having stopped returning anything at all.
     */
    const eastCase = await one(
      `SELECT vc.id FROM validation_cases vc WHERE vc.project_branch_id = $1 ORDER BY vc.created_at DESC LIMIT 1`,
      [F.east.pbId]);
    const r = await req('/validation?limit=200', { token: desk.token });
    const ids = (r.body?.data ?? []).map((c) => c.id);
    const outside = ids.length
      ? await sql(
          `SELECT count(*)::int AS n FROM validation_cases vc
             JOIN project_branches pb ON pb.id = vc.project_branch_id
             JOIN branches b ON b.id = pb.branch_id
            WHERE vc.id = ANY($1) AND b.region IS NOT NULL AND b.region <> 'EAST'`, [ids])
      : [{ n: 0 }];
    const controlPresent = !eastCase || ids.includes(eastCase.id);
    const ok = OK(r) && outside[0].n === 0 && controlPresent;
    results.push({
      name: 'GET /validation',
      verdict: ok ? 'SCOPED' : (controlPresent ? 'LEAK' : 'INCONCLUSIVE'),
      control: `own EAST case returned: ${controlPresent}`,
      test: `${outside[0].n} of ${ids.length} out of region`,
    });
    t.check('GET /validation returns the desk’s own EAST case and no out-of-region case', ok,
      `${r.status}: ${outside[0].n} of ${ids.length} returned cases are outside EAST; own EAST case present=${controlPresent}`);
  }

  // ── call logs & remarks ──────────────────────────────────────────────────

  await pair('GET /call-logs?projectBranchId=', (f) =>
    req(`/call-logs?projectBranchId=${f.pbId}`, { token: ops.token }));

  await pair('POST /call-logs', (f) =>
    f.assayerId && f.pbId3
      ? req('/call-logs', { method: 'POST', token: ops.token,
          body: { projectBranchId: f.pbId3, assayerId: f.assayerId, outcome: 'NO_ANSWER', notes: TAG } })
      : Promise.resolve({ status: 599, msg: 'no assayer/assessment fixture' }));

  const madeRemarks = {};
  await pair('POST /assayer-remarks', async (f) => {
    if (!f.assayerId) return { status: 599, msg: 'no assayer fixture' };
    const r = await req('/assayer-remarks', { method: 'POST', token: ops.token,
      body: { assayerId: f.assayerId, rating: 2, category: 'QUALITY', text: `${TAG} probe remark` } });
    if (OK(r)) madeRemarks[f.region] = r.body?.data?.id;
    return r;
  });

  await pair('GET /assayer-remarks/assayer/:assayerId', (f) =>
    f.assayerId
      ? req(`/assayer-remarks/assayer/${f.assayerId}`, { token: ops.token })
      : Promise.resolve({ status: 599, msg: 'no assayer fixture' }));

  // The remark DELETE is keyed on the remark's own id — a moderator passes the author check for
  // every remark in the company, so region is the only thing standing between them and another
  // region's record. A refused WEST create leaves no WEST remark, so the admin plants one.
  for (const f of [F.east, F.west]) {
    if (madeRemarks[f.region]) { f.remarkId = madeRemarks[f.region]; continue; }
    const src = await one(`SELECT id FROM assayer_remarks ORDER BY created_at DESC LIMIT 1`);
    if (src && f.assayerId) {
      f.remarkId = await cloneRow('assayer_remarks', src.id, {
        id: 'gen_random_uuid()', assayer_id: q(f.assayerId), text: q(`${TAG} planted ${f.region}`),
        created_by: q(adminRow.id), updated_by: q(adminRow.id),
        created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
      });
    }
  }
  await pair('DELETE /assayer-remarks/:id (child-row keyed)', (f) =>
    f.remarkId
      ? req(`/assayer-remarks/${f.remarkId}`, { method: 'DELETE', token: ops.token })
      : Promise.resolve({ status: 599, msg: 'no remark fixture' }));

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
    const west = await workbookHas('/reports/billing', ops.token, westEntry?.entry_number ?? '__no_such_row__');
    const east = await workbookHas('/reports/billing', ops.token, eastEntry?.entry_number ?? '__no_such_row__');
    const ok = west.status === 200 && west.found === false && east.found === true;
    results.push({ name: 'GET /reports/billing (export)', verdict: ok ? 'SCOPED' : 'LEAK', control: `east row present: ${east.found}`, test: `west row present: ${west.found}` });
    t.check('GET /reports/billing workbook carries the EAST line and NOT the WEST line', ok,
      `status ${west.status}; EAST line present=${east.found}; WEST line present=${west.found}`);
  }

  {
    // Control: a project made only of EAST branches must still export.
    // Test: the shared project spans regions, so the whole export is refused rather than
    // silently narrowed — a coverage percentage over a shortened branch list is a wrong number
    // in a file that gets sent to the client.
    const control = await req(`/reports/coverage/${F.eastOnlyProjectId}`, { token: ops.token });
    const test = await req(`/reports/coverage/${F.projectId}`, { token: ops.token });
    const ok = OK(control) && DENIED(test);
    results.push({
      name: 'GET /reports/coverage/:projectId',
      verdict: ok ? `DENIED ${classify(test)}` : (OK(control) ? `LEAK ${classify(test)}` : 'INCONCLUSIVE'),
      control: classify(control), test: classify(test),
    });
    t.check('GET /reports/coverage/:projectId exports an EAST-only project and refuses a cross-region one',
      ok, `control ${classify(control)} ${control.msg ?? ''} | test ${classify(test)} ${test.msg ?? ''}`);
  }

  {
    const r = await req('/reports/billing/jobs', { method: 'POST', token: ops.token });
    const ok = OK(r);
    t.check('POST /reports/billing/jobs accepted (its scope is checked in the worker payload)', ok, `${r.status}`);
  }

  // ── the other half: an unrestricted account must be untouched ────────────
  //
  // Every guard added here returns on its first line when the caller holds no region assignment,
  // and every export falls back to the call it made before. That is the claim; a tightening that
  // quietly narrowed the national view would be a worse defect than the leak it closed, so it is
  // checked against the running stack rather than asserted from the code.

  {
    const westBranch = await one(`SELECT id FROM branches WHERE region = 'WEST' AND is_active LIMIT 1`);
    const westPb = await one(
      `SELECT pb.id FROM project_branches pb JOIN branches b ON b.id = pb.branch_id WHERE b.region = 'WEST' LIMIT 1`);
    const payable = await one(`SELECT id FROM assayer_payables WHERE status = 'PENDING' AND is_active LIMIT 1`);

    const readWest = await req(`/branches/${westBranch.id}`, { token: admin.token });
    t.check('national: admin still reads a WEST branch', OK(readWest), `${readWest.status}`);

    const editWest = await req(`/branches/${westBranch.id}`, {
      method: 'PUT', token: admin.token, body: { managerName: `${TAG} national` } });
    t.check('national: admin still edits a WEST branch', OK(editWest), `${editWest.status} ${editWest.msg ?? ''}`);

    const coverAll = await req(`/reports/coverage/${F.projectId}`, { token: admin.token });
    t.check('national: admin still exports a cross-region coverage report', OK(coverAll), `${coverAll.status}`);

    const callsWest = await req(`/call-logs?projectBranchId=${westPb.id}`, { token: admin.token });
    t.check('national: admin still reads a WEST branch call history', OK(callsWest), `${callsWest.status}`);

    if (payable) {
      const bank = await req('/billing-engine/payouts/bank-file', {
        method: 'POST', token: admin.token, body: { payableIds: [payable.id] } });
      t.check('national: admin still pulls a bank file for any payout', OK(bank), `${bank.status} ${bank.msg ?? ''}`);
    }

    const allCases = await one(`SELECT count(*)::int AS n FROM validation_cases WHERE is_active`);
    const queue = await req('/validation?limit=200', { token: admin.token });
    t.check('national: admin validation queue is still national',
      OK(queue) && (queue.body?.data ?? []).length === Math.min(allCases.n, 200),
      `${(queue.body?.data ?? []).length} returned of ${allCases.n} active`);

    // The export that was leaking is also the one most easily over-tightened: every active
    // client line must still be in the national workbook, counted rather than eyeballed.
    const r = await fetch(`${API}/reports/billing`, { headers: { Authorization: `Bearer ${admin.token}` } });
    const { default: XLSX } = await import('xlsx');
    const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
    const text = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
    const lines = await sql(`SELECT entry_number FROM billing_entries WHERE is_active`);
    const present = lines.filter((e) => text.includes(e.entry_number)).length;
    t.check('national: admin billing export still carries every client line',
      r.status === 200 && present === lines.length, `${present} of ${lines.length} lines present`);
  }

  // ── report ───────────────────────────────────────────────────────────────
  console.log('\n─── per-route verdicts ───');
  for (const r of results) console.log(`  ${r.verdict.padEnd(18)} ${r.name}   [control ${r.control} | test ${r.test}]`);

  await t.done();
}

main().catch((e) => { console.error(e); process.exit(2); });
