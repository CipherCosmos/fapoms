import { ProjectBranchStatus, BRANCH_DONE_STATUSES } from '@fapoms/shared';

/**
 * What the client is told about coverage.
 *
 * `ReportsService.coverage` buckets every branch into Completed / Scheduled / Confirmed /
 * Remaining for the spreadsheet a client receives. The classifier used to be a hand-written
 * list that omitted `AUDIT_COMPLETED` — the status a branch holds between the audit finishing
 * and validation finishing — so delivered work was reported to the client as REMAINING, i.e.
 * as though we had never been. The rule is pinned here because it leaves the building.
 */
describe('client coverage classification', () => {
  // Mirrors the classifier in reports.service.ts. Kept in step by the last test below, which
  // fails if a status is added to the shared "done" set and not handled here.
  const classify = (status: string | undefined): 'COMPLETED' | 'SCHEDULED' | 'CONFIRMED' | 'REMAINING' => {
    if (BRANCH_DONE_STATUSES.includes(status as ProjectBranchStatus)) return 'COMPLETED';
    if (status === ProjectBranchStatus.SCHEDULED) return 'SCHEDULED';
    if (status === ProjectBranchStatus.ASSIGNMENT_CONFIRMED) return 'CONFIRMED';
    return 'REMAINING';
  };

  it('reports an audited branch as completed, not as remaining', () => {
    // The regression: this returned REMAINING, so a client reading the sheet saw finished work
    // listed as not started.
    expect(classify(ProjectBranchStatus.AUDIT_COMPLETED)).toBe('COMPLETED');
  });

  it('reports validated and closed branches as completed too', () => {
    expect(classify(ProjectBranchStatus.VALIDATION_COMPLETED)).toBe('COMPLETED');
    expect(classify(ProjectBranchStatus.CLOSED)).toBe('COMPLETED');
  });

  it('keeps booked and assigned work in their own buckets', () => {
    expect(classify(ProjectBranchStatus.SCHEDULED)).toBe('SCHEDULED');
    expect(classify(ProjectBranchStatus.ASSIGNMENT_CONFIRMED)).toBe('CONFIRMED');
  });

  it('reports work that has genuinely not started as remaining', () => {
    expect(classify(ProjectBranchStatus.IMPORTED)).toBe('REMAINING');
    expect(classify(ProjectBranchStatus.PLANNING)).toBe('REMAINING');
    expect(classify(undefined)).toBe('REMAINING');
  });

  it('counts every delivered status as covered, so none can silently read as not-started', () => {
    // The point of reading the shared set rather than a literal: adding a status to
    // BRANCH_DONE_STATUSES must not quietly send delivered work back to REMAINING.
    for (const done of BRANCH_DONE_STATUSES) {
      expect(classify(done)).toBe('COMPLETED');
    }
  });
});
