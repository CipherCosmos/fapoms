import { businessDateKey } from '@fapoms/shared';

/**
 * Dedupe keys for notifications about an assignment — one rule, so every emit agrees on what "the
 * same event" means.
 *
 * The notification store refuses a second row with the same `dedupe_key` for the same recipient,
 * forever. That is what makes a retried emit harmless — and it is also what silenced real events,
 * because an assignment id is reused: a declined offer is reassigned, a cancelled-then-recreated
 * branch reuses its row, a job is escalated, de-prioritised by a re-offer and escalated again. A key
 * made of the type and the assignment id alone (`ASSIGNMENT_OFFERED:<id>`) delivered the FIRST
 * offer on that row and suppressed every later one — the second assayer offered the job was never
 * told, nor was the desk about the second decline.
 *
 * The discriminator chosen is the assignment's `entity_version` as committed by the write that
 * caused the event:
 *
 *  - every state-changing write bumps it (it is the optimistic-concurrency version), so two
 *    genuinely different occurrences on one row can never share it;
 *  - a true retry of the SAME event — the emit re-run, a job re-delivered, a sweep that crashed
 *    after flipping the row — re-reads the same committed row and so carries the same version,
 *    and is still absorbed;
 *  - it needs no new column and no clock: a timestamp would make every retry look new, and a
 *    per-type counter would need its own storage and its own race.
 *
 * Kept byte-compatible with the `<TYPE>:<id>:<version>` shape reassignment, reopen and the note
 * change already used, so those keys are unchanged.
 */
export function assignmentOccurrenceKey(
  type: string,
  assignment: { id: string; entityVersion?: number | string | null },
): string {
  return `${type}:${assignment.id}:${Number(assignment.entityVersion ?? 1) || 1}`;
}

/**
 * The check-in is the exception, because it is RETRIED as a new write: a flaky connection or a GPS
 * refresh re-issues it, each retry bumps the version, and all of them are one arrival that the
 * desk must hear about once. So the occurrence is "this assayer, arriving on this business day":
 * retries the same day collapse, while a different assayer on a reused row — or the same job
 * attended on another day after it was reopened — is a new arrival and is delivered.
 */
export function checkInOccurrenceKey(assignment: {
  id: string;
  assayerId?: string | null;
  checkedInAt?: Date | string | null;
}): string {
  const day = assignment.checkedInAt ? businessDateKey(assignment.checkedInAt) : 'unknown-day';
  return `ASSIGNMENT_CHECKED_IN:${assignment.id}:${assignment.assayerId ?? 'no-assayer'}:${day}`;
}
