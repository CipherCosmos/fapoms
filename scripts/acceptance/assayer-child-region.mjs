/**
 * FAPOMS — does the region ceiling reach an assayer through their CHILD rows?
 *
 * `GET /assayers/:id` has refused a region-assigned account an out-of-region appraiser since the
 * ceiling existed. Sixteen sibling routes did not, because they are keyed not on the person but on
 * one of their child rows — a commercial profile, a KYC document, an empanelment, a workforce
 * attribute, a score override, a reference, an import issue — and `RegionGuardService` had no
 * method that took such an id. An account refused a plain READ of a WEST appraiser could still
 * edit what they are paid, download their PAN card, delete it, attest that it matched the
 * original, and withdraw the empanelment that makes them eligible for a bank's work.
 *
 * This probe asks the same question of each of those routes, the same way `region-parity.mjs`
 * asks it of the branch and billing ones:
 *
 *  - every probe runs TWICE — once against a fixture the account HOLDS (the control, which must
 *    succeed) and once against one it does not (the test, which must be refused), differing only
 *    in the region of the assayer the child row hangs off. A refused control means the account
 *    cannot do this at all and the test says nothing about region, so the pair is INCONCLUSIVE
 *    rather than a pass;
 *  - every token is proved alive on a permitted read first, so a blanket 401 cannot be written up
 *    as a correct denial;
 *  - 403 and 404 are both denials and are reported separately, because they deny by different
 *    rules — several of these routes answer "no such row" for a row the caller may not have, which
 *    is deliberate and worth seeing;
 *  - a 429 that survives the retry budget is UNKNOWN, never a denial.
 *
 * Three things here are not paired probes, and each says why at its own call site: the two
 * field-app routes that only an assayer's own handset can call, and the import issue that names
 * no assayer at all — the row every desk must still be able to close.
 *
 * Usage:  AC_ENV_FILE=… node scripts/acceptance/assayer-child-region.mjs
 */
/**
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * SAFETY CLASSIFICATION: DESTRUCTIVE
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * password    : rotates an assayer app login it minted itself (gated, announced).
 * db writes   : SQL UPDATE on users.regions / is_active / must_change_password for the probe
 *               account; clones rows into assayers and every child table.
 * role changes: DELETEs and re-INSERTs that account's user_roles to make it a region-scoped ADMIN.
 * deletion    : DELETEs assayer child rows through the API (attributes, overrides, references,
 *               empanelments, document files) as part of the measurement.
 * teardown    : none — fixture rows are left behind under the run tag.
 * gate        : declareMutating + AC_ALLOW_WRITES; rotation needs AC_ALLOW_PASSWORD_ROTATION.
 * NOTE        : the writes that SUCCEED are the finding. On a deployment they are real.
 *
 * The full table for every script here is in scripts/acceptance/README.md.
 */
import { API, req, login, sql, one, tally, env, declareMutating, canRotatePassword } from './_lib.mjs';

const TAG = `AC${Date.now()}`;
const ADMIN_PASSWORD = env.AC_PASSWORD;

// ── row cloning ────────────────────────────────────────────────────────────
//
// Cloned from a row the seed already produced rather than assembled column by column: a
// hand-written INSERT drifts from the schema the moment a NOT NULL column is added, and a fixture
// that fails to insert reads exactly like a route that refused. Same helper as region-parity.mjs.

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

/**
 * A region-scoped ADMIN, minted the way region-parity.mjs mints one.
 *
 * Two of the routes here are `@Roles(ADMIN)` or need `assayer:delete:organization`, which
 * OPERATIONS does not hold. Probing those with `cert_ops_east` produces "Insufficient role
 * permissions" — a refusal by the WRONG rule, which would read as a region denial — and probing
 * them with the unrestricted `admin` proves nothing about region at all.
 */
async function scopedAdmin() {
  const username = 'rp_admin_east';
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

// ── fixtures ───────────────────────────────────────────────────────────────

/**
 * A 1x1 PNG. Small, and a type both the upload allow-list and the malware scanner accept — the
 * rig runs with `FILE_SCAN_REQUIRED=true`, so a file the scanner refuses would fail the fixture
 * build and look exactly like a route refusing the upload.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function uploadScan(token, assayerId, requirement) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), `${TAG}.png`);
  const r = await fetch(`${API}/assayers/${assayerId}/document/${requirement}/file`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  let j = null; try { j = await r.json(); } catch { /* a non-JSON body is itself the answer */ }
  return { status: r.status, body: j, msg: j?.message ?? null };
}

/**
 * One assayer per region, and one of every child row hanging off each.
 *
 * Rows the seed already has are cloned; the two tables that are empty in this database
 * (`assayer_score_overrides`, `assayer_references`) and the document — which needs a real object
 * in storage for the download probes to mean anything — are created through the product's own
 * routes as the national ADMIN, so the fixture is a row the application agrees exists.
 */
async function buildSide(label, region, adminId, adminToken) {
  const assayerSrc = await one(`SELECT id FROM assayers WHERE region IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  if (!assayerSrc) throw new Error('no assayer to clone from');
  const assayerId = await cloneRow('assayers', assayerSrc.id, {
    id: 'gen_random_uuid()', region: q(region), assayer_code: q(`AC-${TAG}-${label}`),
    first_name: q(`${TAG}`), last_name: q(label),
    created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
    is_active: 'true', version: '1',
  });

  const f = { label, region, assayerId };

  const commercialSrc = await one(`SELECT id FROM assayer_commercial_profiles ORDER BY created_at DESC LIMIT 1`);
  if (commercialSrc) {
    f.commercialId = await cloneRow('assayer_commercial_profiles', commercialSrc.id, {
      id: 'gen_random_uuid()', assayer_id: q(assayerId),
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    });
  }

  const empSrc = await one(`SELECT id FROM assayer_client_empanelments ORDER BY created_at DESC LIMIT 1`);
  if (empSrc) {
    f.empanelmentId = await cloneRow('assayer_client_empanelments', empSrc.id, {
      id: 'gen_random_uuid()', assayer_id: q(assayerId),
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    });
  }

  // Two attributes: the PUT probe must leave a pristine row for the DELETE probe, or the delete
  // would be reporting on a row the edit had already touched.
  const attrSrc = await one(`SELECT id FROM workforce_attributes ORDER BY created_at DESC LIMIT 1`);
  if (attrSrc) {
    const mkAttr = (n) => cloneRow('workforce_attributes', attrSrc.id, {
      id: 'gen_random_uuid()', assayer_id: q(assayerId), name: q(`${TAG}-${label}-${n}`),
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1',
    });
    f.attributeId = await mkAttr('edit');
    f.attributeId2 = await mkAttr('delete');
  }

  const issueSrc = await one(`SELECT id FROM assayer_import_issues ORDER BY created_at DESC LIMIT 1`);
  if (issueSrc) {
    // `UQ_assayer_import_issue_cell` is unique on (source_sheet, source_row, source_column) — one
    // issue per spreadsheet cell, which is the point of the table — so a clone that keeps the
    // source row's coordinates collides with it. Each fixture names a cell of its own.
    const mkIssue = (slot, over) => cloneRow('assayer_import_issues', issueSrc.id, {
      id: 'gen_random_uuid()', resolved_at: 'NULL', resolved_by: 'NULL', resolution: 'NULL',
      source_sheet: q(`${TAG}-${label}`), source_row: String(slot), source_column: q(`col-${slot}`),
      created_by: q(adminId), updated_by: q(adminId), created_at: 'now()', updated_at: 'now()',
      is_active: 'true', version: '1', ...over,
    });
    f.issueId = await mkIssue(1, { assayer_id: q(assayerId) });
    f.issueId2 = await mkIssue(2, { assayer_id: q(assayerId) });
  }

  // Through the product: two references (one to mark checked, one to delete) and one score
  // override. Both tables are empty in this database, so there is nothing to clone.
  for (const [key, suffix] of [['referenceId', 'checked'], ['referenceId2', 'delete']]) {
    const r = await req(`/assayers/${assayerId}/reference`, {
      method: 'POST', token: adminToken,
      body: { fullName: `${TAG} ${label} ${suffix}`, phone: '9876500022', relationship: 'Former manager' },
    });
    if (r.status >= 200 && r.status < 300) f[key] = r.body?.data?.id;
    else f[`${key}Error`] = `${r.status} ${r.msg ?? ''}`;
  }

  const ov = await req(`/assayers/${assayerId}/qualification/override`, {
    method: 'PUT', token: adminToken,
    body: { dimension: 'payability', value: 60, reason: `${TAG} fixture` },
  });
  if (ov.status >= 200 && ov.status < 300) {
    const row = await one(
      `SELECT id FROM assayer_score_overrides WHERE assayer_id = $1 AND is_active ORDER BY created_at DESC LIMIT 1`,
      [assayerId]);
    f.overrideId = row?.id;
  } else f.overrideIdError = `${ov.status} ${ov.msg ?? ''}`;

  // The document, and a real object behind it. `attachFile` writes an `assayer_document_versions`
  // row per upload, which is what the version-file probe addresses.
  const doc = await req(`/assayers/${assayerId}/document/PAN_CARD`, {
    method: 'PUT', token: adminToken, body: { softCopyReceived: true },
  });
  if (!(doc.status >= 200 && doc.status < 300)) f.documentIdError = `${doc.status} ${doc.msg ?? ''}`;
  const up = await uploadScan(adminToken, assayerId, 'PAN_CARD');
  if (!(up.status >= 200 && up.status < 300)) f.documentFileError = `${up.status} ${up.msg ?? ''}`;
  const docRow = await one(
    `SELECT id, current_version_id AS "versionId", file_paths AS "filePaths"
       FROM assayer_documents WHERE assayer_id = $1 ORDER BY created_at DESC LIMIT 1`, [assayerId]);
  f.documentId = docRow?.id;
  f.versionId = docRow?.versionId;
  f.fileCount = Array.isArray(docRow?.filePaths) ? docRow.filePaths.length : 0;

  return f;
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

  if (!ADMIN_PASSWORD) throw new Error('AC_PASSWORD is required (admin builds the fixtures)');
  declareMutating('assayer-child-region', [
    'SQL: sets users.regions, is_active and must_change_password on a probe account, and rewrites',
    '  its user_roles rows (DELETE then INSERT) so it holds the admin role scoped to one region',
    'creates and deletes assayer child rows through the API — workforce attributes, qualification',
    '  overrides, references, empanelments and document files — on real assayer records',
    'rotates an assayer app credential through POST /assayers/me/change-password, which needs',
    '  AC_ALLOW_PASSWORD_ROTATION=1 as well',
    'THIS IS THE POINT OF THE PROBE: writes that SUCCEED here are the finding',
  ]);
  const admin = await login('admin', ADMIN_PASSWORD);
  const adminRow = await one(`SELECT id FROM users WHERE username = 'admin'`);
  const ops = await login('cert_ops_east');
  const radmin = await login(await scopedAdmin());

  const alive = async (label, token, path) => {
    const r = await req(path, { token });
    t.check(`token alive: ${label} ${path}`, OK(r), `${r.status} ${r.msg ?? ''}`);
    return OK(r);
  };
  const adminAlive = await alive('admin', admin.token, '/assayers?limit=1');
  const opsAlive = await alive('cert_ops_east', ops.token, '/assayers?limit=1');
  const radminAlive = await alive('rp_admin_east (ADMIN, regions=[EAST])', radmin.token, '/assayers?limit=1');
  if (!adminAlive || !opsAlive || !radminAlive) {
    console.log('\nA token is not alive — every later refusal would be unattributable. Stopping.');
    return t.done();
  }

  const east = await buildSide('EAST', 'EAST', adminRow.id, admin.token);
  const west = await buildSide('WEST', 'WEST', adminRow.id, admin.token);
  const F = { east, west };
  console.log(`\nfixtures ${TAG}: EAST assayer ${east.assayerId}  WEST assayer ${west.assayerId}`);
  for (const f of [east, west]) {
    const missing = Object.keys(f).filter((k) => k.endsWith('Error'));
    if (missing.length) console.log(`  ${f.label} fixture gaps: ${missing.map((k) => `${k}=${f[k]}`).join('; ')}`);
  }
  console.log('');

  // The READ ceiling, which is the thing all of this is being compared against. If this is not
  // refusing, nothing below means anything.
  const readEast = await req(`/assayers/${east.assayerId}`, { token: ops.token });
  const readWest = await req(`/assayers/${west.assayerId}`, { token: ops.token });
  t.check('READ ceiling: EAST assayer readable by EAST account', OK(readEast), `${readEast.status}`);
  t.check('READ ceiling: WEST assayer refused to EAST account', readWest.status === 403,
    `${classify(readWest)} ${readWest.msg ?? ''}`);

  /** One paired probe. The verdict is only about region when the control succeeded. */
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

  const noFixture = (what) => Promise.resolve({ status: 599, msg: `no ${what} fixture` });

  // ── what the person is paid ──────────────────────────────────────────────

  await pair('PUT /assayers/commercial/:id (profile id)', (f) =>
    f.commercialId
      ? req(`/assayers/commercial/${f.commercialId}`, {
          method: 'PUT', token: ops.token, body: { baseFee: 1234 } })
      : noFixture('commercial profile'));

  // ── who the planning engine will send ────────────────────────────────────

  await pair('PUT /assayers/workforce-attribute/:id (attribute id)', (f) =>
    f.attributeId
      ? req(`/assayers/workforce-attribute/${f.attributeId}`, {
          method: 'PUT', token: ops.token, body: { level: `${TAG}` } })
      : noFixture('workforce attribute'));

  // `assayer:delete:organization`, which OPERATIONS does not hold — probed with the region-scoped
  // ADMIN so a refusal is about region and not about the role.
  await pair('DELETE /assayers/workforce-attribute/:id (attribute id, ADMIN)', (f) =>
    f.attributeId2
      ? req(`/assayers/workforce-attribute/${f.attributeId2}`, { method: 'DELETE', token: radmin.token })
      : noFixture('workforce attribute'));

  await pair('DELETE /assayers/qualification/override/:id (override id)', (f) =>
    f.overrideId
      ? req(`/assayers/qualification/override/${f.overrideId}`, { method: 'DELETE', token: ops.token })
      : noFixture('score override'));

  // ── the identity gate ────────────────────────────────────────────────────

  await pair('POST /assayers/reference/:id/checked (reference id)', (f) =>
    f.referenceId
      ? req(`/assayers/reference/${f.referenceId}/checked`, {
          method: 'POST', token: ops.token, body: { remarks: `${TAG} spoke to them` } })
      : noFixture('reference'));

  await pair('DELETE /assayers/reference/:id (reference id)', (f) =>
    f.referenceId2
      ? req(`/assayers/reference/${f.referenceId2}`, { method: 'DELETE', token: ops.token })
      : noFixture('reference'));

  // ADMIN-only route, so the region-scoped ADMIN again.
  await pair('DELETE /assayers/empanelment/:id (empanelment id, ADMIN)', (f) =>
    f.empanelmentId
      ? req(`/assayers/empanelment/${f.empanelmentId}`, { method: 'DELETE', token: radmin.token })
      : noFixture('empanelment'));

  // ── the KYC scans ────────────────────────────────────────────────────────
  //
  // Read before written, and the destructive one last: a delete that ran first would make every
  // later probe a statement about a document with no file rather than about region.

  await pair('GET /assayers/document/:id/file/:index (document id — the PAN scan itself)', (f) =>
    f.documentId
      ? req(`/assayers/document/${f.documentId}/file/0`, { token: ops.token })
      : noFixture('document'));

  await pair('GET /assayers/document/:id/version/:versionId/file (retained evidence)', (f) =>
    f.documentId && f.versionId
      ? req(`/assayers/document/${f.documentId}/version/${f.versionId}/file`, { token: ops.token })
      : noFixture('document version'));

  await pair('POST /assayers/document/:id/verify (attests the scan matched the original)', (f) =>
    f.documentId
      ? req(`/assayers/document/${f.documentId}/verify`, {
          method: 'POST', token: ops.token,
          body: { verdict: 'REJECTED', rejectionReason: 'ILLEGIBLE', remarks: `${TAG} probe` } })
      : noFixture('document'));

  await pair('DELETE /assayers/document/:id/file/:index (destroys the scan)', (f) =>
    f.documentId
      ? req(`/assayers/document/${f.documentId}/file/0`, { method: 'DELETE', token: ops.token })
      : noFixture('document'));

  // ── the roster import queue ──────────────────────────────────────────────

  await pair('POST /assayers/roster/import-issues/:id/resolve (issue id)', (f) =>
    f.issueId
      ? req(`/assayers/roster/import-issues/${f.issueId}/resolve`, {
          method: 'POST', token: ops.token, body: { resolution: `${TAG} decided` } })
      : noFixture('import issue'));

  await pair('POST /assayers/roster/import-issues/resolve (batch — the way round the singular)', (f) =>
    f.issueId2
      ? req('/assayers/roster/import-issues/resolve', {
          method: 'POST', token: ops.token, body: { ids: [f.issueId2], resolution: `${TAG} decided` } })
      : noFixture('import issue'));

  /**
   * An import issue that names NOBODY must stay closable by a scoped desk.
   *
   * The commonest unresolved row is a source code the importer could not match to a person, so it
   * has no assayer and therefore no region. `listIssues` shows those rows to every desk on the
   * grounds that a row nobody can see is a row nobody can fix; if the write side refused them,
   * the queue would fill with entries a regional desk could see and never close. Not a pair —
   * there is no out-of-region counterpart of a row that belongs to no region — so it is asserted
   * directly, and it is the case a too-eager guard would break.
   */
  {
    const issueSrc = await one(`SELECT id FROM assayer_import_issues ORDER BY created_at DESC LIMIT 1`);
    const orphanId = await cloneRow('assayer_import_issues', issueSrc.id, {
      id: 'gen_random_uuid()', assayer_id: 'NULL', resolved_at: 'NULL', resolved_by: 'NULL',
      resolution: 'NULL', source_sheet: q(`${TAG}-ORPHAN`), source_row: '1',
      source_column: q('unmatched-code'),
      created_by: q(adminRow.id), updated_by: q(adminRow.id),
      created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
    });
    const r = await req(`/assayers/roster/import-issues/${orphanId}/resolve`, {
      method: 'POST', token: ops.token, body: { resolution: `${TAG} unmatched code, no such person` } });
    results.push({ name: 'import issue naming no assayer stays closable', verdict: OK(r) ? 'ALLOWED' : `REFUSED ${classify(r)}`, control: 'n/a', test: classify(r) });
    t.check('a scoped desk can still close an import issue that names no assayer', OK(r),
      `${classify(r)} ${r.msg ?? ''}`);
  }

  // ── the field-app routes ─────────────────────────────────────────────────

  await pair('PUT /assayers/:id/base-location (staff may set anyone’s)', (f) =>
    req(`/assayers/${f.assayerId}/base-location`, {
      method: 'PUT', token: ops.token, body: { latitude: 22.57, longitude: 88.36 } }));

  await pair('POST /assayers/:id/location-pings (the trail a travel claim is paid against)', (f) =>
    req(`/assayers/${f.assayerId}/location-pings`, {
      method: 'POST', token: ops.token,
      body: { pings: [{ latitude: 22.57, longitude: 88.36, recordedAt: new Date().toISOString() }] } }));

  /**
   * `PUT /assayers/:id/live-location` and `PUT /assayers/:id/live` refuse every caller who is not
   * the assayer themselves — `req.user.id !== id` is a 403 before anything else — so there is no
   * staff pair to run: both halves would be refused by ownership and the result would say nothing
   * about region. What CAN be checked, and is the only thing worth checking, is that adding the
   * assertion did not break the handset: an ASSAYER principal carries no `users.regions`, so the
   * guard must return on its first line and the route must behave exactly as before.
   */
  {
    const code = `AC-${TAG}-APP`;
    const appAssayerId = await cloneRow('assayers', east.assayerId, {
      id: 'gen_random_uuid()', assayer_code: q(code), region: `'WEST'`,
      // Both columns, together: `chk_assayers_lifecycle_status_projection` requires `status` to
      // be the projection of `lifecycle_status`, and ACTIVE is the only lifecycle state that
      // projects to an ACTIVE status. Setting one alone is refused by the database.
      lifecycle_status: `'ACTIVE'`, status: `'ACTIVE'`,
      created_by: q(adminRow.id), updated_by: q(adminRow.id),
      created_at: 'now()', updated_at: 'now()', is_active: 'true', version: '1',
    });
    const issued = await req(`/assayers/${appAssayerId}/app-access`, {
      method: 'POST', token: admin.token, body: {} });
    const temp = issued.body?.data?.temporaryPassword ?? null;
    if (!temp) {
      t.check('field app: could mint an assayer login to prove the guard is a no-op for them',
        false, `POST /assayers/:id/app-access ${classify(issued)} ${issued.msg ?? ''} — cannot run the no-regression check`);
    } else {
      /**
       * An assayer is not a `users` row, so `_lib.login` cannot clear their forced password
       * change: it rotates through `POST /users/me/change-password`, which 404s for an assayer
       * principal. The assayer counterpart is `POST /assayers/me/change-password`. Rotating is
       * not optional — `mustChangePassword` is enforced on every request, not only at login, so
       * a token taken straight from the login response 403s on the very next call and would read
       * as the new region assertion refusing the handset.
       */
      const APP_PASSWORD = 'Field!App2026x8821';
      let tok = null;
      const mayRotate = canRotatePassword(code,
        'the probe minted this assayer app login itself and must clear its forced rotation');
      const first = mayRotate
        ? await req('/auth/login', { method: 'POST', body: { username: code, password: temp } })
        : { status: 0, body: null, msg: 'not attempted — credential writes are off for this run' };
      const firstTok = first.body?.data?.accessToken;
      if (firstTok) {
        const rotate = await req('/assayers/me/change-password', {
          method: 'POST', token: firstTok,
          body: { currentPassword: temp, newPassword: APP_PASSWORD } });
        if (rotate.status >= 200 && rotate.status < 300) {
          const second = await req('/auth/login', { method: 'POST', body: { username: code, password: APP_PASSWORD } });
          tok = second.body?.data?.accessToken ?? null;
        }
      }
      if (!tok) {
        t.check('field app: assayer could sign in', false,
          `login ${classify(first)} ${first.msg ?? ''} — no-regression check not run`);
      } else {
        // Deliberately a WEST assayer driven by their own token: if the new assertion were reading
        // a region off an ASSAYER principal it would refuse here, and the field app would be dead
        // for everyone outside whichever region the token appeared to hold.
        const live = await req(`/assayers/${appAssayerId}/live-location`, {
          method: 'PUT', token: tok, body: { latitude: 19.07, longitude: 72.87 } });
        const track = await req(`/assayers/${appAssayerId}/live`, {
          method: 'PUT', token: tok, body: { enabled: true } });
        const pings = await req(`/assayers/${appAssayerId}/location-pings`, {
          method: 'POST', token: tok,
          body: { pings: [{ latitude: 19.07, longitude: 72.87, recordedAt: new Date().toISOString() }] } });
        for (const [name, r] of [['live-location', live], ['live', track], ['location-pings', pings]]) {
          results.push({ name: `field app: own ${name}`, verdict: OK(r) ? 'ALLOWED' : `REFUSED ${classify(r)}`, control: 'n/a', test: classify(r) });
          t.check(`field app: an assayer can still write their own ${name}`, OK(r),
            `${classify(r)} ${r.msg ?? ''}`);
        }
        // And the ownership check is still the gate it always was: the same token aimed at
        // somebody else must still be refused. The region assertion was added beside this check,
        // never in place of it.
        const other = await req(`/assayers/${east.assayerId}/live-location`, {
          method: 'PUT', token: tok, body: { latitude: 19.07, longitude: 72.87 } });
        t.check('field app: one assayer still cannot write another’s live location',
          DENIED(other), `${classify(other)} ${other.msg ?? ''}`);
      }
    }
  }

  // ── the other half: an unrestricted account must be untouched ────────────
  //
  // Every guard added here returns on its first line when the caller holds no region assignment.
  // A tightening that quietly narrowed the national desks would be a worse defect than the leak it
  // closed, so it is checked against the running stack rather than asserted from the code.

  {
    const w = F.west;
    const checks = [
      ['national: admin still reads a WEST assayer', () => req(`/assayers/${w.assayerId}`, { token: admin.token })],
      ['national: admin still downloads a WEST PAN scan', () =>
        w.documentId ? req(`/assayers/document/${w.documentId}/file/0`, { token: admin.token })
                     : Promise.resolve({ status: 599, msg: 'no document fixture' })],
      ['national: admin still edits a WEST commercial profile', () =>
        w.commercialId ? req(`/assayers/commercial/${w.commercialId}`, { method: 'PUT', token: admin.token, body: { baseFee: 999 } })
                       : Promise.resolve({ status: 599, msg: 'no commercial fixture' })],
      ['national: admin still resolves a WEST import issue', () =>
        w.issueId2 ? req(`/assayers/roster/import-issues/${w.issueId2}/resolve`, {
                       method: 'POST', token: admin.token, body: { resolution: `${TAG} national` } })
                   : Promise.resolve({ status: 599, msg: 'no import issue fixture' })],
      ['national: admin still sets a WEST base location', () =>
        req(`/assayers/${w.assayerId}/base-location`, { method: 'PUT', token: admin.token, body: { latitude: 19.07, longitude: 72.87 } })],
    ];
    for (const [name, run] of checks) {
      const r = await run();
      t.check(name, OK(r), `${classify(r)} ${r.msg ?? ''}`);
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  console.log('\n─── per-route verdicts ───');
  for (const r of results) console.log(`  ${r.verdict.padEnd(18)} ${r.name}   [control ${r.control} | test ${r.test}]`);

  await t.done();
}

main().catch((e) => { console.error(e); process.exit(2); });
