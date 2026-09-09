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
