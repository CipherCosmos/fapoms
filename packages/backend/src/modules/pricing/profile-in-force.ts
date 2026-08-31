/**
 * One definition of "the commercial profile in force", for every reader.
 *
 * There were four, and they disagreed:
 *   - `FeePolicyService.resolveBaseFee` checked both bounds — the correct one.
 *   - `BillingEngineService.moneyContextFor` checked only the END date, so a rate card dated
 *     for next quarter already governed today's travel reimbursement.
 *   - `CommandCenterService`'s LATERAL join had no date filter at all — the cost shown on the
 *     command centre was simply the newest-STARTING row, future ones included.
 *   - The legacy importer's preload ordered ASC with no filter, so the oldest row won.
 *
 * The consequence is the kind that never announces itself: the fee on the planning card, the
 * fee the calculator books, and the amount the payout pays could be three different numbers
 * for the same audit, and nothing on any screen said which row had been used.
 *
 * A profile is in force at an instant when it is active, has started, and has not ended.
 * Where two would qualify, the one that started most recently wins — and the EXCLUDE
 * constraint added alongside this file makes that case impossible to create going forward.
 */

/** The SQL predicate, for the raw queries. `$n` placeholders are supplied by the caller. */
export const PROFILE_IN_FORCE_SQL = (assayerParam: string, atParam: string): string => `
  is_active = true
  AND effective_start_date <= ${atParam}
  AND (effective_end_date IS NULL OR effective_end_date >= ${atParam})
  AND assayer_id = ${assayerParam}
`;

/**
 * The ORDER BY that resolves a tie, for readers that select one row. Latest start wins: it is
 * the most recently agreed rate, and it is the row a human would point at.
 */
export const PROFILE_IN_FORCE_ORDER = 'effective_start_date DESC';

/**
 * The same rule as a TypeORM query-builder fragment, for the entity readers.
 *
 * Usage:
 *   repo.createQueryBuilder('p')
 *     .where('p.assayerId = :assayerId', { assayerId })
 *     .andWhere(PROFILE_IN_FORCE_QB, { at })
 *     .orderBy('p.effectiveStartDate', 'DESC')
 *     .getOne();
 */
export const PROFILE_IN_FORCE_QB =
  'p.isActive = true AND p.effectiveStartDate <= :at AND (p.effectiveEndDate IS NULL OR p.effectiveEndDate >= :at)';
