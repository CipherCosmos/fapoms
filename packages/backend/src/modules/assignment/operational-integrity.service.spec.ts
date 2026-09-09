import { DataSource } from 'typeorm';
import { OperationalIntegrityService } from './operational-integrity.service';

/**
 * The operational integrity scanner — the thing an ADMIN, OPERATIONS or AUDITOR user runs to ask
 * "is our assignment data self-consistent?", behind `GET /assignments/operational-integrity/scan`.
 *
 * ## Why it needed a spec
 *
 * 60.41% of statements, 0% of branches, 18.18% of functions. The one existing file that constructs
 * it — `assignment-phase2-concurrency.spec.ts` — registers it as a provider and then never calls
 * `scan()`, so the nine rules, their severities and their descriptions had never been executed by
 * anything in the unit run.
 *
 * That matters more here than the percentage suggests, because of the shape of the class. Every one
 * of the nine queries ends `.catch(() => [])`. A rule whose SQL no longer matches the schema — a
 * renamed column, a status value that no longer exists, a table that grew a tenant predicate —
 * therefore contributes zero violations, and zero violations is indistinguishable from a clean
 * result. The report still says `scannedRules: 9`. So the failure mode of this scanner is that it
 * reports perfect health, which is the single worst thing an integrity scanner can do: it is the
 * report an auditor is shown, and a P0 rule like ASSIGNMENT_LINKED_TO_INELIGIBLE_ASSAYER going
 * quiet reads exactly like the problem having been fixed.
 *
 * These tests do two things about that. They pin what each rule finds and how it is classified, so
 * a rule cannot lose its severity or its identifying id without a red test. And they pin the
 * swallow itself, explicitly and by name, so that the day someone decides an all-clear ought to be
 * distinguishable from a broken query, the test that has to change says why it exists.
 *
 * ## What is mocked
 *
 * `dataSource.query` only, dispatched on a fragment of each statement. Nothing here claims the SQL
 * is valid against the schema — that is not knowable without a database, and it is the gap the
 * swallow turns into silence. What is knowable, and is asserted, is that a row the database returns
 * becomes the right violation with the right severity and a description that names the record.
 */

describe('OperationalIntegrityService.scan', () => {
  let service: OperationalIntegrityService;
  let query: jest.Mock;

  /**
   * Routes each of the nine statements by a fragment unique to it, so a test can answer one rule
   * and leave the other eight empty. Keyed on the distinguishing clause rather than on call order:
   * order is an implementation detail, and a test that depends on it breaks when a rule is added.
   */
  const RULE_MATCH: Array<[string, string]> = [
    ['doubleBooking', 'GROUP BY assayer_id, scheduled_date'],
    ['branchSlot', 'GROUP BY project_branch_id'],
    ['cancelledWithAttendance', "status = 'CANCELLED'"],
    ['completedWithoutAttendance', 'checked_in_at IS NULL'],
    ['ineligibleAssayer', 'INNER JOIN assayers'],
    ['invalidLifecycle', 'incompatible' /* never matches; see resolve below */],
    ['invalidEmploymentDates', 'exit_date < joining_date'],
    ['incompleteKyc', 'trim(pan_number)'],
    ['orphanAssignment', 'LEFT JOIN project_branches'],
  ];

  /**
   * `invalidLifecycle` has no single unique fragment (its clauses appear in other rules), so it is
   * identified by the combination that only it carries.
   */
  const ruleOf = (sql: string): string => {
    if (sql.includes("(status = 'COMPLETED' AND completion_date IS NULL)")) return 'invalidLifecycle';
    for (const [name, fragment] of RULE_MATCH) {
      if (name === 'invalidLifecycle') continue;
      if (sql.includes(fragment)) return name;
    }
    return 'unknown';
  };

  /** Answers named rules with rows and every other rule with nothing. */
  const serve = (rows: Record<string, any[] | Error>) => {
    query.mockImplementation(async (sql: string) => {
      const answer = rows[ruleOf(sql)];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    });
  };

  beforeEach(() => {
    query = jest.fn();
    service = new OperationalIntegrityService({ query } as unknown as DataSource);
  });

  describe('a clean database', () => {
    it('reports nine rules scanned, no violations, and an empty summary', async () => {
      serve({});

      const report = await service.scan();

      expect(report.scannedRules).toBe(9);
      expect(report.totalViolations).toBe(0);
      expect(report.violations).toEqual([]);
      expect(report.summary).toEqual({});
      expect(Date.parse(report.timestamp)).not.toBeNaN();
    });

    it('issues one statement per rule and mutates nothing', async () => {
      serve({});

      await service.scan();

      expect(query).toHaveBeenCalledTimes(9);
      // "Read-only" is in the method's own description and is the reason an AUDITOR may call it.
      // A scanner that repaired what it found would be a scanner nobody could safely run twice.
      const statements = query.mock.calls.map(([sql]) => String(sql).toUpperCase());
      for (const sql of statements) {
        expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE|DROP|ALTER)\b/);
      }
    });
  });

  describe('the two P0 rules — the ones that mean work is happening it should not', () => {
    it('flags one branch holding two concurrent active assignments', async () => {
      serve({
        branchSlot: [{
          project_branch_id: 'pb-1',
          count: '2',
          assignment_ids: ['as-1', 'as-2'],
          assignment_numbers: ['ASG-001', 'ASG-002'],
        }],
      });

      const report = await service.scan();

      const v = report.violations.find((x) => x.rule === 'MULTIPLE_ACTIVE_ASSIGNMENTS_PER_BRANCH');
      expect(v).toBeDefined();
      expect(v!.severity).toBe('P0');
      expect(v!.entityId).toBe('pb-1');
      // The numbers, not the uuids, because the person reading this report finds an assignment by
      // its number and cannot look up a uuid in any screen the product has.
      expect(v!.description).toContain('ASG-001, ASG-002');
    });

    it('flags an active assignment held by an assayer who is no longer eligible', async () => {
      serve({
        ineligibleAssayer: [{
          id: 'as-9',
          assignment_number: 'ASG-009',
          assignment_status: 'ACCEPTED',
          assayer_id: 'a-9',
          assayer_code: 'AS0009',
          assayer_status: 'SUSPENDED',
          assayer_is_active: false,
        }],
      });

      const report = await service.scan();

      const v = report.violations.find((x) => x.rule === 'ASSIGNMENT_LINKED_TO_INELIGIBLE_ASSAYER');
      expect(v!.severity).toBe('P0');
      // This is the rule that says a suspended person is currently holding live field work at a
      // client's branch. Its severity is the whole signal — demoted to P1 it sorts in with date
      // typos, which is where it would stop being acted on the same day.
      expect(v!.entityId).toBe('as-9');
      expect(v!.description).toContain('AS0009');
      expect(v!.description).toContain('SUSPENDED');
    });
  });

  describe('the P1 rules — assignments whose recorded history contradicts itself', () => {
    it('flags a cancelled assignment that nonetheless carries attendance evidence', async () => {
      serve({
        cancelledWithAttendance: [{
          id: 'as-2', assignment_number: 'ASG-002', status: 'CANCELLED',
          checked_in_at: '2026-02-01T09:00:00Z', checked_out_at: null, cancel_reason: 'client withdrew',
        }],
      });

      const report = await service.scan();
      const v = report.violations.find((x) => x.rule === 'CANCELLED_ASSIGNMENT_WITH_ATTENDANCE');

      expect(v!.severity).toBe('P1');
      // Attendance is what a payable is computed from, so this pairing is a cancelled job somebody
      // may still be paid for. The check-in timestamp belongs in the description because it is the
      // fact that decides whether this is a stale marker or a real visit that was cancelled after.
      expect(v!.description).toContain('2026-02-01T09:00:00Z');
    });

    it('flags a completed assignment with no attendance at all', async () => {
      serve({
        completedWithoutAttendance: [{
          id: 'as-3', assignment_number: 'ASG-003', status: 'COMPLETED',
          completion_date: '2026-02-02', checked_in_at: null,
        }],
      });

      const report = await service.scan();

      expect(report.violations[0].rule).toBe('COMPLETED_ASSIGNMENT_WITHOUT_ATTENDANCE');
      expect(report.violations[0].severity).toBe('P1');
    });

    it('flags a status that contradicts its own lifecycle markers', async () => {
      serve({
        invalidLifecycle: [{
          id: 'as-4', assignment_number: 'ASG-004', status: 'IN_PROGRESS',
          checked_in_at: null, completion_date: null,
        }],
      });

      const report = await service.scan();

      expect(report.violations[0].rule).toBe('INVALID_LIFECYCLE_COMBINATION');
      expect(report.violations[0].description).toContain('IN_PROGRESS');
    });

    it('flags an active assignment pointing at a project branch that is gone or inactive', async () => {
      serve({
        orphanAssignment: [{
          id: 'as-5', assignment_number: 'ASG-005', status: 'PENDING', project_branch_id: 'pb-gone',
        }],
      });

      const report = await service.scan();

      expect(report.violations[0].rule).toBe('STALE_ORPHAN_WORKFLOW_RECORD');
      expect(report.violations[0].severity).toBe('P1');
    });
  });

  describe('the P2 rules — records that are wrong but are not stopping work today', () => {
    it('flags an exit date that precedes the joining date', async () => {
      serve({
        invalidEmploymentDates: [{
          id: 'a-7', assayer_code: 'AS0007', display_name: 'Test Person',
          joining_date: '2025-06-01', exit_date: '2024-01-01',
        }],
      });

      const report = await service.scan();

      expect(report.violations[0].rule).toBe('INVALID_EMPLOYMENT_DATES');
      expect(report.violations[0].severity).toBe('P2');
      expect(report.violations[0].description).toContain('2024-01-01');
    });

    it('names which payout field is missing, rather than only that one is', async () => {
      serve({
        incompleteKyc: [{
          id: 'a-8', assayer_code: 'AS0008', display_name: 'No Pan',
          pan_number: null, bank_account_number: '123', ifsc_code: 'ABCD0123456',
        }],
      });

      const report = await service.scan();

      // `missing PAN=true, Bank=false, IFSC=false` — the difference between a report someone can
      // act on and a list of 500 codes that all say "incomplete".
      expect(report.violations[0].description).toContain('PAN=true');
      expect(report.violations[0].description).toContain('Bank=false');
      expect(report.violations[0].description).toContain('IFSC=false');
    });
  });

  describe('the summary', () => {
    it('counts violations by rule across several rules at once', async () => {
      serve({
        doubleBooking: [
          { assayer_id: 'a-1', scheduled_date: '2026-02-01', count: '2', assignment_numbers: ['ASG-1', 'ASG-2'] },
          { assayer_id: 'a-2', scheduled_date: '2026-02-01', count: '3', assignment_numbers: ['ASG-3', 'ASG-4', 'ASG-5'] },
        ],
        invalidEmploymentDates: [
          { id: 'a-7', assayer_code: 'AS0007', display_name: 'X', joining_date: '2025-01-01', exit_date: '2024-01-01' },
        ],
      });

      const report = await service.scan();

      expect(report.totalViolations).toBe(3);
      expect(report.summary).toEqual({
        MULTIPLE_ACTIVE_ASSIGNMENTS_PER_ASSAYER_DAY: 2,
        INVALID_EMPLOYMENT_DATES: 1,
      });
    });

    it('carries the raw row through as details, so a reader is not limited to the sentence', async () => {
      const row = { assayer_id: 'a-1', scheduled_date: '2026-02-01', count: '2', assignment_ids: ['x', 'y'] };
      serve({ doubleBooking: [row] });

      const report = await service.scan();

      expect(report.violations[0].details).toEqual(row);
    });
  });

  describe('a rule whose query fails', () => {
    /**
     * This is the behaviour, and it is worth stating plainly rather than leaving to be discovered:
     * `.catch(() => [])` on each query means a rule that cannot run is reported as a rule that
     * found nothing.
     *
     * The upside is real — one broken statement does not deny an auditor the other eight rules —
     * and it is why the test asserts the survivors first. The cost is that `scannedRules: 9` is a
     * count of rules ATTEMPTED being presented as a count of rules ANSWERED, and nothing in the
     * response distinguishes them. An operator reading this report cannot tell a clean database
     * from a scanner that has quietly stopped looking.
     *
     * If that is ever fixed — a `failedRules: string[]` on the report is the obvious shape, and the
     * severity of a silent all-clear argues for it — this test is the one that will fail, and it
     * should be changed to assert the new field rather than deleted.
     */
    it('still returns the other eight rules’ findings', async () => {
      serve({
        ineligibleAssayer: new Error('column "assayer_status" does not exist'),
        invalidEmploymentDates: [
          { id: 'a-7', assayer_code: 'AS0007', display_name: 'X', joining_date: '2025-01-01', exit_date: '2024-01-01' },
        ],
      });

      const report = await service.scan();

      expect(report.violations.map((v) => v.rule)).toEqual(['INVALID_EMPLOYMENT_DATES']);
    });

    it('reports the failed rule as nine-scanned and zero-found — an all-clear it did not earn', async () => {
      serve({ ineligibleAssayer: new Error('column "assayer_status" does not exist') });

      const report = await service.scan();

      expect(report.scannedRules).toBe(9);
      expect(report.totalViolations).toBe(0);
      expect(report.summary).toEqual({});
      // Nothing anywhere in the response names the rule that could not run. That is the gap.
      expect(JSON.stringify(report)).not.toContain('ASSIGNMENT_LINKED_TO_INELIGIBLE_ASSAYER');
    });

    it('does not throw when every single rule fails', async () => {
      query.mockRejectedValue(new Error('connection terminated'));

      // The route is behind a role guard and is expected to answer, not 500 — but note that the
      // answer it gives here is a perfectly clean bill of health for a database it could not read
      // one row of.
      const report = await service.scan();

      expect(report.totalViolations).toBe(0);
      expect(report.scannedRules).toBe(9);
    });
  });
});
