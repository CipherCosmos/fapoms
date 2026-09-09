/**
 * LIFECYCLE CERTIFICATION — LAYER 2 (real API, real PostgreSQL).
 *
 * `assayer-lifecycle-matrix.spec.ts` in `@fapoms/shared` proves the GRAPH: all 121 ordered pairs,
 * in memory, against a hand-written second statement of the same edges. That is a statement about
 * a lookup table. It says nothing about whether the running system enforces it, whether a refused
 * transition leaves the row alone, or whether a successful one writes the audit trail somebody
 * will read back in a dispute.
 *
 * This file answers those, and it answers them the only way that counts: by calling the real HTTP
 * endpoint against the real deployment and then looking at the database directly. An HTTP 201 is
 * not evidence that anything persisted, and a 400 is not evidence that nothing did.
 *
 * ## Why this is a `.db.spec.ts`
 *
 * The suffix keeps it out of the CI unit run (`testPathIgnorePatterns` in the backend's jest
 * config) — same as `assayer-postgres-concurrency.db.spec.ts` next door. It needs a live API and
 * a live database, and a unit run has neither.
 *
 * ## Running it
 *
 *   LC_API=http://localhost:8080/api/v1 \
 *   DB_HOST=... DB_PASSWORD=... \
 *   npx jest assayer-lifecycle-certification --testPathIgnorePatterns=
 *
 * It needs an operator credential — any ADMIN or OPERATIONS user. `LC_USER` has a default;
 * `LC_PASSWORD` deliberately does not, and `beforeAll` fails loudly without it. A password that
 * opens a real account is exactly the kind of value that must not live in a repository.
 *
 * `LC_ORG` is the organisation the fixtures are created under, and since the tenant backfill and
 * scoping went in it MATTERS: a fixture created under a different organisation from the operator
 * signing in will be invisible to every request this file makes, and the whole suite will fail
 * with "not found" rather than anything informative. Set it to the operator's own organisation.
 *
 * ## What it will NOT do
 *
 * Touch a row it did not create. Every fixture carries the `LCERT-FIX-` prefix and cleanup is
 * scoped to it — the roster this runs against holds real people.
 */

// @ts-ignore — `pg` is a transitive dependency, as in the concurrency spec next door.
import { Pool } from 'pg';
import { AssayerLifecycleStatus } from '@fapoms/shared';
import {
  LIFECYCLE_FIXTURES,
  LIFECYCLE_FIXTURE_CLEANUP_SQL,
  fixtureCode,
  projectionFor,
  isActiveFor,
} from './lifecycle-certification-fixtures';

const API = process.env.LC_API || 'http://localhost:8080/api/v1';
const USER = process.env.LC_USER || 'lc-ops@lifecycle-cert.invalid';
/**
 * No default. A working password for an account that exists on a real deployment does not belong
 * in a repository — it is committed once and burned for ever, which is exactly why
 * `assertProductionSafeConfig` permanently refuses two values that reached this project's git
 * history. Supply it at run time:
 *
 *   LC_PASSWORD=... npx jest assayer-lifecycle-certification --testPathIgnorePatterns=
 */
const PASSWORD = process.env.LC_PASSWORD;
const ORG = process.env.LC_ORG || '382c3718-89e5-41a2-ac29-ab5ec7900562';

const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME || 'fapoms',
  password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
  max: 5,
};

const ALL_STATES = Object.values(AssayerLifecycleStatus);

/** The 23 legal edges, restated so this file does not depend on the map it is certifying. */
const LEGAL = new Set([
  'INVITED->DOCUMENT_VERIFICATION',
  // The revocation edges. They were performed by `operatorRevokeInvitation` long before they
  // were legal, which is why the transition endpoint used to refuse a move the recovery endpoint
  // carried out.
  'INVITED->ARCHIVED', 'DOCUMENT_VERIFICATION->ARCHIVED',
  'DOCUMENT_VERIFICATION->BACKGROUND_VERIFICATION', 'DOCUMENT_VERIFICATION->INACTIVE',
  'BACKGROUND_VERIFICATION->TRAINING', 'BACKGROUND_VERIFICATION->INACTIVE',
  'TRAINING->ACTIVE', 'TRAINING->INACTIVE',
  'ACTIVE->ON_LEAVE', 'ACTIVE->SUSPENDED', 'ACTIVE->INACTIVE', 'ACTIVE->RESIGNED',
  'ON_LEAVE->ACTIVE', 'ON_LEAVE->INACTIVE',
  'SUSPENDED->ACTIVE', 'SUSPENDED->TERMINATED',
  'INACTIVE->ACTIVE', 'INACTIVE->ARCHIVED',
  'RESIGNED->INVITED', 'RESIGNED->ARCHIVED',
  'TERMINATED->INVITED', 'TERMINATED->ARCHIVED',
]);

/** Targets the service refuses without a reason — `LIFECYCLE_MOVES_NEEDING_A_REASON`. */
const NEEDS_REASON = new Set([
  'SUSPENDED', 'INACTIVE', 'RESIGNED', 'TERMINATED', 'INVITED',
  // ARCHIVED joined the list when the two revocation edges above made archival reachable from
  // onboarding: withdrawing somebody's invitation is a fresh decision about a person nobody has
  // recorded anything about, and it arrives at the same state as filing away a leaver.
  'ARCHIVED',
]);

describe('assayer lifecycle — certification against the running system', () => {
  jest.setTimeout(600_000);
  let pool: Pool;
  let token: string;
  /** One throwaway client + project, because an assignment cannot exist without them. */
  let projectId: string;

  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  /** Puts a throwaway fixture into a given state directly, respecting the CHECK constraints. */
  const seed = async (code: string, lifecycle: AssayerLifecycleStatus): Promise<string> => {
    const rows = await q(
      `INSERT INTO assayers (id, assayer_code, first_name, last_name, display_name, address,
         state, district, city, lifecycle_status, status, is_active, organization_id, version,
         joining_date, created_at, updated_at)
       VALUES (md5('lcert:'||$1)::uuid, $1, 'LCert', $1, 'LCert '||$1, 'Test Address',
         'MAHARASHTRA','Pune','Pune',$2,$3,$4,$5,1,'2026-01-01',now(),now())
       ON CONFLICT (id) DO UPDATE SET lifecycle_status=$2, status=$3, is_active=$4,
         exit_date=NULL, termination_date=NULL, unavailable_reason=NULL, updated_at=now()
       RETURNING id`,
      [code, lifecycle, projectionFor(lifecycle), isActiveFor(lifecycle), ORG],
    );
    return rows[0].id;
  };

  const snapshot = async (id: string) => (await q(
    `SELECT lifecycle_status, status, is_active, exit_date, termination_date, version
       FROM assayers WHERE id = $1`, [id]))[0];

  const auditCount = async (id: string): Promise<number> => Number((await q(
    `SELECT count(*)::int AS c FROM audit_events
      WHERE entity_id = $1 AND event_type = 'ASSAYER_LIFECYCLE_TRANSITION'`, [id]))[0].c);

  /**
   * POST, with one retry on a 429.
   *
   * This suite fires several hundred requests as fast as the event loop will allow, which is
   * nothing like how the endpoint is used in anger and is exactly what the per-IP throttle exists
   * to stop. A 429 here is the throttle working, not the lifecycle failing — but left unhandled
   * it makes the suite flaky in a way that reads like a real defect, which is worse than slow.
   *
   * One retry, after a pause longer than the throttle's window resolution. Deliberately not a
   * loop: if a second attempt is still throttled, something is wrong that the test should report
   * rather than paper over.
   */
  const post = async (path: string, body: unknown) => {
    const send = () => fetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let res = await send();
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1100));
      res = await send();
    }
    return res;
  };

  const transition = async (id: string, target: string, reason?: string) => {
    const res = await post(
      `/assayers/${id}/lifecycle`,
      reason === undefined ? { targetStatus: target } : { targetStatus: target, reason },
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  beforeAll(async () => {
    pool = new Pool(DB);
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASSWORD }),
    });
    const json: any = await res.json();
    token = json?.data?.accessToken;
    if (!token) throw new Error(`Could not sign in as ${USER}: HTTP ${res.status}`);
    await pool.query(LIFECYCLE_FIXTURE_CLEANUP_SQL);

    // An assignment needs a project, and a project needs a client. Both are throwaway and both
    // carry the fixture prefix so the cleanup below can find them.
    const [client] = (await pool.query(
      `INSERT INTO clients (id, client_code, name, display_name, is_active, version, created_at, updated_at)
       VALUES (md5('lcert:LCERT-FIX-CLIENT')::uuid, 'LCERT-FIX-CLIENT', 'LCert Fixture Client',
               'LCert Fixture Client', true, 1, now(), now())
       ON CONFLICT (id) DO UPDATE SET updated_at = now() RETURNING id`)).rows;
    const [project] = (await pool.query(
      `INSERT INTO projects (id, project_number, name, client_id, is_active, version, created_at, updated_at)
       VALUES (md5('lcert:LCERT-FIX-PROJECT')::uuid, 'LCERT-FIX-PROJECT', 'LCert Fixture Project',
               $1, true, 1, now(), now())
       ON CONFLICT (id) DO UPDATE SET updated_at = now() RETURNING id`, [client.id])).rows;
    projectId = project.id;
  });

  afterAll(async () => {
    await pool.query(LIFECYCLE_FIXTURE_CLEANUP_SQL);
    await pool.end();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The seeded population, and the invariants that must hold for every one.
  // ───────────────────────────────────────────────────────────────────────────
  describe('the seeded fixtures', () => {
    it('creates all ten scenarios and each satisfies the database invariants', async () => {
      for (const f of LIFECYCLE_FIXTURES) {
        const id = await seed(fixtureCode(f), f.lifecycle);
        const row = await snapshot(id);
        expect(row.lifecycle_status).toBe(f.lifecycle);
        // The projection is derived, never decided — `chk_assayers_lifecycle_status_projection`.
        expect(row.status).toBe(projectionFor(f.lifecycle));
        // `chk_assayers_is_active_consistency` — only ARCHIVED is inactive.
        expect(row.is_active).toBe(isActiveFor(f.lifecycle));
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The rejection matrix, through the real endpoint.
  // ───────────────────────────────────────────────────────────────────────────
  describe('illegal transitions are refused, and leave nothing behind', () => {
    /**
     * A reason is supplied on every attempt, so that a rejection is PROVEN to come from the state
     * machine rather than from the missing-reason guard. Without it, the ~40 pairs whose target is
     * SUSPENDED/INACTIVE/RESIGNED/TERMINATED/INVITED would be refused for the wrong reason and the
     * matrix would be certifying the wrong control.
     */
    const illegal: [AssayerLifecycleStatus, AssayerLifecycleStatus][] = [];
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) if (!LEGAL.has(`${from}->${to}`)) illegal.push([from, to]);
    }

    it('covers exactly the ninety-eight illegal pairs', () => {
      // 121 ordered pairs less the 23 legal edges. Was 100 before the two revocation edges were
      // stated in the map rather than performed behind it.
      expect(illegal).toHaveLength(98);
    });

    it.each(illegal)('%s -> %s is refused with no mutation and no audit event', async (from, to) => {
      const id = await seed(`LCERT-FIX-M-${from}`, from);
      const before = await snapshot(id);
      const auditBefore = await auditCount(id);

      const res = await transition(id, to, 'Certification probe — this move must be refused.');

      /**
       * ARCHIVED is refused one layer EARLIER than the rest, and the difference is worth keeping
       * visible. `AssayerService.findOne` selects `where: { id, isActive: true }`, and ARCHIVED is
       * the one state with `is_active = false` — so the row is never loaded and the caller gets a
       * 404 before the transition map is ever consulted. Everything else reaches the map and gets
       * a 400. Both are correct refusals; asserting "not 2xx" alone would hide the fact that the
       * terminal state's real guard is the flag, not the graph.
       */
      if (from === AssayerLifecycleStatus.ARCHIVED) expect(res.status).toBe(404);
      else expect(res.status).toBe(400);

      const after = await snapshot(id);
      expect(after.lifecycle_status).toBe(before.lifecycle_status);
      expect(after.status).toBe(before.status);
      expect(after.is_active).toBe(before.is_active);
      expect(after.version).toBe(before.version);
      expect(await auditCount(id)).toBe(auditBefore);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Reason enforcement.
  // ───────────────────────────────────────────────────────────────────────────
  describe('the reason requirement', () => {
    const legalIntoReasonState: [AssayerLifecycleStatus, AssayerLifecycleStatus][] = [
      [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.SUSPENDED],
      [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.INACTIVE],
      [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.RESIGNED],
      [AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.TERMINATED],
      [AssayerLifecycleStatus.RESIGNED, AssayerLifecycleStatus.INVITED],
    ];

    /** Absent, null, empty and whitespace are the four shapes an empty box actually arrives as. */
    const emptyReasons: [string, string | undefined | null][] = [
      ['absent', undefined],
      ['null', null],
      ['empty string', ''],
      ['spaces', '   '],
      ['tabs and newlines', '\t\n  '],
    ];

    describe.each(legalIntoReasonState)('%s -> %s', (from, to) => {
      it.each(emptyReasons)('is refused when the reason is %s', async (_label, reason) => {
        expect(NEEDS_REASON.has(to)).toBe(true);
        const id = await seed(`LCERT-FIX-R-${from}-${to}`, from);
        const before = await snapshot(id);
        const auditBefore = await auditCount(id);

        const res = await post(
          `/assayers/${id}/lifecycle`,
          reason === undefined ? { targetStatus: to } : { targetStatus: to, reason },
        );

        expect(res.status).toBe(400);
        const after = await snapshot(id);
        expect(after.lifecycle_status).toBe(before.lifecycle_status);
        // No partial side effects: the departure cascade must not have run either.
        expect(after.exit_date).toEqual(before.exit_date);
        expect(await auditCount(id)).toBe(auditBefore);
      });

      it('succeeds with a real reason, and the reason reaches the audit trail', async () => {
        const id = await seed(`LCERT-FIX-R-OK-${from}-${to}`, from);
        const reason = `Certification: moving to ${to} for an auditable reason.`;
        const res = await transition(id, to, reason);
        expect(res.status).toBe(201);

        const after = await snapshot(id);
        expect(after.lifecycle_status).toBe(to);
        expect(after.status).toBe(projectionFor(to));

        const [audit] = await q(
          `SELECT previous_state, new_state, user_id, remarks, occurred_at FROM audit_events
            WHERE entity_id = $1 AND event_type = 'ASSAYER_LIFECYCLE_TRANSITION'
            ORDER BY occurred_at DESC LIMIT 1`, [id]);
        expect(audit.previous_state).toBe(from);
        expect(audit.new_state).toBe(to);
        expect(audit.user_id).toBeTruthy();
        expect(audit.occurred_at).toBeTruthy();
        expect(String(audit.remarks)).toContain(reason);
      });
    });

    /**
     * Hostile input is STORED, not executed, and not sanitised into something else.
     *
     * The query is parameterised, so the SQL arm is really a check that it stays that way. The
     * markup arm matters more than it looks: this string is read back onto an HR screen months
     * later, so what is asserted is that the value round-trips byte for byte — a reason that was
     * quietly stripped on the way in is a record of a decision that no longer says what somebody
     * wrote.
     */
    it('stores a hostile reason verbatim and changes nothing else', async () => {
      const id = await seed('LCERT-FIX-R-HOSTILE', AssayerLifecycleStatus.ACTIVE);
      const before = Number((await q(`SELECT count(*)::int c FROM assayers`))[0].c);
      const nasty = `'; DROP TABLE assayers; -- <script>alert(1)</script> — ünïcode 🧪`;

      const res = await transition(id, AssayerLifecycleStatus.SUSPENDED, nasty);
      expect(res.status).toBe(201);

      const [audit] = await q(
        `SELECT remarks FROM audit_events WHERE entity_id = $1
           AND event_type = 'ASSAYER_LIFECYCLE_TRANSITION' ORDER BY occurred_at DESC LIMIT 1`, [id]);
      expect(String(audit.remarks)).toContain(nasty);
      // The table is still there, and nobody else's row went with it.
      expect(Number((await q(`SELECT count(*)::int c FROM assayers`))[0].c)).toBe(before);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE distinction. If one thing in this file is worth keeping, it is this.
  // ───────────────────────────────────────────────────────────────────────────
  describe('what a status does to the work already assigned', () => {
    /** A throwaway assignment attached to a fixture, in a given status. */
    const giveAssignment = async (assayerId: string, status: string): Promise<string> => {
      const rows = await q(
        `INSERT INTO assignments (id, assignment_number, project_id, assayer_id, status,
           is_active, version, entity_version, created_at, updated_at)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, true, 1, 1, now(), now()) RETURNING id`,
        [
          `LCERT-FIX-A-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          projectId, assayerId, status,
        ]);
      return rows[0].id;
    };
    const assignmentStatus = async (id: string) =>
      (await q(`SELECT status FROM assignments WHERE id = $1`, [id]))[0]?.status;

    /**
     * SUSPENDED is "not right now". An assignment held by a suspended person is not orphaned —
     * it is waiting for the investigation to finish — and cancelling it automatically would be a
     * defect in the other direction from the one the departure cascade fixes.
     */
    it('leaves open assignments exactly where they were when somebody is SUSPENDED', async () => {
      const id = await seed('LCERT-FIX-SX-SUSPEND', AssayerLifecycleStatus.ACTIVE);
      const pending = await giveAssignment(id, 'PENDING');
      const accepted = await giveAssignment(id, 'ACCEPTED');

      const res = await transition(id, AssayerLifecycleStatus.SUSPENDED, 'Certification: suspension must not cancel work.');
      expect(res.status).toBe(201);

      expect(await assignmentStatus(pending)).toBe('PENDING');
      expect(await assignmentStatus(accepted)).toBe('ACCEPTED');
      expect((await snapshot(id)).status).toBe('SUSPENDED');
    });

    /**
     * RESIGNED is "not any more", and the whole point of the cascade: HR records somebody as gone
     * while the roster, the branch and the client all still expect them to turn up.
     */
    it('cancels open assignments — but never a COMPLETED one — when somebody RESIGNS', async () => {
      const id = await seed('LCERT-FIX-SX-RESIGN', AssayerLifecycleStatus.ACTIVE);
      const pending = await giveAssignment(id, 'PENDING');
      const accepted = await giveAssignment(id, 'ACCEPTED');
      // Billable history. It has already happened; a departure does not un-happen it.
      const completed = await giveAssignment(id, 'COMPLETED');

      const res = await transition(id, AssayerLifecycleStatus.RESIGNED, 'Certification: resignation must cancel open work.');
      expect(res.status).toBe(201);

      expect(await assignmentStatus(pending)).toBe('CANCELLED');
      expect(await assignmentStatus(accepted)).toBe('CANCELLED');
      expect(await assignmentStatus(completed)).toBe('COMPLETED');

      // The departure date is stamped by `reconcileDepartureDates`, the single writer.
      expect((await snapshot(id)).exit_date).toBeTruthy();

      // And the count of what it did goes on the record, not just into the log.
      const [audit] = await q(
        `SELECT remarks FROM audit_events WHERE entity_id = $1
           AND event_type = 'ASSAYER_LIFECYCLE_TRANSITION' ORDER BY occurred_at DESC LIMIT 1`, [id]);
      expect(String(audit.remarks)).toMatch(/assignment/i);
    });

    /** Dismissal carries both date columns; every reader of a departure reads `exit_date`. */
    it('stamps both departure columns on a TERMINATION', async () => {
      const id = await seed('LCERT-FIX-SX-TERM', AssayerLifecycleStatus.SUSPENDED);
      const res = await transition(id, AssayerLifecycleStatus.TERMINATED, 'Certification: dismissal after suspension.');
      expect(res.status).toBe(201);
      const row = await snapshot(id);
      expect(row.exit_date).toBeTruthy();
      expect(row.termination_date).toBeTruthy();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Re-entry.
  // ───────────────────────────────────────────────────────────────────────────
  describe('coming back', () => {
    /**
     * A rehire restarts onboarding. The point is not the edge — it is that the person lands at
     * the TOP of the joining chain and has to walk it, because the documents that established who
     * they were may have expired and the reason they left is worth re-examining.
     */
    it.each([AssayerLifecycleStatus.RESIGNED, AssayerLifecycleStatus.TERMINATED])(
      'sends a %s rehire back to INVITED, not to work', async (from) => {
        const id = await seed(`LCERT-FIX-RH-${from}`, from);
        const res = await transition(id, AssayerLifecycleStatus.INVITED, 'Certification: rehire.');
        expect(res.status).toBe(201);

        const row = await snapshot(id);
        expect(row.lifecycle_status).toBe(AssayerLifecycleStatus.INVITED);
        expect(row.status).toBe('INACTIVE');
        // Stale departure dates are cleared unconditionally on the rehire edge, or every exit
        // count keeps counting a person who is back and onboarding.
        expect(row.exit_date).toBeNull();
        expect(row.termination_date).toBeNull();

        // And from INVITED the only way on is the first joining stage — no shortcut to ACTIVE.
        expect((await transition(id, AssayerLifecycleStatus.ACTIVE, 'shortcut attempt')).status).toBe(400);
        expect((await snapshot(id)).lifecycle_status).toBe(AssayerLifecycleStatus.INVITED);
      });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Concurrency. The defect this suite exists to keep closed.
  // ───────────────────────────────────────────────────────────────────────────
  describe('two operators acting on the same person at the same time', () => {
    /**
     * WHAT WENT WRONG, AND WHY THIS IS AN INTEGRATION TEST RATHER THAN A UNIT ONE.
     *
     * `doTransitionLifecycle` used to read the assayer with a plain `findOne` outside any
     * transaction, validate the edge against that copy, and only then open the transaction that
     * saved it — with no version predicate on the write and no lock on the row. Measured on the
     * live deployment: eight simultaneous pairs, eight times BOTH requests returned 201. The row
     * ended wherever the later write landed and the audit trail was left holding two rows that
     * each claim `previous_state = ACTIVE`, one of them describing a transition that never took
     * effect, attributed to a named operator at a timestamp.
     *
     * No amount of mocking finds that. The winner is decided by two real connections contending
     * for a real row lock, so the test has to be two real requests against a real database — which
     * is also why the pre-existing race suite in this repo did not catch it: its lifecycle races
     * open raw connections and re-implement the guard in the test's own SQL, proving that
     * PostgreSQL implements `FOR UPDATE` rather than that the service asks for it.
     */
    const race = async (id: string, a: () => Promise<{ status: number }>, b: () => Promise<{ status: number }>) => {
      const [ra, rb] = await Promise.all([a(), b()]);
      return { codes: [ra.status, rb.status].sort(), after: await snapshot(id) };
    };

    /** How many audit rows this fixture has gained since a known baseline. */
    const auditDelta = async (id: string, before: number) => (await auditCount(id)) - before;

    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
      'pair %i — different targets: exactly one wins, the other is told the record moved',
      async (n) => {
        const id = await seed(`LCERT-FIX-RACE-D${n}`, AssayerLifecycleStatus.ACTIVE);
        const before = await auditCount(id);

        const { codes, after } = await race(id,
          () => transition(id, AssayerLifecycleStatus.ON_LEAVE),
          () => transition(id, AssayerLifecycleStatus.SUSPENDED, 'Race probe — suspension.'));

        // One 201. The loser is a 409 (it saw the record move) or a 400 (it arrived after the
        // winner committed and the edge it wanted no longer exists from the new state). Both are
        // honest refusals; neither writes anything.
        expect(codes.filter((c) => c === 201)).toHaveLength(1);
        expect(codes.some((c) => c === 409 || c === 400)).toBe(true);

        // The row landed on exactly one of the two targets, and its projection agrees.
        expect([AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.SUSPENDED])
          .toContain(after.lifecycle_status);
        expect(after.status).toBe(projectionFor(after.lifecycle_status));

        // And the trail records that one move, once. This is the assertion that used to fail.
        expect(await auditDelta(id, before)).toBe(1);
        const [audit] = await q(
          `SELECT previous_state, new_state FROM audit_events WHERE entity_id = $1
             AND event_type = 'ASSAYER_LIFECYCLE_TRANSITION' ORDER BY occurred_at DESC LIMIT 1`, [id]);
        expect(audit.previous_state).toBe(AssayerLifecycleStatus.ACTIVE);
        expect(audit.new_state).toBe(after.lifecycle_status);
      });

    it.each([1, 2, 3, 4])(
      'pair %i — same target twice: one transition, one audit row, no duplicate evidence',
      async (n) => {
        const id = await seed(`LCERT-FIX-RACE-S${n}`, AssayerLifecycleStatus.ACTIVE);
        const before = await auditCount(id);

        const { codes, after } = await race(id,
          () => transition(id, AssayerLifecycleStatus.SUSPENDED, 'Race probe — first.'),
          () => transition(id, AssayerLifecycleStatus.SUSPENDED, 'Race probe — second.'));

        expect(codes.filter((c) => c === 201)).toHaveLength(1);
        expect(after.lifecycle_status).toBe(AssayerLifecycleStatus.SUSPENDED);
        expect(await auditDelta(id, before)).toBe(1);
      });

    /**
     * The double-clicked button, at six times the usual enthusiasm. Before the lock this wrote
     * six audit rows for one move and took the version from 1 to 7.
     */
    it('admits exactly one of six identical simultaneous requests', async () => {
      const id = await seed('LCERT-FIX-RACE-SIX', AssayerLifecycleStatus.INVITED);
      const before = await auditCount(id);

      const results = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() => transition(id, AssayerLifecycleStatus.DOCUMENT_VERIFICATION)),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await auditDelta(id, before)).toBe(1);
      const after = await snapshot(id);
      expect(after.lifecycle_status).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
      expect(Number(after.version)).toBe(2);
    });

    /**
     * The client's own precondition. Optional — the HR screens do not send one — but honoured
     * strictly when it is there, which is what lets an integration demand the guarantee without
     * waiting for the UI to catch up.
     */
    it('refuses a stale expectedVersion and accepts the current one', async () => {
      const id = await seed('LCERT-FIX-RACE-CAS', AssayerLifecycleStatus.ACTIVE);
      /**
       * Move the fixture once first, so it is at version 2 and a "stale" version is 1 rather
       * than 0. `expectedVersion` is `@Min(1)` — a version of zero never existed and is a
       * malformed request, not a stale one, so the DTO answers 400 before the row is ever read.
       * Seeding straight to ACTIVE leaves the row at version 1, which made the obvious
       * `version - 1` land on exactly that case.
       */
      await transition(id, AssayerLifecycleStatus.ON_LEAVE);
      await transition(id, AssayerLifecycleStatus.ACTIVE);
      const { version } = await snapshot(id);
      expect(Number(version)).toBeGreaterThan(1);

      const stale = await post(`/assayers/${id}/lifecycle`, {
        targetStatus: AssayerLifecycleStatus.ON_LEAVE, expectedVersion: Number(version) - 1,
      });
      expect(stale.status).toBe(409);
      expect((await snapshot(id)).lifecycle_status).toBe(AssayerLifecycleStatus.ACTIVE);

      const current = await post(`/assayers/${id}/lifecycle`, {
        targetStatus: AssayerLifecycleStatus.ON_LEAVE, expectedVersion: Number(version),
      });
      expect(current.status).toBe(201);
      expect((await snapshot(id)).lifecycle_status).toBe(AssayerLifecycleStatus.ON_LEAVE);
    });
  });
});
