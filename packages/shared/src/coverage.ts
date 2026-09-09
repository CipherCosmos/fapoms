import { ProjectBranchStatus } from './enums';
import { BRANCH_COVERED_STATUSES, BRANCH_DONE_STATUSES } from './labels';

/**
 * What "coverage" means for this business, computed once, for every surface that reports it.
 *
 * ## The definition, and where it comes from
 *
 * `docs/business-spec.md` §2 glossary: *"Coverage — the share of a Project's branches
 * successfully assigned to an assessor and audited, versus those that couldn't be."* Phase 4 of
 * the same document says the report "compiles covered branches (assessor + date) and uncovered
 * branches". So a branch is COVERED from the moment an assayer is secured for it, and it stays
 * covered through the audit and afterwards — coverage is not a measure of progress, it is the
 * answer to "did we manage to get this branch done, or did it fall off the plan?".
 *
 * That set already had a name: `BRANCH_COVERED_STATUSES` in `labels.ts`, whose own comment says
 * it exists "so that the planning header, the Excel export and any per-branch done checks all
 * agree". This file is the arithmetic half of the same promise, because agreeing on the set was
 * not enough — three places went on to do the sums differently.
 *
 *     coverage % = |branches whose status ∈ BRANCH_COVERED_STATUSES| / |active branches| × 100
 *
 * to one decimal place, and 0 for a project with no active branches (rather than NaN).
 *
 * ## What went wrong without it
 *
 * Three surfaces answered "what is this project's coverage?" and two of them disagreed, live, on
 * the same project on the same day:
 *
 *  - `GET /planning/projects/:id/coverage` counted `SCHEDULED + CLOSED + VALIDATION_COMPLETED +
 *    ASSIGNMENT_CONFIRMED`. It had no COMPLETED bucket at all, so `AUDIT_COMPLETED` — the status
 *    a branch holds between the audit being done and validation finishing — fell through to
 *    `remaining`. Delivered audits were reported as work not yet started. Measured on the
 *    certification project: 22 branches, 8 of them AUDIT_COMPLETED, reported 9.1%.
 *  - `GET /reports/coverage/:id`, the client-facing workbook, had already been fixed to read
 *    `BRANCH_DONE_STATUSES`, and reported 45.5% on those same 22 rows. The fix landed in one
 *    copy of the definition and not the other, which is the whole disease.
 *  - The planning workspace header computed a third copy in the browser. It happened to agree
 *    with the export — but only by accident of having been written later.
 *
 * The planning endpoint had a second defect that only a shared definition can prevent: `CLOSED`
 * and `VALIDATION_COMPLETED` were added into the bucket *labelled* `scheduled`, so finished work
 * was reported to planners as future work they still had to staff. A bucket name is part of the
 * definition; a number under the wrong name is still wrong.
 *
 * ## The buckets
 *
 * Four, and they partition every branch. The three covered ones sum to exactly
 * `BRANCH_COVERED_STATUSES`, which `coverage.spec.ts` asserts — so a status added to that set
 * without being given a bucket here fails the build rather than silently landing in REMAINING,
 * which is exactly how `AUDIT_COMPLETED` went missing the first time.
 */
export type CoverageBucket = 'COMPLETED' | 'SCHEDULED' | 'CONFIRMED' | 'REMAINING';

/** The shape every coverage surface returns. `covered === completed + scheduled + confirmed`. */
export interface CoverageBreakdown {
  /** Active branches in the project — the denominator. */
  total: number;
  /** Audited and beyond: `BRANCH_DONE_STATUSES`. */
  completed: number;
  /** An assayer and a date are fixed, the visit has not happened yet. */
  scheduled: number;
  /** An assayer is secured; the date is not fixed yet. */
  confirmed: number;
  /** Everything else — still to be covered, or that could not be. */
  remaining: number;
  /** `completed + scheduled + confirmed`; the numerator of the percentage. */
  covered: number;
  /** `covered / total × 100`, to one decimal place. 0 when there are no branches. */
  coveragePercentage: number;
}

/**
 * Which bucket one branch status falls in.
 *
 * Derived from the shared sets rather than listing statuses again: `BRANCH_DONE_STATUSES` is the
 * COMPLETED bucket by definition, and the two staffing statuses are named individually because
 * they are individually meaningful to a planner. Anything not named is REMAINING — including
 * `UNABLE_TO_COVER` and `CANCELLED`, which are branches we could not cover and belong in the
 * denominator, counted against us.
 */
export function coverageBucketOf(status?: string | null): CoverageBucket {
  if (BRANCH_DONE_STATUSES.includes(status as ProjectBranchStatus)) return 'COMPLETED';
  if (status === ProjectBranchStatus.SCHEDULED) return 'SCHEDULED';
  if (status === ProjectBranchStatus.ASSIGNMENT_CONFIRMED) return 'CONFIRMED';
  return 'REMAINING';
}

/** Is this branch covered? The single per-branch question, same set as the percentage above. */
export function isBranchCovered(status?: string | null): boolean {
  return BRANCH_COVERED_STATUSES.includes(status as ProjectBranchStatus);
}

/**
 * Coverage from a status → count map, for callers that aggregated in the database.
 *
 * `Map`, plain object and `[status, count]` pairs are all accepted, because the two backend
 * callers arrive with different shapes and neither should have to reshape its data to ask this
 * question. Counts are read through `Number()`: a Postgres `COUNT(*)` comes back as a string.
 */
export function coverageFromCounts(
  countsByStatus: Map<string, number | string> | Iterable<readonly [string, number | string]> | Record<string, number | string>,
): CoverageBreakdown {
  const entries: Iterable<readonly [string, number | string]> =
    countsByStatus instanceof Map
      ? countsByStatus.entries()
      : Symbol.iterator in Object(countsByStatus)
        ? (countsByStatus as Iterable<readonly [string, number | string]>)
        : Object.entries(countsByStatus as Record<string, number | string>);

  const bucket: Record<CoverageBucket, number> = { COMPLETED: 0, SCHEDULED: 0, CONFIRMED: 0, REMAINING: 0 };
  for (const [status, rawCount] of entries) {
    const count = Number(rawCount);
    if (!Number.isFinite(count)) continue;
    bucket[coverageBucketOf(status)] += count;
  }
  return finalise(bucket);
}

/** Coverage from a list of branch statuses, for callers holding the rows themselves. */
export function coverageFromStatuses(statuses: Iterable<string | null | undefined>): CoverageBreakdown {
  const bucket: Record<CoverageBucket, number> = { COMPLETED: 0, SCHEDULED: 0, CONFIRMED: 0, REMAINING: 0 };
  for (const status of statuses) bucket[coverageBucketOf(status)] += 1;
  return finalise(bucket);
}

function finalise(bucket: Record<CoverageBucket, number>): CoverageBreakdown {
  const covered = bucket.COMPLETED + bucket.SCHEDULED + bucket.CONFIRMED;
  const total = covered + bucket.REMAINING;
  return {
    total,
    completed: bucket.COMPLETED,
    scheduled: bucket.SCHEDULED,
    confirmed: bucket.CONFIRMED,
    remaining: bucket.REMAINING,
    covered,
    // `toFixed(1)` then back to a number, so 45.454545… prints as 45.5 and not as a float that
    // renders differently in the workbook than on the screen.
    coveragePercentage: total > 0 ? parseFloat(((covered / total) * 100).toFixed(1)) : 0,
  };
}
