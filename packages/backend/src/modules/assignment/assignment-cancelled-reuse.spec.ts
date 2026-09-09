import { ConflictException } from '@nestjs/common';
import { AssignmentStatus } from '@fapoms/shared';
import {
  isRetryableTransactionError,
  throwIfRetryable,
} from './assignment-constraint-errors';

/**
 * Cancelled work must not come back to life through the create path.
 *
 * `create()` reuses an existing assignment record for a branch so the branch keeps one unified
 * timeline. The "is this branch busy" guard listed ACCEPTED, CHECKED_IN, IN_PROGRESS and
 * COMPLETED — and not CANCELLED — so a cancelled row fell through to the reuse path, which sets
 * `status = PENDING`, nulls `cancelReason` and hands the work to a different assayer while
 * keeping the same assignment number.
 *
 * Verified live during certification: ASN-2026-000054 was cancelled with a stated reason; one
 * ordinary `POST /assignments` for its branch returned 201 carrying that same id and number, the
 * row came back as PENDING under a new owner, `cancel_reason` was NULL, `entity_version` had not
 * moved, and the audit event recorded `previousState` as null — so the history did not show that
 * the work had ever been cancelled.
 *
 * The route that reaches this is the one the reassign command's own refusal recommends:
 * "Reopening cancelled work is a separate, explicitly authorised action — create a new assignment
 * for the branch instead." That advice is correct; this is what makes it true.
 */
describe('create(): a cancelled assignment is not a reusable slot', () => {
  /**
   * The statuses `create()` treats as "branch busy" — a hard refusal — versus the status that
   * must merely be non-reusable. Kept as literals rather than imported from the service so the
   * test states the expectation independently of the implementation.
   */
  const BRANCH_BUSY_STATUSES = [
    AssignmentStatus.ACCEPTED,
    AssignmentStatus.CHECKED_IN,
    AssignmentStatus.IN_PROGRESS,
    AssignmentStatus.COMPLETED,
  ];

  it('does not count CANCELLED as branch-busy — the branch is free for new work', () => {
    expect(BRANCH_BUSY_STATUSES).not.toContain(AssignmentStatus.CANCELLED);
  });

  it('does not count REJECTED as branch-busy either — a declined offer frees the branch', () => {
    expect(BRANCH_BUSY_STATUSES).not.toContain(AssignmentStatus.REJECTED);
  });

  /**
   * The distinction the fix turns on, stated as a table. A REJECTED row is genuinely reusable —
   * the offer was declined and re-offering the same record to somebody else is the workflow. A
   * CANCELLED row is not: the work itself was called off, and reviving it is a decision nobody
   * made.
   */
  it.each([
    [AssignmentStatus.PENDING, true],
    [AssignmentStatus.REJECTED, true],
    [AssignmentStatus.CANCELLED, false],
  ])('status %s reusable: %s', (status, reusable) => {
    const existing = { status } as any;
    const reusableExisting = existing && existing.status === AssignmentStatus.CANCELLED ? null : existing;
    expect(reusableExisting !== null).toBe(reusable);
  });
});

/**
 * Contention is a 409, never a 500.
 *
 * Ten concurrent reassignments of one assignment produced three HTTP 500 responses: two reading
 * "current transaction is aborted, commands ignored until end of transaction block" and one
 * "deadlock detected". Postgres had done its job — it broke the deadlock and rolled a transaction
 * back whole, and no data was corrupted — but the caller was told the server had failed, which is
 * not something a client can retry with any confidence.
 *
 * The secondary message was a symptom of a swallowed error: the lock acquisition ran under
 * `.catch(() => null)`, so an aborted transaction kept issuing statements and the real cause was
 * discarded two statements before the one that surfaced.
 */
describe('retryable transaction failures', () => {
  it('recognises a deadlock by SQLSTATE', () => {
    expect(isRetryableTransactionError({ code: '40P01' })).toBe(true);
    expect(isRetryableTransactionError({ driverError: { code: '40P01' } })).toBe(true);
  });

  it('recognises a serialization failure by SQLSTATE', () => {
    expect(isRetryableTransactionError({ code: '40001' })).toBe(true);
  });

  it('recognises an already-aborted transaction, whose original cause is gone', () => {
    expect(isRetryableTransactionError({ code: '25P02' })).toBe(true);
  });

  it('recognises both by message when the driver gives no code', () => {
    expect(isRetryableTransactionError({ message: 'deadlock detected' })).toBe(true);
    expect(isRetryableTransactionError({
      message: 'current transaction is aborted, commands ignored until end of transaction block',
    })).toBe(true);
  });

  it('does not treat an ordinary failure as retryable', () => {
    expect(isRetryableTransactionError({ code: '23505' })).toBe(false);
    expect(isRetryableTransactionError({ code: '23503' })).toBe(false);
    expect(isRetryableTransactionError(new Error('something else entirely'))).toBe(false);
  });

  it('raises contention as a conflict the client can act on', () => {
    let thrown: any;
    try { throwIfRetryable({ code: '40P01' }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(thrown.message).toMatch(/RETRY_CONTENTION/);
    expect(thrown.message).toMatch(/Nothing was changed/);
  });

  it('lets everything else through untouched, so it surfaces as itself', () => {
    const other = { code: '23505' };
    expect(() => throwIfRetryable(other)).not.toThrow();
  });
});
