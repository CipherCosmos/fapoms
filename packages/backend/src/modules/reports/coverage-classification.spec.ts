import { ProjectBranchStatus, BRANCH_DONE_STATUSES, coverageBucketOf } from '@fapoms/shared';

/**
 * What the client is told about coverage.
 *
 * `ReportsService.coverage` buckets every branch into Completed / Scheduled / Confirmed /
 * Remaining for the spreadsheet a client receives. The classifier used to be a hand-written
 * list that omitted `AUDIT_COMPLETED` — the status a branch holds between the audit finishing
 * and validation finishing — so delivered work was reported to the client as REMAINING, i.e.
 * as though we had never been. The rule is pinned here because it leaves the building.
 *
 * This file used to carry its own copy of the classifier, described as "mirrors the classifier in
 * reports.service.ts" — a fourth copy of the definition, and one that would keep passing after the
 * shipped code drifted away from it. It now exercises the shared `coverageBucketOf` that both
 * `reports.service.ts` and `planning-orchestrator.service.ts` call.
 */
describe('client coverage classification', () => {
  it('reports an audited branch as completed, not as remaining', () => {
    // The regression: this returned REMAINING, so a client reading the sheet saw finished work
    // listed as not started.
    expect(coverageBucketOf(ProjectBranchStatus.AUDIT_COMPLETED)).toBe('COMPLETED');
  });

  it('reports validated and closed branches as completed too', () => {
    expect(coverageBucketOf(ProjectBranchStatus.VALIDATION_COMPLETED)).toBe('COMPLETED');
    expect(coverageBucketOf(ProjectBranchStatus.CLOSED)).toBe('COMPLETED');
  });

  it('keeps booked and assigned work in their own buckets', () => {
    expect(coverageBucketOf(ProjectBranchStatus.SCHEDULED)).toBe('SCHEDULED');
    expect(coverageBucketOf(ProjectBranchStatus.ASSIGNMENT_CONFIRMED)).toBe('CONFIRMED');
  });

  it('reports work that has genuinely not started as remaining', () => {
    expect(coverageBucketOf(ProjectBranchStatus.IMPORTED)).toBe('REMAINING');
    expect(coverageBucketOf(ProjectBranchStatus.PLANNING)).toBe('REMAINING');
    expect(coverageBucketOf(undefined)).toBe('REMAINING');
  });

  it('counts every delivered status as covered, so none can silently read as not-started', () => {
    // The point of reading the shared set rather than a literal: adding a status to
    // BRANCH_DONE_STATUSES must not quietly send delivered work back to REMAINING.
    for (const done of BRANCH_DONE_STATUSES) {
      expect(coverageBucketOf(done)).toBe('COMPLETED');
    }
  });
});
