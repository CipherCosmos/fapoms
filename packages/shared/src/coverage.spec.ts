import { ProjectBranchStatus } from './enums';
import { BRANCH_COVERED_STATUSES, BRANCH_DONE_STATUSES } from './labels';
import {
  coverageBucketOf,
  coverageFromCounts,
  coverageFromStatuses,
  isBranchCovered,
} from './coverage';

/**
 * The bucketing and the covered set must be the same statement of the same rule.
 *
 * `AUDIT_COMPLETED` was in `BRANCH_COVERED_STATUSES` and in nobody's bucket, so the planning
 * endpoint counted delivered audits as work not yet started. These tests fail if that can happen
 * again — for `AUDIT_COMPLETED` or for any status added to the set later.
 */
describe('coverage buckets and the covered set are one definition', () => {
  it('gives every covered status a covered bucket', () => {
    for (const status of BRANCH_COVERED_STATUSES) {
      expect(coverageBucketOf(status)).not.toBe('REMAINING');
    }
  });

  it('gives every uncovered status the REMAINING bucket', () => {
    const uncovered = Object.values(ProjectBranchStatus).filter((s) => !BRANCH_COVERED_STATUSES.includes(s));
    for (const status of uncovered) {
      expect(coverageBucketOf(status)).toBe('REMAINING');
    }
    // Guard against the set swallowing the whole enum, which would make the loop vacuous.
    expect(uncovered).toEqual(expect.arrayContaining([
      ProjectBranchStatus.IMPORTED,
      ProjectBranchStatus.PLANNING,
      ProjectBranchStatus.CANDIDATE_SEARCH,
      ProjectBranchStatus.UNABLE_TO_COVER,
      ProjectBranchStatus.CANCELLED,
    ]));
  });

  it('reads AUDIT_COMPLETED as delivered work, which is what the planner used to lose', () => {
    expect(coverageBucketOf(ProjectBranchStatus.AUDIT_COMPLETED)).toBe('COMPLETED');
    expect(isBranchCovered(ProjectBranchStatus.AUDIT_COMPLETED)).toBe(true);
  });

  it('never labels finished work as scheduled', () => {
    // The planning endpoint summed CLOSED and VALIDATION_COMPLETED into a bucket called
    // `scheduled`, telling planners that delivered audits were still to be staffed.
    for (const status of BRANCH_DONE_STATUSES) {
      expect(coverageBucketOf(status)).toBe('COMPLETED');
    }
    expect(coverageBucketOf(ProjectBranchStatus.SCHEDULED)).toBe('SCHEDULED');
  });

  it('agrees with isBranchCovered on every status in the enum', () => {
    for (const status of Object.values(ProjectBranchStatus)) {
      expect(coverageBucketOf(status) !== 'REMAINING').toBe(isBranchCovered(status));
    }
  });
});

describe('the coverage calculation', () => {
  it('returns the same breakdown from counts and from a row list', () => {
    const rows = [
      ...Array(8).fill(ProjectBranchStatus.AUDIT_COMPLETED),
      ProjectBranchStatus.SCHEDULED,
      ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
      ProjectBranchStatus.IMPORTED,
      ...Array(11).fill(ProjectBranchStatus.PLANNING),
    ];
    const fromRows = coverageFromStatuses(rows);
    const fromCounts = coverageFromCounts([
      [ProjectBranchStatus.AUDIT_COMPLETED, '8'],
      [ProjectBranchStatus.SCHEDULED, '1'],
      [ProjectBranchStatus.ASSIGNMENT_CONFIRMED, '1'],
      [ProjectBranchStatus.IMPORTED, '1'],
      [ProjectBranchStatus.PLANNING, '11'],
    ]);

    expect(fromRows).toEqual(fromCounts);
    // The live certification project, which the two endpoints reported as 9.1% and 45.5%.
    expect(fromRows).toEqual({
      total: 22, completed: 8, scheduled: 1, confirmed: 1, remaining: 12, covered: 10,
      coveragePercentage: 45.5,
    });
  });

  it('accepts a Map, an entry list and a plain object alike', () => {
    const expected = { total: 4, completed: 2, scheduled: 1, confirmed: 0, remaining: 1, covered: 3, coveragePercentage: 75 };
    expect(coverageFromCounts(new Map<string, number>([
      [ProjectBranchStatus.CLOSED, 2], [ProjectBranchStatus.SCHEDULED, 1], [ProjectBranchStatus.ON_HOLD, 1],
    ]))).toEqual(expected);
    expect(coverageFromCounts([
      [ProjectBranchStatus.CLOSED, 2], [ProjectBranchStatus.SCHEDULED, 1], [ProjectBranchStatus.ON_HOLD, 1],
    ])).toEqual(expected);
    expect(coverageFromCounts({ CLOSED: 2, SCHEDULED: 1, ON_HOLD: 1 })).toEqual(expected);
  });

  it('counts a project with nothing done as zero rather than NaN', () => {
    expect(coverageFromStatuses([])).toEqual({
      total: 0, completed: 0, scheduled: 0, confirmed: 0, remaining: 0, covered: 0, coveragePercentage: 0,
    });
  });

  it('counts branches we could not cover against us, in the denominator', () => {
    const result = coverageFromStatuses([
      ProjectBranchStatus.CLOSED,
      ProjectBranchStatus.UNABLE_TO_COVER,
      ProjectBranchStatus.CANCELLED,
      ProjectBranchStatus.SCHEDULED,
    ]);
    expect(result.total).toBe(4);
    expect(result.covered).toBe(2);
    expect(result.coveragePercentage).toBe(50);
  });

  it('keeps covered = completed + scheduled + confirmed and total = covered + remaining', () => {
    const result = coverageFromStatuses(Object.values(ProjectBranchStatus));
    expect(result.covered).toBe(result.completed + result.scheduled + result.confirmed);
    expect(result.total).toBe(result.covered + result.remaining);
    expect(result.covered).toBe(BRANCH_COVERED_STATUSES.length);
  });

  it('rounds to one decimal place', () => {
    expect(coverageFromStatuses([
      ProjectBranchStatus.CLOSED, ProjectBranchStatus.IMPORTED, ProjectBranchStatus.IMPORTED,
    ]).coveragePercentage).toBe(33.3);
  });

  it('ignores a count that is not a number rather than producing NaN coverage', () => {
    expect(coverageFromCounts({ CLOSED: 2, SCHEDULED: 'not-a-number' }).coveragePercentage).toBe(100);
  });
});
