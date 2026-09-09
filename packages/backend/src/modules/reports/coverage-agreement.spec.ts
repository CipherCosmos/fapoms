import * as xlsx from 'xlsx';
import { ProjectBranchStatus } from '@fapoms/shared';
import { ReportsService } from './reports.service';
import { PlanningOrchestratorService } from '../planning/planning-orchestrator.service';

/**
 * The planning screen and the client workbook must report the same coverage for the same project.
 *
 * They did not. On the certification project — 22 active branches, 8 of them AUDIT_COMPLETED —
 * `GET /planning/projects/:id/coverage` returned 9.1% and `GET /reports/coverage/:id` returned
 * 45.5%, on the same day, off the same rows. Two copies of one definition, one of which had been
 * fixed.
 *
 * This suite drives BOTH real implementations from one fixture and compares them. It is
 * deliberately not a test of `coverageFromStatuses` — that is unit-tested in the shared package.
 * It is a test that neither endpoint has its own arithmetic any more, so it fails if someone
 * reintroduces a local bucket list in either service, whatever that list happens to say.
 */

/** Every branch status combination the two surfaces have to agree about. */
const FIXTURES: Array<{ name: string; branches: ProjectBranchStatus[]; expectedPct: number }> = [
  {
    name: 'zero completed — staffed and unstaffed work only',
    branches: [
      ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
      ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
      ProjectBranchStatus.SCHEDULED,
      ProjectBranchStatus.SCHEDULED,
      ProjectBranchStatus.IMPORTED,
      ProjectBranchStatus.PLANNING,
      ProjectBranchStatus.CANDIDATE_SEARCH,
      ProjectBranchStatus.CONTACT_INITIATED,
    ],
    expectedPct: 50,
  },
  {
    name: 'partially completed — the shape that diverged live',
    branches: [
      ...Array<ProjectBranchStatus>(8).fill(ProjectBranchStatus.AUDIT_COMPLETED),
      ProjectBranchStatus.SCHEDULED,
      ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
      ProjectBranchStatus.IMPORTED,
      ...Array<ProjectBranchStatus>(11).fill(ProjectBranchStatus.PLANNING),
    ],
    expectedPct: 45.5,
  },
  {
    name: 'fully completed — audited, validated and closed',
    branches: [
      ProjectBranchStatus.AUDIT_COMPLETED,
      ProjectBranchStatus.AUDIT_COMPLETED,
      ProjectBranchStatus.VALIDATION_COMPLETED,
      ProjectBranchStatus.VALIDATION_COMPLETED,
      ProjectBranchStatus.CLOSED,
      ProjectBranchStatus.CLOSED,
    ],
    expectedPct: 100,
  },
  {
    name: 'rejected — the offer was declined and the branch went back to candidate search',
    branches: [
      ProjectBranchStatus.CANDIDATE_SEARCH,
      ProjectBranchStatus.CANDIDATE_SEARCH,
      ProjectBranchStatus.SCHEDULED,
      ProjectBranchStatus.CLOSED,
    ],
    expectedPct: 50,
  },
  {
    name: 'cancelled — work withdrawn, and a branch nobody could cover',
    branches: [
      ProjectBranchStatus.CANCELLED,
      ProjectBranchStatus.UNABLE_TO_COVER,
      ProjectBranchStatus.ON_HOLD,
      ProjectBranchStatus.SCHEDULED,
    ],
    expectedPct: 25,
  },
  {
    name: 'reassigned — the branch stays covered while the assayer changes',
    branches: [
      ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
      ProjectBranchStatus.SCHEDULED,
      ProjectBranchStatus.AUDIT_COMPLETED,
      ProjectBranchStatus.CANDIDATE_SEARCH,
    ],
    expectedPct: 75,
  },
];

/** The planning endpoint's real query, fed the `GROUP BY status` rows its SQL would return. */
function planningServiceFor(branches: ProjectBranchStatus[]): PlanningOrchestratorService {
  const counts = new Map<string, number>();
  for (const s of branches) counts.set(s, (counts.get(s) ?? 0) + 1);
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    // Postgres returns COUNT(*) as a string; the fixture keeps that so the shared calculation
    // is exercised with the types it really sees.
    getRawMany: jest.fn().mockResolvedValue(
      [...counts].map(([status, count]) => ({ status, count: String(count) })),
    ),
  };
  return new PlanningOrchestratorService({ createQueryBuilder: () => qb } as any);
}

/** The export's real path, including the workbook bytes, read back out of the buffer. */
async function exportSummaryFor(branches: ProjectBranchStatus[]) {
  const projectQueryService: any = {
    findProjectBranches: jest.fn().mockResolvedValue(
      branches.map((status, i) => ({
        status,
        branch: { solId: `SOL${i}`, name: `Branch ${i}`, district: 'D', state: 'S' },
        assignments: [],
        scheduledDate: null,
      })),
    ),
    findOne: jest.fn().mockResolvedValue({ id: 'p1' }),
  };
  const service = new ReportsService(
    {} as any, {} as any, {} as any, {} as any, projectQueryService, {} as any,
  );
  const buffer = await service.coverage('p1');
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const [header, row] = xlsx.utils.sheet_to_json<any[]>(wb.Sheets['Summary'], { header: 1 });
  const at = (name: string) => row[(header as any[]).indexOf(name)];
  return {
    total: at('Total Branches'),
    completed: at('Completed'),
    scheduled: at('Scheduled'),
    confirmed: at('Confirmed'),
    remaining: at('Remaining'),
    coveragePercentage: at('Coverage %'),
  };
}

describe('project coverage: the planning endpoint and the client workbook agree', () => {
  for (const fixture of FIXTURES) {
    it(`agrees on "${fixture.name}"`, async () => {
      const planning = await planningServiceFor(fixture.branches).getProjectCoverage('p1');
      const exported = await exportSummaryFor(fixture.branches);

      expect(planning.coveragePercentage).toBe(exported.coveragePercentage);
      expect(planning.coveragePercentage).toBe(fixture.expectedPct);

      // Not just the headline: every bucket has to match, because the planning endpoint used to
      // sum CLOSED and VALIDATION_COMPLETED into the one labelled `scheduled`.
      expect({
        total: planning.total,
        completed: planning.completed,
        scheduled: planning.scheduled,
        confirmed: planning.confirmed,
        remaining: planning.remaining,
        coveragePercentage: planning.coveragePercentage,
      }).toEqual(exported);

      expect(planning.total).toBe(fixture.branches.length);
      expect(planning.covered).toBe(planning.completed + planning.scheduled + planning.confirmed);
    });
  }

  it('never reports delivered work as scheduled or as remaining', async () => {
    const branches = [ProjectBranchStatus.AUDIT_COMPLETED, ProjectBranchStatus.VALIDATION_COMPLETED, ProjectBranchStatus.CLOSED];
    const planning = await planningServiceFor(branches).getProjectCoverage('p1');
    expect(planning.completed).toBe(3);
    expect(planning.scheduled).toBe(0);
    expect(planning.remaining).toBe(0);
    expect(planning.coveragePercentage).toBe(100);
  });

  it('reports zero rather than NaN for a project with no active branches', async () => {
    const planning = await planningServiceFor([]).getProjectCoverage('p-empty');
    const exported = await exportSummaryFor([]);
    expect(planning.coveragePercentage).toBe(0);
    expect(exported.coveragePercentage).toBe(0);
    expect(planning.total).toBe(0);
  });
});
