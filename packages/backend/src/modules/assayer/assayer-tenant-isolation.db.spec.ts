/**
 * TENANT ISOLATION CERTIFICATION — the §8 acceptance matrix for finding F-03.
 *
 * ## What F-03 was
 *
 * The assayer routes enforced no tenant boundary at all. `AssayerService.findOne` read
 * `where: { id, isActive: true }` — no organisation predicate — and so did the lifecycle, delete,
 * dossier, commercial, sensitive-field and list paths. The only ownership check anywhere on those
 * routes was `regionGuard.assertAssayerInScope`, which compares the record's `region` column (a
 * different question) and early-returns for any account with no region assignment, which is every
 * account by default.
 *
 * Reproduced against the running system: an OPERATIONS user in organisation A did
 * `GET /assayers/<orgB-id>` → 200 with the full record; `POST /assayers/<orgB-id>/lifecycle` → 201,
 * suspending another tenant's assayer; `GET /assayers/<orgB-id>/sensitive/bank` → 200 with another
 * tenant's bank account number in CLEARTEXT; `DELETE /assayers/<orgB-id>` → 204. A nonexistent
 * UUID correctly 404'd, so those 200s were genuine cross-tenant reads and not a quirk of the
 * error handler.
 *
 * ## Why this file exists rather than a unit spec
 *
 * The scoping lives in WHERE clauses and in an `AsyncLocalStorage` context populated by a global
 * interceptor after the JWT guard runs. A mock cannot prove any of that: it cannot show that the
 * predicate reached Postgres, that the interceptor filled the store on a real request, or — the
 * part that matters most — that the row is still there afterwards. An HTTP 404 is not evidence
 * that nothing was written. So every case below asserts against the DATABASE as well as the
 * response, and every mutation case snapshots the row before and after.
 *
 * ## The status code, and why it is 404 everywhere
 *
 * A cross-tenant request is answered exactly as a request for a record that does not exist. The
 * certification proved the reads were real by observing that a nonexistent uuid 404'd while a
 * foreign one returned 200 — the status code itself was the oracle. Answering 403 for the foreign
 * row would keep that oracle and merely rename it: a caller could still learn, for any id they
 * cared to try, whether it named a real assayer somewhere on the platform. Assayer ids leak
 * between organisations (assignment payloads, exports, support tickets, pasted URLs), and "this
 * exists but is not yours" is worth nothing to a legitimate caller. So: 404, same body shape, and
 * these tests assert it rather than merely accepting any 4xx.
 *
 * ## Running it
 *
 *   TI_API=http://127.0.0.1:3999/api/v1 \
 *   DB_HOST=postgres DB_PASSWORD=... \
 *   npx jest assayer-tenant-isolation --testPathIgnorePatterns=
 *
 * `.db.spec.ts` keeps it out of the CI unit run (`testPathIgnorePatterns` in the backend's jest
 * config), same as `assayer-postgres-concurrency.db.spec.ts` and
 * `assayer-lifecycle-certification.db.spec.ts` next door. It needs a live API and a live database
 * and a unit run has neither.
 *
 * ## What it will NOT do
 *
 * Touch a row it did not create. This database holds 1,155 real appraisers. Every fixture is
 * created by this file, carries the `TFIX-` prefix, and cleanup is scoped to that prefix and to
 * the throwaway organisation it creates. `audit_events` is append-only by database trigger, so the
 * audit assertions below COUNT rows rather than deleting them, and the counts are taken per
 * fixture id — which is why the fixture ids are derived from `md5('tfix:…')` and are therefore
 * stable across runs rather than random.
 */

// @ts-ignore — `pg` is a transitive dependency, as in the two db specs next door.
import { Pool } from 'pg';
import { EmpanelmentStatus } from '@fapoms/shared';

const API = process.env.TI_API || 'http://127.0.0.1:3999/api/v1';

/** Organisation A: the real one on this deployment, and the one `lc-ops` belongs to. */
const ORG_A = process.env.TI_ORG_A || '382c3718-89e5-41a2-ac29-ab5ec7900562';
const USER_A = process.env.TI_USER_A || 'lc-ops@lifecycle-cert.invalid';
/** Organisation B's own ADMIN. Deletion is ADMIN-only; see the provisioning comment. */
const ADMIN_B = 'tfix-admin-b@tenant-isolation.invalid';
/**
 * No default. A working password for an account that exists on a real deployment does not belong
 * in a repository — it is committed once and burned for ever, which is exactly why
 * `assertProductionSafeConfig` permanently refuses two values that reached this project's git
 * history. Supply it at run time:
 *
 *   TI_PASSWORD=... npx jest assayer-tenant-isolation --testPathIgnorePatterns=
 */
const PASSWORD = process.env.TI_PASSWORD;

/**
 * The platform ADMIN's password, separately overridable.
 *
 * `lc-admin@lifecycle-cert.invalid` is a long-lived account on a shared deployment, not a fixture
 * this file creates, so its credential can drift out from under the suite without anything here
 * changing — and it did: mid-session, `lc-admin` alone began answering 401 to the shared password
 * while `lc-ops` and `lc-auditor` still answered 200, its `password_hash` no longer sharing the
 * salt those two were seeded with. The two ADMIN cases then failed on `signIn`, several lines
 * before reaching the cross-tenant assertion they exist to make, and reported "Could not sign in"
 * — which reads like an outage in the auth route rather than what it was.
 *
 * Resetting the account from this file would be the wrong repair twice over: this suite's rule is
 * that it touches nothing it did not write, and a spec that rewrites a shared operator's password
 * to make itself pass is a spec that breaks whoever was using it. So the credential becomes an
 * input instead. `TI_PASSWORD` still covers the ordinary case where all three share one password.
 */
const ADMIN_PASSWORD = process.env.TI_ADMIN_PASSWORD || PASSWORD;

/** The platform ADMIN the two cross-organisation ADMIN cases sign in as. */
const ADMIN_USER = process.env.TI_ADMIN_USER || 'lc-admin@lifecycle-cert.invalid';

/**
 * Organisation B: created by this file, deleted by it.
 *
 * Its OPERATIONS user borrows organisation A's password hash rather than hashing a new one, so
 * both principals sign in with the same password and this file needs no bcrypt at fixture time.
 * It is a throwaway account in a throwaway organisation that exists for the length of one run.
 */
const USER_B = 'tfix-ops-b@tenant-isolation.invalid';


/**
 * BEFORE YOU RUN THIS: check that the pool and the API are looking at the same database.
 *
 * This suite talks to a live API over HTTP *and* opens its own PostgreSQL connection from the
 * host. Those are two independent addresses, and nothing makes them agree. `DB_PORT` defaults to
 * 5432, and `deploy/docker-compose.prod.yml` publishes only caddy — postgres has no host port — so
 * on a machine running any other stack the pool silently connects to THAT one instead.
 *
 * The failure is the expensive kind: fixtures land in one database, the API reads another, and
 * every assertion fails as a 404 that looks exactly like a tenancy or permission bug. It cost an
 * hour to diagnose the first time. Publish the rig's postgres on a port of its own and pass
 * `DB_PORT` explicitly; the resolved connection is printed at the start of the run so a wrong one
 * is visible in the first line of output rather than in the ninety-eighth failure.
 */
const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME || 'fapoms',
  password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
  max: 5,
};

/** Every fixture id in this file, derived so a re-run reuses the same rows instead of littering. */
const ID = (key: string) => `md5('tfix:${key}')::uuid`;

interface Actor {
  label: string;
  token: string;
}

interface Fixture {
  assayerId: string;
  clientId: string;
  documentId: string;
  commercialProfileId: string;
  bankAccount: string;
}

describe('assayer tenant isolation — F-03 acceptance matrix against the running system', () => {
  jest.setTimeout(300_000);

  let pool: Pool;
  let orgB: string;
  let A: Actor;
  let B: Actor;
  let fixtureA: Fixture;
  let fixtureB: Fixture;

  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  // ── HTTP helpers ─────────────────────────────────────────────────────────
  //
  // One retry on a 429: this suite fires a few dozen requests as fast as the event loop allows,
  // which is nothing like real use and is exactly what the per-IP throttle exists to stop. Copied
  // from `assayer-lifecycle-certification.db.spec.ts` for the same reason it exists there.

  const call = async (
    actor: Actor,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any; text: string }> => {
    const send = () => fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${actor.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let res = await send();
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1100));
      res = await send();
    }
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* a stream body (a document download) is not JSON */ }
    return { status: res.status, body: parsed, text };
  };

  const signIn = async (label: string, username: string): Promise<Actor> => {
    const password = username === ADMIN_USER ? ADMIN_PASSWORD : PASSWORD;
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json: any = await res.json().catch(() => null);
    const token = json?.data?.accessToken;
    if (!token) {
      // Naming the knob in the failure itself, because the two ADMIN cases are the only ones that
      // depend on an account this file does not own, and "wrong password for a shared operator" and
      // "the login route is broken" look identical at this line otherwise.
      const hint = username === ADMIN_USER
        ? ` — set TI_ADMIN_PASSWORD if this account's password has been changed`
        : '';
      throw new Error(`Could not sign in as ${username}: HTTP ${res.status} ${JSON.stringify(json)}${hint}`);
    }
    return { label, token };
  };

  // ── Database observation helpers ──────────────────────────────────────────

  /** The columns a cross-tenant mutation would have moved, so "nothing happened" is checkable. */
  const snapshot = async (assayerId: string) => (await q(
    `SELECT lifecycle_status, status, is_active, version, display_name, bank_account_number,
            password_hash, must_change_password, photograph
       FROM assayers WHERE id = $1`,
    [assayerId],
  ))[0];

  /**
   * Every audit row this system has ever written about one entity.
   *
   * The matrix requires "NO audit event claiming success", and the honest way to check that is a
   * count before and a count after — `audit_events` is append-only (a database trigger refuses
   * UPDATE and DELETE), so a row written on the way to a refusal could never be retracted and
   * would sit in the compliance record for ever saying an operator read another tenant's bank
   * details. Counted by entity id, not by time, because several tests run inside one second.
   */
  const auditCount = async (entityId: string): Promise<number> => Number((await q(
    'SELECT count(*)::int AS c FROM audit_events WHERE entity_id = $1', [entityId],
  ))[0].c);

  const empanelmentStatus = async (assayerId: string, clientId: string): Promise<string | null> => {
    const rows = await q(
      'SELECT status FROM assayer_client_empanelments WHERE assayer_id = $1 AND client_id = $2',
      [assayerId, clientId],
    );
    return rows[0]?.status ?? null;
  };

  // ── Fixtures ──────────────────────────────────────────────────────────────

  const CLEANUP = `
    DELETE FROM assayer_document_versions WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM assayer_documents        WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM assayer_client_empanelments WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM assayer_commercial_profiles WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM assayer_references       WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM assayer_background_checks WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM assayer_import_issues    WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM assayer_activities       WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM workforce_attributes     WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM assayer_score_overrides  WHERE assayer_id IN (SELECT id FROM assayers WHERE assayer_code LIKE 'TFIX-%');
    DELETE FROM assayers                 WHERE assayer_code LIKE 'TFIX-%';
    DELETE FROM clients                  WHERE client_code LIKE 'TFIX-%';
    DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tfix_%');
    DELETE FROM users                    WHERE username LIKE 'tfix_%';
    DELETE FROM organizations            WHERE code LIKE 'TFIX-%';
  `;

  /**
   * One assayer, one client, one identity document with a scan on it, one rate card — per tenant.
   *
   * Both tenants get the SAME shape, because half the matrix is "the same operations succeed
   * within a tenant". A test that only proves the refusals would pass just as well against a
   * filter that returns nothing to anybody, which is the other way to break this.
   *
   * The bank account number goes in as plaintext: `encryptedColumn.from` passes a value with no
   * `enc:v1:` prefix straight through (legacy rows predate the encryption), so the reveal endpoint
   * returns exactly this string and the assertion can name it.
   */
  const seedTenant = async (tag: string, org: string): Promise<Fixture> => {
    const bankAccount = `9${tag}0000000001`;
    const [client] = await q(
      `INSERT INTO clients (id, client_code, name, display_name, organization_id, is_active, version, created_at, updated_at)
       VALUES (${ID(`client-${tag}`)}, $1, $2, $2, $3, true, 1, now(), now())
       ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, updated_at = now()
       RETURNING id`,
      [`TFIX-CLI-${tag}`, `TFix Client ${tag}`, org],
    );
    const [assayer] = await q(
      `INSERT INTO assayers (id, assayer_code, first_name, last_name, display_name, address,
         state, district, city, lifecycle_status, status, is_active, organization_id, version,
         joining_date, bank_account_number, bank_name, ifsc_code, phone, email,
         created_at, updated_at)
       VALUES (${ID(`assayer-${tag}`)}, $1, 'TFix', $2, $3, 'Test Address',
         'MAHARASHTRA', 'Pune', 'Pune', 'ACTIVE', 'ACTIVE', true, $4, 1,
         '2026-01-01', $5, 'TFix Bank', 'TFIX0000001', $6, $7, now(), now())
       ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id,
         lifecycle_status = 'ACTIVE', status = 'ACTIVE', is_active = true,
         bank_account_number = EXCLUDED.bank_account_number,
         exit_date = NULL, termination_date = NULL, unavailable_reason = NULL, updated_at = now()
       RETURNING id`,
      [
        `TFIX-${tag}`, tag, `TFix Assayer ${tag}`, org, bankAccount,
        `+9199000000${tag === 'A' ? '01' : '02'}`, `tfix-${tag.toLowerCase()}@tenant-isolation.invalid`,
      ],
    );
    const [document] = await q(
      `INSERT INTO assayer_documents (id, assayer_id, requirement, is_active, version,
         soft_copy_received, file_paths, created_at, updated_at)
       VALUES (${ID(`document-${tag}`)}, $1, 'PAN_CARD', true, 1, true, to_jsonb(ARRAY[$2::text]), now(), now())
       ON CONFLICT (id) DO UPDATE SET file_paths = EXCLUDED.file_paths, updated_at = now()
       RETURNING id`,
      [assayer.id, `tfix/${tag}/pan.pdf`],
    );
    const [profile] = await q(
      `INSERT INTO assayer_commercial_profiles (id, assayer_id, base_fee, currency,
         effective_start_date, is_active, version, created_at, updated_at)
       VALUES (${ID(`commercial-${tag}`)}, $1, 1234.00, 'INR', '2026-01-01', true, 1, now(), now())
       ON CONFLICT (id) DO UPDATE SET base_fee = 1234.00, updated_at = now()
       RETURNING id`,
      [assayer.id],
    );
    return {
      assayerId: assayer.id,
      clientId: client.id,
      documentId: document.id,
      commercialProfileId: profile.id,
      bankAccount,
    };
  };

  beforeAll(async () => {
    // Printed before anything else, because the two addresses below are independent and
    // nothing makes them agree — see the note above `DB`. A wrong one is then the first
    // line of output rather than a wall of 404s that reads like a permission bug.
    // eslint-disable-next-line no-console
    console.log(
      `[preflight] API ${API}\n`
      + `[preflight] pool ${DB.user}@${DB.host}:${DB.port}/${DB.database}`,
    );
    pool = new Pool(DB);
    await pool.query(CLEANUP);

    // Organisation B, and an OPERATIONS user inside it. OPERATIONS on purpose: it is the role the
    // finding was reproduced with, and it is deliberately NOT one of the two cross-tenant roles
    // (ADMIN, DEVELOPER), so a principal holding it must see exactly one organisation.
    const [org] = await pool.query(
      `INSERT INTO organizations (id, code, name, display_name, is_active, version, created_at, updated_at)
       VALUES (${ID('org-b')}, 'TFIX-ORG-B', 'TFix Tenant B', 'TFix Tenant B', true, 1, now(), now())
       ON CONFLICT (id) DO UPDATE SET is_active = true, updated_at = now()
       RETURNING id`,
    ).then((r: any) => r.rows);
    orgB = org.id;

    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, first_name, last_name, display_name,
         status, organization_id, is_active, version, created_at, updated_at)
       SELECT ${ID('user-b')}, 'tfix_ops_b', $1, u.password_hash, 'TFix', 'OpsB', 'TFix Ops B',
              'ACTIVE', $2, true, 1, now(), now()
         FROM users u WHERE u.email = $3
       ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id,
         status = 'ACTIVE', is_active = true, updated_at = now()`,
      [USER_B, orgB, USER_A],
    );
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT ${ID('user-b')}, r.id FROM roles r WHERE r.name = 'OPERATIONS'
       ON CONFLICT DO NOTHING`,
    );

    /**
     * A second user inside organisation B, holding ADMIN.
     *
     * Only because deleting a record became ADMIN-only in the lifecycle remediation — it was the
     * third route that moved `lifecycle_status` without the transition map being consulted, and
     * OPERATIONS holds every lifecycle move it needs without also being able to destroy a record.
     * The same-tenant half of this matrix has to exercise the delete route as somebody who is
     * actually allowed to use it, or it would be certifying the role guard rather than tenancy.
     *
     * Note this principal IS cross-tenant by design (`CROSS_TENANT_ROLES` is ADMIN + DEVELOPER),
     * so it is used for exactly one thing: deleting organisation B's own fixture at the end.
     */
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, first_name, last_name, display_name,
         status, organization_id, is_active, version, created_at, updated_at)
       SELECT ${ID('admin-b')}, 'tfix_admin_b', $1, u.password_hash, 'TFix', 'AdminB', 'TFix Admin B',
              'ACTIVE', $2, true, 1, now(), now()
         FROM users u WHERE u.email = $3
       ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id,
         status = 'ACTIVE', is_active = true, updated_at = now()`,
      [ADMIN_B, orgB, USER_A],
    );
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT ${ID('admin-b')}, r.id FROM roles r WHERE r.name = 'ADMIN'
       ON CONFLICT DO NOTHING`,
    );

    fixtureA = await seedTenant('A', ORG_A);
    fixtureB = await seedTenant('B', orgB);

    A = await signIn('org-A OPERATIONS', USER_A);
    B = await signIn('org-B OPERATIONS', USER_B);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(CLEANUP);
      await pool.end();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Preconditions. If these are wrong every assertion below is meaningless — a
  // suite that silently tests one organisation against itself would pass.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('preconditions', () => {
    it('places the two fixtures in genuinely different organisations', async () => {
      const rows = await q(
        'SELECT id, organization_id FROM assayers WHERE id = ANY($1) ORDER BY assayer_code',
        [[fixtureA.assayerId, fixtureB.assayerId]],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].organization_id).toBe(ORG_A);
      expect(rows[1].organization_id).toBe(orgB);
      expect(rows[0].organization_id).not.toBe(rows[1].organization_id);
    });

    it('signs both actors in as OPERATIONS, each carrying their own organisation', async () => {
      const rows = await q(
        'SELECT organization_id FROM users WHERE email = ANY($1) ORDER BY email',
        [[USER_A, USER_B]],
      );
      expect(rows.map((r: any) => r.organization_id).sort()).toEqual([ORG_A, orgB].sort());
      expect(A.token).toBeTruthy();
      expect(B.token).toBeTruthy();
    });

    it('confirms the backfill: no assayer, client, project, branch or user is unowned', async () => {
      // The precondition the whole design rests on. A null organisation is invisible to a scoped
      // read, so a row left behind by the backfill would vanish from the roster rather than leak —
      // safe, but a silent data loss, and the failure mode the operators would actually notice.
      const [row] = await q(`
        SELECT (SELECT count(*) FROM assayers WHERE organization_id IS NULL)::int AS assayers,
               (SELECT count(*) FROM clients  WHERE organization_id IS NULL)::int AS clients,
               (SELECT count(*) FROM projects WHERE organization_id IS NULL)::int AS projects,
               (SELECT count(*) FROM branches WHERE organization_id IS NULL)::int AS branches,
               (SELECT count(*) FROM users    WHERE organization_id IS NULL)::int AS users`);
      expect(row).toEqual({ assayers: 0, clients: 0, projects: 0, branches: 0, users: 0 });
    });

    it('answers a uuid that exists nowhere with a 404, so 404 is a meaningful assertion below', async () => {
      // The control. Every cross-tenant case is asserted to look exactly like this one; if this
      // returned something else, "looks like a nonexistent record" would not mean anything.
      const res = await call(A, 'GET', '/assayers/00000000-0000-4000-8000-0000000000ff');
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // The matrix: organisation A acting on organisation B's assayer.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('organisation A against organisation B — every route the finding reached', () => {
    /** Nothing in a cross-tenant response may name, describe or number the foreign record. */
    const assertLeaksNothing = (text: string) => {
      expect(text).not.toContain('TFIX-B');
      expect(text).not.toContain('TFix Assayer B');
      expect(text).not.toContain(fixtureB.bankAccount);
      expect(text).not.toContain('tfix-b@tenant-isolation.invalid');
    };

    it('GET /assayers/:id — profile read is a 404 and discloses nothing', async () => {
      const res = await call(A, 'GET', `/assayers/${fixtureB.assayerId}`);
      expect(res.status).toBe(404);
      assertLeaksNothing(res.text);
    });

    it('GET /assayers/:assayerId/profile — the dossier-backed profile read is a 404', async () => {
      const res = await call(A, 'GET', `/assayers/${fixtureB.assayerId}/profile`);
      expect(res.status).toBe(404);
      assertLeaksNothing(res.text);
    });

    it('GET /assayers/profile by assayer CODE — the code lookup is scoped too', async () => {
      // `getProfile` accepts a code as well as a uuid, and codes are short and sequential
      // (`AS0688`), so an unscoped lookup by code was cross-tenant enumeration with nothing to
      // guess. Not `assertLeaksNothing` here: the 404 body quotes the code back
      // ("Assayer TFIX-B not found."), which is the caller's own input and identical to what a
      // code that exists nowhere returns — that echo is what makes the two indistinguishable.
      const res = await call(A, 'GET', '/assayers/TFIX-B/profile');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('TFix Assayer B');
      expect(res.text).not.toContain(fixtureB.bankAccount);
      const control = await call(A, 'GET', '/assayers/TFIX-NOBODY/profile');
      expect(control.status).toBe(404);
    });

    it('GET /assayers — the roster list contains no row from the other organisation', async () => {
      const res = await call(A, 'GET', '/assayers?limit=1000');
      expect(res.status).toBe(200);
      assertLeaksNothing(res.text);
      // And it is not empty: an over-tight filter that returns nothing would pass the line above.
      expect(res.text).toContain('TFIX-A');
    });

    it('GET /assayers/search — typeahead does not reach across the boundary', async () => {
      // Asserted on ids rather than codes: `searchAssayers` returns raw rows through
      // `scopeAssayerListForRoles`, which strips the code and display name off a raw-shaped row,
      // so the code never appears in this response for anybody. The id does, and it is the thing
      // that identifies the record.
      const res = await call(A, 'GET', '/assayers/search?q=TFix');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(fixtureB.assayerId);
      expect(res.text).toContain(fixtureA.assayerId);
    });

    it('GET /assayers/map-roster — the map plots only this organisation', async () => {
      const res = await call(A, 'GET', '/assayers/map-roster');
      expect(res.status).toBe(200);
      assertLeaksNothing(res.text);
    });

    it('GET /assayers/:assayerId/dossier — references, checks and paperwork are a 404', async () => {
      const res = await call(A, 'GET', `/assayers/${fixtureB.assayerId}/dossier`);
      expect(res.status).toBe(404);
      assertLeaksNothing(res.text);
    });

    it('GET /assayers/:id/sensitive/bank — the cleartext bank reveal is refused and NOT audited', async () => {
      // The sharpest edge of the finding: this returned another tenant's account number in
      // cleartext, decrypted by the column transformer, and wrote an
      // `ASSAYER_SENSITIVE_FIELD_REVEALED` row saying so. `audit_events` is append-only, so such a
      // row could never be retracted — the count must not move.
      const before = await auditCount(fixtureB.assayerId);
      const res = await call(A, 'GET', `/assayers/${fixtureB.assayerId}/sensitive/bank`);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain(fixtureB.bankAccount);
      expect(await auditCount(fixtureB.assayerId)).toBe(before);
    });

    it('POST /assayers/:id/lifecycle — the transition is refused and the row does not move', async () => {
      const before = await snapshot(fixtureB.assayerId);
      const auditBefore = await auditCount(fixtureB.assayerId);
      const res = await call(A, 'POST', `/assayers/${fixtureB.assayerId}/lifecycle`, {
        targetStatus: 'SUSPENDED',
        reason: 'Cross-tenant suspension attempt from the acceptance matrix.',
      });
      expect(res.status).toBe(404);
      const after = await snapshot(fixtureB.assayerId);
      expect(after.lifecycle_status).toBe('ACTIVE');
      expect(after).toEqual(before);
      expect(await auditCount(fixtureB.assayerId)).toBe(auditBefore);
    });

    it('POST /assayers/bulk/lifecycle — a batch naming the foreign id changes nothing', async () => {
      // The bulk route takes its ids from the BODY and calls no region guard at all, so before the
      // fix it was the widest door in the module: any assayer on the platform, by id, in one call.
      const before = await snapshot(fixtureB.assayerId);
      const auditBefore = await auditCount(fixtureB.assayerId);
      const res = await call(A, 'POST', '/assayers/bulk/lifecycle', {
        ids: [fixtureA.assayerId, fixtureB.assayerId],
        targetStatus: 'ON_LEAVE',
        reason: 'Cross-tenant bulk attempt from the acceptance matrix.',
      });
      // The batch itself succeeds — it is built so one bad id never abandons the others — but the
      // foreign id must land in `failed`, never in `succeeded`.
      const payload = res.body?.data ?? res.body;
      const succeededIds = (payload?.succeeded ?? []).map((s: any) => s.id);
      expect(succeededIds).not.toContain(fixtureB.assayerId);
      expect(await snapshot(fixtureB.assayerId)).toEqual(before);
      expect(await auditCount(fixtureB.assayerId)).toBe(auditBefore);

      // Put organisation A's own fixture back, since this batch legitimately moved it.
      if (succeededIds.includes(fixtureA.assayerId)) {
        await call(A, 'POST', `/assayers/${fixtureA.assayerId}/lifecycle`, {
          targetStatus: 'ACTIVE', reason: 'Restoring the fixture after the bulk case.',
        });
      }
    });

    it('GET /assayers/document/:id/file/:index — the identity scan is not served', async () => {
      // Keyed on the DOCUMENT row, so no assayer id ever reached the controller and no guard
      // upstream could have looked at one. What it streams is the PAN or Aadhaar scan itself.
      const res = await call(A, 'GET', `/assayers/document/${fixtureB.documentId}/file/0`);
      expect(res.status).toBe(404);
    });

    it('PUT /assayers/:assayerId/empanelment/:clientId — the standing is not written', async () => {
      /**
       * TERMINATED, and it has to be a real member for this case to mean anything.
       *
       * It sent BLACKLISTED, which `EmpanelmentStatus` has never had. The DTO refused the body
       * with a 400 before the request came anywhere near the organisation check, so the case
       * asserting that a foreign standing is not written was never reaching the code that decides
       * that. Probing the route directly afterwards showed the boundary does hold: an OPERATIONS
       * user gets 404 and nothing is written, while an ADMIN gets 200 and the standing is written,
       * which is the documented platform-operator behaviour the section below covers.
       *
       * A destructive standing on purpose. If the refusal ever stops working, the row this case
       * reads back should have changed in a way nobody could mistake for noise.
       */
      const before = await empanelmentStatus(fixtureB.assayerId, fixtureB.clientId);
      const auditBefore = await auditCount(fixtureB.assayerId);
      const res = await call(
        A, 'PUT', `/assayers/${fixtureB.assayerId}/empanelment/${fixtureB.clientId}`,
        { status: EmpanelmentStatus.TERMINATED, statusReason: 'Cross-tenant empanelment attempt.' },
      );
      expect(res.status).toBe(404);
      expect(await empanelmentStatus(fixtureB.assayerId, fixtureB.clientId)).toBe(before);
      expect(await auditCount(fixtureB.assayerId)).toBe(auditBefore);
    });

    it('GET /assayers/:assayerId/commercial — the rate card is a 404', async () => {
      const res = await call(A, 'GET', `/assayers/${fixtureB.assayerId}/commercial`);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('1234');
    });

    it('PUT /assayers/commercial/:id — the foreign rate card cannot be rewritten', async () => {
      const res = await call(A, 'PUT', `/assayers/commercial/${fixtureB.commercialProfileId}`, { baseFee: 1 });
      expect(res.status).toBe(404);
      const [row] = await q(
        'SELECT base_fee FROM assayer_commercial_profiles WHERE id = $1', [fixtureB.commercialProfileId],
      );
      expect(Number(row.base_fee)).toBe(1234);
    });

    it('GET /assayers/:id/payables — bank destinations on past payouts are a 404', async () => {
      const res = await call(A, 'GET', `/assayers/${fixtureB.assayerId}/payables`);
      expect(res.status).toBe(404);
    });

    it('GET /assayers/:assayerId/activity — the timeline is a 404', async () => {
      const res = await call(A, 'GET', `/assayers/${fixtureB.assayerId}/activity`);
      expect(res.status).toBe(404);
    });

    it('POST /assayers/:id/recovery/revoke-invitation — the recovery route is refused', async () => {
      const before = await snapshot(fixtureB.assayerId);
      const res = await call(A, 'POST', `/assayers/${fixtureB.assayerId}/recovery/revoke-invitation`, {
        reason: 'Cross-tenant recovery attempt from the acceptance matrix.',
      });
      expect(res.status).toBe(404);
      expect(await snapshot(fixtureB.assayerId)).toEqual(before);
    });

    it('POST /assayers/:assayerId/reset-password — no credential is issued for another tenant', async () => {
      // A recovery route that mints a credential: unscoped, this replaced another organisation's
      // field worker's password hash and spoke the new password back to the caller.
      const before = await snapshot(fixtureB.assayerId);
      const res = await call(A, 'POST', `/assayers/${fixtureB.assayerId}/reset-password`, {});
      expect(res.status).toBe(404);
      const after = await snapshot(fixtureB.assayerId);
      expect(after.password_hash).toBe(before.password_hash);
      expect(after.must_change_password).toBe(before.must_change_password);
    });

    it('POST /assayers/:assayerId/app-access — app access is not issued across the boundary', async () => {
      const before = await snapshot(fixtureB.assayerId);
      const res = await call(A, 'POST', `/assayers/${fixtureB.assayerId}/app-access`, {});
      expect(res.status).toBe(404);
      expect((await snapshot(fixtureB.assayerId)).password_hash).toBe(before.password_hash);
    });

    it('PUT /assayers/:id — the record cannot be edited from another organisation', async () => {
      const before = await snapshot(fixtureB.assayerId);
      const res = await call(A, 'PUT', `/assayers/${fixtureB.assayerId}`, { city: 'Rewritten' });
      expect(res.status).toBe(404);
      expect(await snapshot(fixtureB.assayerId)).toEqual(before);
    });

    /**
     * Deletion is ADMIN-only since the lifecycle remediation, so an OPERATIONS caller is refused
     * by the role guard (403) before the tenant filter is ever consulted — the guards run in that
     * order. Either answer is a correct refusal and the assertion accepts both, because the thing
     * being certified here is that NOTHING MOVED, not which of two controls stopped it first.
     * The tenant filter is proven on its own by the read and mutation cases above, which are not
     * role-restricted.
     */
    it('DELETE /assayers/:id — the record is not soft-deleted', async () => {
      const before = await snapshot(fixtureB.assayerId);
      const auditBefore = await auditCount(fixtureB.assayerId);
      const res = await call(A, 'DELETE', `/assayers/${fixtureB.assayerId}`, {
        reason: 'Cross-tenant deletion probe — must not be honoured.',
      });
      expect([403, 404]).toContain(res.status);
      const after = await snapshot(fixtureB.assayerId);
      expect(after.is_active).toBe(true);
      expect(after.lifecycle_status).toBe('ACTIVE');
      expect(after).toEqual(before);
      expect(await auditCount(fixtureB.assayerId)).toBe(auditBefore);
    });

    /**
     * And the same probe as a platform ADMIN, who IS allowed to delete and IS cross-tenant by
     * design (`CROSS_TENANT_ROLES`). This is not a hole — it is the escape hatch that role exists
     * for — but it is worth stating out loud, because it is the one caller for whom the tenant
     * boundary does not apply and somebody reading this file should not have to infer that.
     */
    it('DELETE /assayers/:id — a platform ADMIN is deliberately not fenced in', async () => {
      const admin = await signIn('platform ADMIN', ADMIN_USER);
      const res = await call(admin, 'GET', `/assayers/${fixtureB.assayerId}`);
      expect(res.status).toBe(200);
    });

    it('GET /hr/workforce — the aggregate counts nobody from the other organisation', async () => {
      const res = await call(A, 'GET', '/hr/workforce');
      expect(res.status).toBe(200);
      assertLeaksNothing(res.text);
    });

    it('GET /assayers/commercial/roster — the whole-roster rate card stops at the boundary', async () => {
      const res = await call(A, 'GET', '/assayers/commercial/roster');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(fixtureB.assayerId);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // The other half, and the one that matters most in practice: a filter that
  // returns nothing to anybody is as broken as no filter at all.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('within a tenant — every one of those operations still works', () => {
    it('reads its own profile, dossier, activity, commercial terms and payables', async () => {
      const profile = await call(B, 'GET', `/assayers/${fixtureB.assayerId}`);
      expect(profile.status).toBe(200);
      expect(profile.text).toContain('TFIX-B');

      expect((await call(B, 'GET', `/assayers/${fixtureB.assayerId}/profile`)).status).toBe(200);
      expect((await call(B, 'GET', '/assayers/TFIX-B/profile')).status).toBe(200);
      expect((await call(B, 'GET', `/assayers/${fixtureB.assayerId}/dossier`)).status).toBe(200);
      expect((await call(B, 'GET', `/assayers/${fixtureB.assayerId}/activity`)).status).toBe(200);
      expect((await call(B, 'GET', `/assayers/${fixtureB.assayerId}/commercial`)).status).toBe(200);
      expect((await call(B, 'GET', `/assayers/${fixtureB.assayerId}/payables`)).status).toBe(200);
    });

    it('lists and searches its own roster, and the HR aggregate answers', async () => {
      const list = await call(B, 'GET', '/assayers?limit=1000');
      expect(list.status).toBe(200);
      expect(list.text).toContain('TFIX-B');
      expect(list.text).not.toContain('TFIX-A');

      const search = await call(B, 'GET', '/assayers/search?q=TFix');
      expect(search.status).toBe(200);
      expect(search.text).toContain(fixtureB.assayerId);
      expect(search.text).not.toContain(fixtureA.assayerId);

      expect((await call(B, 'GET', '/hr/workforce')).status).toBe(200);
    });

    it('reveals its own bank account in cleartext, and audits that it did', async () => {
      const before = await auditCount(fixtureB.assayerId);
      const res = await call(B, 'GET', `/assayers/${fixtureB.assayerId}/sensitive/bank`);
      expect(res.status).toBe(200);
      expect(res.text).toContain(fixtureB.bankAccount);
      // The audit row is REQUIRED here, and its absence would be a regression of its own: the
      // refusal tests above assert the count does not move, so this asserts the count does.
      expect(await auditCount(fixtureB.assayerId)).toBeGreaterThan(before);
    });

    it('sets an empanelment on its own assayer', async () => {
      /**
       * ACTIVE, not EMPANELLED. `EmpanelmentStatus` has no EMPANELLED member — ACTIVE is
       * "empanelled and taking work" — and `EmpanelmentStatusIntegrity` (1796700000000) mapped
       * the one legacy row that said otherwise and added a CHECK that refuses it. This case sent
       * EMPANELLED and read its 400 as a tenancy result; it was the vocabulary.
       */
      const res = await call(
        B, 'PUT', `/assayers/${fixtureB.assayerId}/empanelment/${fixtureB.clientId}`,
        { status: EmpanelmentStatus.ACTIVE, statusReason: 'Same-tenant empanelment.' },
      );
      expect(res.status).toBe(200);
      expect(await empanelmentStatus(fixtureB.assayerId, fixtureB.clientId)).toBe(EmpanelmentStatus.ACTIVE);
    });

    it('edits its own rate card', async () => {
      const res = await call(B, 'PUT', `/assayers/commercial/${fixtureB.commercialProfileId}`, { baseFee: 4321 });
      expect(res.status).toBe(200);
      const [row] = await q(
        'SELECT base_fee FROM assayer_commercial_profiles WHERE id = $1', [fixtureB.commercialProfileId],
      );
      expect(Number(row.base_fee)).toBe(4321);
    });

    it('edits its own record', async () => {
      const res = await call(B, 'PUT', `/assayers/${fixtureB.assayerId}`, { city: 'Nashik' });
      expect(res.status).toBe(200);
      const [row] = await q('SELECT city FROM assayers WHERE id = $1', [fixtureB.assayerId]);
      expect(row.city).toBe('Nashik');
    });

    it('moves its own assayer through a lifecycle transition, and it lands', async () => {
      const res = await call(B, 'POST', `/assayers/${fixtureB.assayerId}/lifecycle`, {
        targetStatus: 'ON_LEAVE',
        reason: 'Same-tenant transition proving the filter is not simply refusing everything.',
      });
      expect([200, 201]).toContain(res.status);
      expect((await snapshot(fixtureB.assayerId)).lifecycle_status).toBe('ON_LEAVE');

      const back = await call(B, 'POST', `/assayers/${fixtureB.assayerId}/lifecycle`, {
        targetStatus: 'ACTIVE', reason: 'Restoring the fixture.',
      });
      expect([200, 201]).toContain(back.status);
    });

    it('creates an assayer stamped with the creator organisation', async () => {
      const res = await call(B, 'POST', '/assayers', {
        assayerCode: 'TFIX-NEW-B',
        firstName: 'TFix', lastName: 'Created',
        phone: '+919900000099', address: 'Test Address', state: 'MAHARASHTRA',
        district: 'Pune', city: 'Pune',
      });
      expect([200, 201]).toContain(res.status);
      const [row] = await q('SELECT organization_id FROM assayers WHERE assayer_code = $1', ['TFIX-NEW-B']);
      expect(row?.organization_id).toBe(orgB);
      expect(row?.organization_id).not.toBe(ORG_A);
    });

    it('refuses a create that tries to name its own organisation', async () => {
      /**
       * Two independent defences, and this asserts the outer one.
       *
       * `CreateAssayerRequestDto` does not declare `organizationId`, and the global pipe runs with
       * `forbidNonWhitelisted: true`, so a body carrying it is refused at the edge — the tenant
       * cannot be chosen over HTTP at all. `AssayerService.create` nevertheless takes the
       * organisation from the authenticated principal ahead of anything on the DTO, because that
       * method is also reached from inside the process where no validation pipe runs.
       */
      const res = await call(B, 'POST', '/assayers', {
        assayerCode: 'TFIX-NEW-REJECT',
        firstName: 'TFix', lastName: 'Rejected',
        phone: '+919900000098', address: 'Test Address', state: 'MAHARASHTRA',
        district: 'Pune', city: 'Pune',
        organizationId: ORG_A,
      });
      expect(res.status).toBe(400);
      const rows = await q('SELECT id FROM assayers WHERE assayer_code = $1', ['TFIX-NEW-REJECT']);
      expect(rows).toHaveLength(0);
    });

    it('finally soft-deletes its own assayer — the operation the finding performed across tenants', async () => {
      // Last, because it archives the fixture. Everything above needs the record live.
      //
      // As an ADMIN and carrying a reason: deletion became an ADMIN-only, reasoned operation in
      // the lifecycle remediation. It was the third route that moved `lifecycle_status` without
      // the transition map being consulted — archiving an ACTIVE assayer in one call with nothing
      // on the record to say why, or to tell it apart from an ordinary archival.
      const adminB = await signIn('org-B ADMIN', ADMIN_B);
      const res = await call(adminB, 'DELETE', `/assayers/${fixtureB.assayerId}`, {
        reason: 'Tenant-isolation fixture teardown through the real route.',
      });
      expect([200, 204]).toContain(res.status);
      const after = await snapshot(fixtureB.assayerId);
      expect(after.is_active).toBe(false);
      expect(after.lifecycle_status).toBe('ARCHIVED');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // The platform operator. Cross-tenant reading is a real, named entitlement —
  // if it stopped working, the escape hatch would have been closed by accident.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('the platform operator', () => {
    it('ADMIN still reads across organisations', async () => {
      // `CROSS_TENANT_ROLES` is ADMIN + DEVELOPER and nothing else. This is the assertion that the
      // list is honoured; the assertion that OPERATIONS is NOT on it is the whole section above.
      const admin = await signIn('platform ADMIN', ADMIN_USER);
      const res = await call(admin, 'GET', `/assayers/${fixtureA.assayerId}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('TFIX-A');
    });
  });
});
