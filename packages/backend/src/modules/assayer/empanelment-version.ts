import { BadRequestException, ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { EmpanelmentStatus } from '@fapoms/shared';

/**
 * Optimistic concurrency for the row that decides whether a bank will accept somebody's work.
 *
 * The same defect `pricing-version.ts` describes for `client_billing`, on the table next door and
 * with a worse consequence. Three concurrent `PUT /assayers/:id/empanelment/:clientId` carrying
 * three DIFFERENT standings all answered **200**; the row kept one of them and the other two
 * decisions were acknowledged to their authors and discarded. `version` was on the row the whole
 * time — `AssayerClientEmpanelmentEntity` extends `BaseEntity` — incrementing on every write and
 * read by nobody.
 *
 * What makes this the more dangerous of the two: empanelment standing GATES ASSIGNMENT
 * ELIGIBILITY (`assignment-target-eligibility.policy.ts`, `recommendation.engine.ts`). A desk's
 * REJECTED overwritten by a concurrent RECOMMENDED does not misprice an invoice — it makes
 * somebody deployable to a client who declined them, and the audit row says a legitimate decision
 * was taken.
 *
 * **This is not a second mechanism.** It is `pricing-version.ts`'s mechanism, applied to this
 * table: the same lock-then-read discipline, the same `expectedVersion` wire contract, the same
 * 409-in-both-directions shape that `assignment.service.ts` already speaks, so a client handles
 * one shape of staleness rather than three. The two files want merging into one generic
 * versioned-row helper once a single owner holds both; keeping them apart today is a lane
 * boundary, not a design.
 *
 * Two rules, both taken from that docblock because both are easy to get wrong:
 *
 *  1. **Lock before you read.** The `FOR UPDATE` runs *first*, so a concurrent writer either has
 *     not started (it blocks here) or has already committed (its version is what we read).
 *     Reading the entity first and locking afterwards leaves a window in which the in-memory copy
 *     is already stale, and TypeORM then writes `stale + 1` straight over the winner.
 *  2. **A row that exists must be told which version is being edited.** An absent
 *     `expectedVersion` is refused rather than treated as "whatever is there now". Creating the
 *     first standing needs no version: there is no earlier decision to be stale about.
 *
 * One thing differs from the pricing helper, and it is deliberate. The lock predicate carries
 * **no `is_active` filter**. `removeEmpanelment` withdraws a standing by clearing `is_active`
 * while `UQ_assayer_client_empanelment` still holds the pair, and `setEmpanelment` reads with the
 * same unfiltered predicate and reinstates that very row. A lock that filtered `is_active` would
 * miss a withdrawn row, send the writer down the create path, and turn an ordinary reinstatement
 * into a unique violation.
 *
 * ## The status is read under the lock too, and that is a fix in its own right
 *
 * The reversal guard — moving away from REJECTED demands a written reason — used to be decided
 * from an unlocked read. Between that read and the write, a concurrent call could set the row to
 * REJECTED, and the guard would let a reason-less reversal straight over the top of it. The
 * committed status now comes back from the same `FOR UPDATE` that the version does, so the guard
 * is answered against the row as it actually stands.
 */

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

/** The committed state of one standing, as it stands under the lock. */
export interface LockedEmpanelment {
  id: string;
  version: number;
  /** The standing that is actually committed — what the reversal guard must be answered against. */
  status: EmpanelmentStatus;
  /** False once the standing has been withdrawn; the row is still the one to edit. */
  isActive: boolean;
}

/**
 * Lock this assayer/client standing and return its committed id, version and status.
 *
 * Returns `null` when the pair has no row yet — the create half of the upsert. Must be called
 * inside a transaction: a `FOR UPDATE` outside one is released immediately and guards nothing.
 */
export async function lockEmpanelmentRow(
  m: EntityManager,
  assayerId: string,
  clientId: string,
): Promise<LockedEmpanelment | null> {
  const rows: Array<{ id: string; version: number; status: EmpanelmentStatus; is_active: boolean }> =
    await m.query(
      `SELECT id, version, status, is_active
         FROM assayer_client_empanelments
        WHERE assayer_id = $1 AND client_id = $2
        FOR UPDATE`,
      [assayerId, clientId],
    );
  const row = rows?.[0];
  return row
    ? { id: row.id, version: Number(row.version), status: row.status, isActive: row.is_active }
    : null;
}

/**
 * Refuse a decision that was taken against a version other than the one now committed.
 *
 * Call it only after `lockEmpanelmentRow`, and only inside that lock's transaction: the point is
 * that between this check and the write, nobody else can commit.
 */
export function assertEmpanelmentVersion(
  locked: LockedEmpanelment,
  expectedVersion: number | undefined | null,
): void {
  if (expectedVersion === undefined || expectedVersion === null) {
    throw new BadRequestException(
      'MISSING_EXPECTED_VERSION: changing a client standing requires expectedVersion — the version '
      + `you loaded. It is currently ${locked.version}. Without it a concurrent decision cannot be `
      + 'detected, and one of the two standings would be discarded silently while both authors were '
      + 'told theirs had saved.',
    );
  }

  if (!Number.isInteger(expectedVersion)) {
    throw new BadRequestException(
      `INVALID_EMPANELMENT_VERSION: expectedVersion must be a whole number; received ${expectedVersion}.`,
    );
  }

  if (expectedVersion === locked.version) return;

  if (expectedVersion < locked.version) {
    throw new ConflictException(
      `STALE_EMPANELMENT_VERSION: this client standing has been updated to version ${locked.version} `
      + `(you decided against version ${expectedVersion}, when it read ${locked.status}). Your change `
      + 'was NOT saved. Reload and reapply it.',
    );
  }

  throw new ConflictException(
    `INVALID_EMPANELMENT_VERSION: Future or non-existent version ${expectedVersion} specified `
    + `(current server version is ${locked.version}). Concurrency check rejected.`,
  );
}

/**
 * The other half of the race: two callers recording the *first* standing for a pair at once.
 *
 * There is no row to lock, so both get past `lockEmpanelmentRow`, and
 * `UQ_assayer_client_empanelment` permits one — so one INSERT commits and the other raises 23505.
 * Left alone that surfaced as a redacted **500**, which is the same lie in a different costume:
 * the caller cannot tell whether its decision was discarded, and a 500 invites the retry that
 * would overwrite the winner. Translated here into the conflict it actually is.
 */
export function translateConcurrentEmpanelmentCreate(err: unknown): never {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code
    ?? (err as { driverError?: { code?: string } })?.driverError?.code;
  if (code === UNIQUE_VIOLATION) {
    throw new ConflictException(
      'STALE_EMPANELMENT_VERSION: this client standing was recorded by someone else while you were '
      + 'filling this in. Your change was NOT saved. Reload it and reapply your decision on top of '
      + 'theirs.',
    );
  }
  throw err;
}
