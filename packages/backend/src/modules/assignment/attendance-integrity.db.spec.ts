import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../infrastructure/database/data-source';
import { AssignmentStatus } from '@fapoms/shared';
import { OperationalIntegrityService } from './operational-integrity.service';

/**
 * The attendance-gap rule, run against real Postgres.
 *
 * There is a unit spec for `OperationalIntegrityService` beside this one and it is not enough,
 * by its own admission: it mocks `dataSource.query` and dispatches on a fragment of each
 * statement, so **no rule's SQL is ever executed**. Demonstrated rather than assumed — appending
 * `AND false` to this rule's WHERE clause leaves all fifteen of those tests green. A rule that
 * has quietly stopped matching anything is exactly the failure mode the scanner cannot afford,
 * because zero violations is the report an auditor is shown.
 *
 * So this one asks a real database real questions. Three rows are seeded to sit either side of
 * the rule's boundary, and the assertions are about set membership: the row with an arrival and
 * no departure is found, the row with both ends is not, and the row with neither lands on the
 * sibling rule instead of this one. `AND false` cannot survive that, and neither can a predicate
 * that has widened to catch complete visits.
 *
 * Add to the CI regex in .github/workflows/ci.yml (the `\.db\.spec\.ts$` alternation) or this
 * file runs only when someone runs it by hand.
 */
describe('COMPLETED_ASSIGNMENT_WITHOUT_CHECK_OUT against real Postgres', () => {
  jest.setTimeout(60000);

  let ds: DataSource;
  let service: OperationalIntegrityService;

  const RUN = `ATT${Date.now().toString().slice(-9)}`;
  const createdAssignments: string[] = [];
  const createdProjectBranches: string[] = [];
  const createdProjects: string[] = [];
  const createdBranches: string[] = [];
  const createdAssayers: string[] = [];
  const createdClients: string[] = [];

  const arrival = new Date('2026-08-20T09:00:00Z');
  const departure = new Date('2026-08-20T11:15:00Z');

  let noDeparture: string;
  let bothEnds: string;
  let noArrival: string;

  async function seedParents(suffix: string) {
    const clientId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO clients (id, client_code, name, display_name, is_active, version)
       VALUES ($1, $2, $3, $3, true, 1)`,
      [clientId, `CL-${RUN}-${suffix}`, `Client ${RUN}${suffix}`],
    );
    createdClients.push(clientId);

    const projectId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO projects (id, client_id, project_number, name, status, is_active, version)
       VALUES ($1, $2, $3, $4, 'PLANNING', true, 1)`,
      [projectId, clientId, `PRJ-${RUN}-${suffix}`, `Project ${RUN}${suffix}`],
    );
    createdProjects.push(projectId);

    const branchId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO branches (id, client_id, sol_id, name, address, state, district, city, is_active, version, organization_id)
       VALUES ($1, $2, $3, $4, '1 Attendance St', 'Maharashtra', 'Mumbai', 'Mumbai', true, 1,
               (SELECT id FROM organizations WHERE is_active = true ORDER BY created_at LIMIT 1))`,
      [branchId, clientId, `SOL-${RUN}-${suffix}`, `Branch ${RUN}${suffix}`],
    );
    createdBranches.push(branchId);

    const projectBranchId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO project_branches (id, project_id, branch_id, status, is_active, version)
       VALUES ($1, $2, $3, 'PLANNING', true, 1)`,
      [projectBranchId, projectId, branchId],
    );
    createdProjectBranches.push(projectBranchId);

    const assayerId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO assayers (id, assayer_code, first_name, last_name, display_name, phone, status,
                             lifecycle_status, is_active, address, state, district, city, version)
       VALUES ($1, $2, 'Att', $3, $4, $5, 'ACTIVE', 'ACTIVE', true, '1 Attendance St', 'Maharashtra', 'Mumbai', 'Mumbai', 1)`,
      [assayerId, `AS-${RUN}-${suffix}`, suffix, `Assayer ${RUN}${suffix}`,
       `987${Math.floor(1000000 + Math.random() * 9000000)}`],
    );
    createdAssayers.push(assayerId);

    return { projectId, projectBranchId, assayerId };
  }

  /**
   * Written as raw SQL on purpose. The point is what the SCANNER sees in the table, so the row
   * must be placed there directly rather than through the very code path whose refusal this
   * change added — which could no longer produce the unexplained shape the 15 historical rows
   * have, and those are the rows the rule exists to find.
   */
  async function seedAssignment(
    suffix: string,
    { checkedInAt, checkedOutAt, reason }:
      { checkedInAt: Date | null; checkedOutAt: Date | null; reason?: string | null },
  ): Promise<string> {
    const p = await seedParents(suffix);
    const id = crypto.randomUUID();
    await ds.query(
      `INSERT INTO assignments (id, assignment_number, assayer_id, project_id, project_branch_id,
                                scheduled_date, status, completion_date, checked_in_at, checked_out_at,
                                completed_without_check_out_reason, is_active, entity_version, version)
       VALUES ($1, $2, $3, $4, $5, '2026-08-20', $6, '2026-08-20', $7, $8, $9, true, 1, 1)`,
      [id, `ASN-${RUN}-${suffix}`, p.assayerId, p.projectId, p.projectBranchId,
       AssignmentStatus.COMPLETED, checkedInAt, checkedOutAt, reason ?? null],
    );
    createdAssignments.push(id);
    return id;
  }

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    ds = AppDataSource;
    service = new OperationalIntegrityService(ds);

    noDeparture = await seedAssignment('ND', { checkedInAt: arrival, checkedOutAt: null });
    bothEnds = await seedAssignment('BE', { checkedInAt: arrival, checkedOutAt: departure });
    noArrival = await seedAssignment('NA', { checkedInAt: null, checkedOutAt: null });
  });

  afterAll(async () => {
    try {
      if (createdAssignments.length) await ds.query(`DELETE FROM assignments WHERE id = ANY($1)`, [createdAssignments]);
      if (createdProjectBranches.length) await ds.query(`DELETE FROM project_branches WHERE id = ANY($1)`, [createdProjectBranches]);
      if (createdProjects.length) await ds.query(`DELETE FROM projects WHERE id = ANY($1)`, [createdProjects]);
      if (createdBranches.length) await ds.query(`DELETE FROM branches WHERE id = ANY($1)`, [createdBranches]);
      if (createdAssayers.length) await ds.query(`DELETE FROM assayers WHERE id = ANY($1)`, [createdAssayers]);
      if (createdClients.length) await ds.query(`DELETE FROM clients WHERE id = ANY($1)`, [createdClients]);
      if (ds?.isInitialized) await ds.destroy();
    } catch (err) {
      console.warn('Cleanup error:', err);
    }
  });

  const findingsFor = async (rule: string) => {
    const report = await service.scan();
    expect(report.failedRules).toEqual([]);            // a rule that threw would fake a clean result
    return report.violations.filter((v) => v.rule === rule);
  };

  it('finds the completed audit that arrived and never left', async () => {
    const found = await findingsFor('COMPLETED_ASSIGNMENT_WITHOUT_CHECK_OUT');
    const mine = found.find((v) => v.entityId === noDeparture);

    expect(mine).toBeDefined();
    expect(mine!.severity).toBe('P1');
    expect(mine!.description).toContain('no check-out');
    expect(mine!.details.checked_out_at).toBeNull();
  });

  it('does not report a visit that has both ends on record', async () => {
    const found = await findingsFor('COMPLETED_ASSIGNMENT_WITHOUT_CHECK_OUT');

    // The half of the boundary a widened predicate would break. Without this, a rule that fired
    // on every completed assignment would still pass the test above.
    expect(found.map((v) => v.entityId)).not.toContain(bothEnds);
  });

  it('leaves a visit with no arrival at all to the sibling rule', async () => {
    const noCheckOut = await findingsFor('COMPLETED_ASSIGNMENT_WITHOUT_CHECK_OUT');
    const noAttendance = await findingsFor('COMPLETED_ASSIGNMENT_WITHOUT_ATTENDANCE');

    // One gap, one finding. Reporting it under both would double-count the same visit and make
    // "how many audits have no measurable time on site" unanswerable from the report.
    expect(noCheckOut.map((v) => v.entityId)).not.toContain(noArrival);
    expect(noAttendance.map((v) => v.entityId)).toContain(noArrival);
  });

  it('still reports the gap when a reason was stated for it', async () => {
    const explained = await seedAssignment('EX', {
      checkedInAt: arrival, checkedOutAt: null, reason: 'Phone battery died before checking out.',
    });

    const found = await findingsFor('COMPLETED_ASSIGNMENT_WITHOUT_CHECK_OUT');
    const mine = found.find((v) => v.entityId === explained);

    // A stated reason records who said what. It does not make the visit measurable, so it must
    // not make the finding disappear — that would let the gap be closed by typing a sentence.
    expect(mine).toBeDefined();
    expect(mine!.details.completed_without_check_out_reason).toContain('battery died');
    expect(mine!.description).toContain('Stated reason');
  });

  it('agrees exactly with the table it is reporting on', async () => {
    // The assertion `AND false` cannot survive, and neither can a stale predicate: the scanner's
    // set and the database's set must be the same set, not merely overlapping.
    const found = await findingsFor('COMPLETED_ASSIGNMENT_WITHOUT_CHECK_OUT');
    const expected: Array<{ id: string }> = await ds.query(
      `SELECT id FROM assignments
        WHERE status = 'COMPLETED' AND checked_in_at IS NOT NULL AND checked_out_at IS NULL AND is_active = true`,
    );

    expect(found.map((v) => v.entityId).sort()).toEqual(expected.map((r) => r.id).sort());
    expect(found.length).toBeGreaterThan(0);
  });
});
