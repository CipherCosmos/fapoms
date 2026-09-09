import { ConflictException } from '@nestjs/common';

/**
 * Turn a Postgres unique violation into the message for the constraint that actually fired.
 *
 * `create()` used to catch SQLSTATE 23505 and answer "Branch Busy: Another active assignment
 * already exists for this branch" for every one of them — the constraint name was checked with
 * `||`, so the name never had to match. A duplicate assignment number said Branch Busy. A
 * same-day double booking said Branch Busy. A replayed idempotency key said Branch Busy. Three
 * different problems, three different fixes, one message that only described the first.
 *
 * Every mapping here is keyed on the index name Postgres puts in the error, so a message can
 * only ever describe the rule that was broken. An unrecognised 23505 is deliberately *not*
 * mapped: it is re-thrown so it surfaces as itself rather than being dressed up as a rule this
 * module happens to know about. A wrong explanation is worse than an unhandled error, because
 * the person reading it stops looking.
 */

/** The constraint names this module knows how to explain. */
export const ASSIGNMENT_CONSTRAINT_MESSAGES: Record<string, string> = {
  idx_assignments_single_active_branch:
    'Branch Busy: another in-flight assignment already exists for this branch.',
  idx_assignments_single_active_assayer_day:
    'Assayer double booking: this assayer already holds an in-flight assignment on that date.',
  UQ_7c08693fc11883cd6b712a1fed2:
    'Assignment number collision: two assignments were numbered at once. Retry.',
  assignment_idempotency_records_pkey:
    'This request has already been processed under the same idempotency key.',
};

/** Pull the constraint or index name out of whatever shape the driver handed back. */
export function constraintNameOf(err: any): string | null {
  const direct = err?.constraint ?? err?.driverError?.constraint;
  if (direct) return String(direct);
  const text = String(err?.detail ?? err?.message ?? '');
  for (const name of Object.keys(ASSIGNMENT_CONSTRAINT_MESSAGES)) {
    if (text.includes(name)) return name;
  }
  return null;
}

export function isUniqueViolation(err: any): boolean {
  return err?.code === '23505' || err?.driverError?.code === '23505';
}

/**
 * Rethrow a unique violation as the conflict it actually is, or as itself.
 *
 * Callers use this as the last arm of their catch: everything that is not a recognised
 * assignment constraint keeps its own identity all the way out.
 */
export function throwMappedUniqueViolation(err: any): never {
  if (!isUniqueViolation(err)) throw err;
  const name = constraintNameOf(err);
  const message = name ? ASSIGNMENT_CONSTRAINT_MESSAGES[name] : undefined;
  if (!message) throw err;
  throw new ConflictException(message);
}

/**
 * Postgres SQLSTATEs that mean "the database refused this transaction; try again".
 *
 * 40P01 is a deadlock the server broke by aborting one party. 40001 is a serialization failure.
 * Neither is a fault in the request and neither leaves anything behind — the transaction rolled
 * back whole. What they are is *retryable*, and the caller has to be able to tell that apart from
 * a server that is broken.
 *
 * Ten concurrent reassignments of one assignment produced three HTTP 500 "Internal server error"
 * responses in certification: two reading "current transaction is aborted, commands ignored" and
 * one "deadlock detected". No data was corrupted — the ownership chain stayed coherent and
 * exactly one interval was open — but a client cannot retry a 500 with any confidence, and an
 * operator reading the log sees an application fault where there was a contention event.
 */
export const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);

export function isRetryableTransactionError(err: any): boolean {
  const code = err?.code ?? err?.driverError?.code;
  if (code && RETRYABLE_SQLSTATES.has(String(code))) return true;
  // A transaction aborted by an earlier failed statement reports 25P02 on every subsequent
  // statement. The original cause is already lost by then, but the outcome is the same: nothing
  // committed, and retrying is the right move.
  if (String(code) === '25P02') return true;
  const text = String(err?.message ?? '');
  return /deadlock detected|current transaction is aborted/i.test(text);
}

/**
 * Raise a contention failure as the conflict it is.
 *
 * Deliberately 409 rather than 503: the request was well-formed and the service is healthy — it
 * lost a race for a row. `RETRY_CONTENTION` is a stable prefix so a client can match on it.
 */
export function throwIfRetryable(err: any): void {
  if (!isRetryableTransactionError(err)) return;
  throw new ConflictException(
    'RETRY_CONTENTION: this assignment was being modified concurrently and the transaction was '
    + 'rolled back. Nothing was changed. Retry the request.',
  );
}
