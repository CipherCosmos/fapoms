import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Optimistic concurrency for the two client rows that decide what money is charged.
 *
 * Both `client_billing` and `client_configurations` extend `BaseEntity`, so both have carried a
 * `version` column and bumped it on every write since the schema was written. Nothing ever read
 * it. Three concurrent `PUT /clients/:id/billing` setting three different GST rates all answered
 * **200** and the row kept one of them: the version went 1 → 4 across the three calls, so the
 * collision was recorded in the row and nobody looked. The other two pricing decisions were
 * acknowledged to their authors and discarded.
 *
 * This is not a second mechanism. It is the column that was already there, finally consulted.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 *  1. **Lock before you read.** The `FOR UPDATE` runs *first*, so a concurrent writer either has
 *     not started (it will block here) or has already committed (its version is what we read).
 *     Reading the entity first and locking afterwards leaves a window in which the in-memory copy
 *     is already stale, and TypeORM would then write `stale + 1` straight over the winner.
 *  2. **A row that exists must be told which version is being edited.** An absent
 *     `expectedVersion` is refused rather than treated as "whatever is there now" — a caller that
 *     does not say what it read cannot be checked, and an unchecked write is the defect. Creating
 *     the row for the first time needs no version: there is no earlier decision to be stale about.
 *
 * The wire contract deliberately matches the one `assignment.service.ts` already speaks —
 * `expectedVersion` in the body, a 409 whose message begins with a machine token, in both
 * directions — so a client handles one shape of staleness, not two. The token rides the message
 * because the shared `error-codes.ts` vocabulary is a coarse one (a 409 is `CONFLICT`); that is
 * the same choice `STALE_ASSIGNMENT_VERSION` made.
 */

/** A row whose lost update would silently change what a client is charged. */
export type VersionedPricingTable = 'client_billing' | 'client_configurations';

interface Subject {
  /** Machine token prefix, e.g. `CLIENT_BILLING` → `STALE_CLIENT_BILLING_VERSION`. */
  token: string;
  /** What a person calls it, for the sentence after the token. */
  noun: string;
}

const SUBJECTS: Record<VersionedPricingTable, Subject> = {
  client_billing: { token: 'CLIENT_BILLING', noun: "this client's billing profile" },
  client_configurations: { token: 'CLIENT_CONFIGURATION', noun: "this client's configuration" },
};

export interface LockedPricingRow {
  id: string;
  version: number;
}

/**
 * Lock the live pricing row for this client and return its id and committed version.
 *
 * Returns `null` when there is no row yet — the create half of an upsert. `is_active` is part of
 * the predicate for `client_configurations` because a soft-deleted configuration is not the one
 * in force (`loadForWrite` joins with the same filter); `client_billing` is unique per client and
 * its reader filters on `is_active` too.
 */
export async function lockPricingRow(
  m: EntityManager,
  table: VersionedPricingTable,
  clientId: string,
): Promise<LockedPricingRow | null> {
  // `table` is a closed union, never caller input — there is nothing here to interpolate unsafely.
  const rows: Array<{ id: string; version: number }> = await m.query(
    `SELECT id, version FROM ${table} WHERE client_id = $1 AND is_active = true FOR UPDATE`,
    [clientId],
  );
  const row = rows?.[0];
  return row ? { id: row.id, version: Number(row.version) } : null;
}

/**
 * Refuse a write that was decided against a version other than the one now committed.
 *
 * Call it only after `lockPricingRow`, and only inside that lock's transaction: the whole point
 * is that between this check and the write, nobody else can commit.
 */
export function assertPricingVersion(
  table: VersionedPricingTable,
  locked: LockedPricingRow,
  expectedVersion: number | undefined,
): void {
  const { token, noun } = SUBJECTS[table];

  if (expectedVersion === undefined || expectedVersion === null) {
    throw new BadRequestException(
      `MISSING_EXPECTED_VERSION: editing ${noun} requires expectedVersion — the version you loaded. ` +
        `It is currently ${locked.version}. Without it a concurrent edit cannot be detected and one ` +
        `of the two pricing decisions would be discarded silently.`,
    );
  }

  if (!Number.isInteger(expectedVersion)) {
    throw new BadRequestException(
      `INVALID_${token}_VERSION: expectedVersion must be a whole number; received ${expectedVersion}.`,
    );
  }

  if (expectedVersion === locked.version) return;

  if (expectedVersion < locked.version) {
    throw new ConflictException(
      `STALE_${token}_VERSION: ${noun} has been updated to version ${locked.version} ` +
        `(you edited version ${expectedVersion}). Your change was NOT saved. Reload and reapply it.`,
    );
  }

  throw new ConflictException(
    `INVALID_${token}_VERSION: Future or non-existent version ${expectedVersion} specified ` +
      `(current server version is ${locked.version}). Concurrency check rejected.`,
  );
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * The other half of the race: two callers creating the *first* billing profile at once.
 *
 * There is no row to lock, so both get past `lockPricingRow`, and `client_billing.client_id` is
 * unique — one INSERT commits and the other raises 23505. Left alone that surfaces as a redacted
 * 500, which is the same lie in a different costume: the caller cannot tell that its pricing
 * decision was discarded. Translated here into the conflict it actually is.
 */
export function translateConcurrentCreate(err: unknown, table: VersionedPricingTable): never {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code
    ?? (err as { driverError?: { code?: string } })?.driverError?.code;
  if (code === UNIQUE_VIOLATION) {
    const { token, noun } = SUBJECTS[table];
    throw new ConflictException(
      `STALE_${token}_VERSION: ${noun} was created by someone else while you were filling this in. ` +
        `Your change was NOT saved. Reload and reapply it.`,
    );
  }
  throw err;
}
