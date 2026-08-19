import { EventCategory } from '@fapoms/shared';

/** Postgres uuid form; anything else cannot be an actor id or an entity id. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `entityId` for an event that is not about one record.
 *
 * Some events have no row to point at: a platform setting changed, a notification rule was
 * switched off, a backfill swept a whole table, the database was wiped. `audit_events.entity_id`
 * is `uuid NOT NULL`, so those events still need a value the column accepts, and the nil UUID is
 * the standard sentinel for "no particular one". Read it as *deliberately not a record* — the
 * subject of such an event belongs in `entityType`, `remarks` and `metadata`.
 *
 * This exists because writing anything else there is a silent data loss. Three call sites had
 * independently reached for a natural-language identifier — a setting key, a notification type,
 * `null` — and every one of those writes had been failing since it was written: Postgres rejects
 * the value, and the caller had wrapped the write in `.catch(() => undefined)`, so no platform
 * setting change was ever audited and nobody knew. `data-reset.service.ts` had found the same
 * wall earlier (with the literal `'ALL'`) and defined a private constant for it; that one is now
 * this one, so the answer is in the audit module where the next caller will look for it.
 */
export const NOT_A_RECORD_ENTITY_ID = '00000000-0000-0000-0000-000000000000';

export interface RecordAuditEventInput {
  /**
   * Which lens the event belongs under, and therefore which filter chip surfaces it.
   *
   * The convention, previously unstated and unevenly applied:
   *   WORKFLOW    — a business entity moved between states. Anything that sets previousState
   *                 and newState on an operational entity belongs here. Half of these were
   *                 filed as OPERATIONAL, so the WORKFLOW filter showed an auditor only some
   *                 of the state changes that had occurred.
   *   OPERATIONAL — a business action that is not itself a state transition: something was
   *                 created, edited, removed, dispatched, priced.
   *   USER        — account and access changes. A user being suspended carries previousState
   *                 and newState too, but it is an access event, not a business workflow, and
   *                 stays under USER deliberately.
   *   SYSTEM      — automated housekeeping with no human actor.
   */
  category: EventCategory;
  eventType: string;
  entityType: string;
  /**
   * The record this event is about, as a uuid. For an event about no particular record —
   * a configuration change, a sweep, a system-wide action — pass `NOT_A_RECORD_ENTITY_ID`
   * and put the subject in `entityType`/`metadata`; anything else is normalised to it.
   */
  entityId: string;
  previousState?: string;
  newState?: string;
  userId?: string;
  userDisplayName?: string;
  ipAddress?: string;
  remarks?: string;
  metadata?: Record<string, unknown>;
}

/**
 * One entry in the business audit trail, before it has been written.
 *
 * ## Why this is a class and not the DTO it replaces
 *
 * The rules for what a well-formed trail entry looks like were previously inside
 * `AuditService.recordEvent`, interleaved with the TypeORM call that persisted it. That meant
 * the rules could only be exercised by standing up a repository, and anything that wrote to
 * `audit_events` by another route — a raw query, a second service, the outbox relay — would
 * not apply them.
 *
 * Constructing this is the only supported way to describe an audit event, so the normalisation
 * below happens once and cannot be bypassed by choosing a different persistence path.
 *
 * Instances are frozen because the trail is append-only (Part 6 §13). An entry that could be
 * mutated after construction but before the insert would be a trail entry that does not
 * describe what happened.
 */
export class AuditEvent {
  private constructor(
    readonly category: EventCategory,
    readonly eventType: string,
    readonly entityType: string,
    readonly entityId: string,
    readonly previousState: string | null,
    readonly newState: string | null,
    readonly userId: string | null,
    readonly userDisplayName: string | null,
    readonly ipAddress: string | null,
    readonly remarks: string | null,
    readonly metadata: Record<string, unknown> | null,
  ) {
    Object.freeze(this);
  }

  static record(input: RecordAuditEventInput): AuditEvent {
    const actor = input.userId ?? '';
    const actorIsUuid = UUID_PATTERN.test(actor);

    /**
     * `user_id` is a uuid column, so a non-uuid actor (the string 'system', an assayer code,
     * an empty string) makes the INSERT throw — and a throw means the trail entry is lost,
     * which is the one failure this system must not have. Null is the single representation
     * of "no human actor".
     *
     * The rejected value is carried into metadata rather than discarded. Previously it was
     * dropped outright: an event recorded against actor 'system' or an employee code came back
     * from the trail indistinguishable from one with no actor at all, and the information that
     * would have identified who acted was gone with no trace that anything had been removed.
     */
    const rejectedActor = !actorIsUuid && actor !== '' ? actor : null;

    /**
     * `entity_id` is a uuid column too, and the same mistake was being made against it —
     * but worse, because it was invisible. Callers with no record to name reached for the
     * thing the event was actually about: a setting key ('email.transport'), a notification
     * type ('SLA_BREACH'), `null`. Every such INSERT was rejected, and because those callers
     * swallowed the rejection, whole categories of configuration change went unaudited for
     * months with nothing anywhere to show for it.
     *
     * Rejecting the value here instead of at the database means the rest of the entry — who,
     * when, what changed — still gets written. The identifier the caller offered is preserved
     * under `unresolvedEntityId` on the same reasoning as `unresolvedActor`: a substituted
     * sentinel that silently discarded it would read back as an event about nothing.
     *
     * Callers that legitimately have no record should pass `NOT_A_RECORD_ENTITY_ID` outright
     * and say what the event concerns in `entityType`/`metadata`. This is the safety net for
     * the ones that do not, not a licence to skip that.
     */
    const subject = input.entityId ?? '';
    const subjectIsUuid = UUID_PATTERN.test(subject);
    const rejectedSubject = !subjectIsUuid && subject !== '' ? subject : null;

    const unresolved = {
      ...(rejectedActor !== null ? { unresolvedActor: rejectedActor } : {}),
      ...(rejectedSubject !== null ? { unresolvedEntityId: rejectedSubject } : {}),
    };

    // Copied, never aliased: the caller keeps a reference to the object it passed, and a
    // frozen instance holding a mutable object is only half append-only.
    const metadata =
      Object.keys(unresolved).length > 0
        ? { ...(input.metadata ?? {}), ...unresolved }
        : input.metadata
          ? { ...input.metadata }
          : null;

    return new AuditEvent(
      input.category,
      input.eventType,
      input.entityType,
      subjectIsUuid ? subject : NOT_A_RECORD_ENTITY_ID,
      input.previousState ?? null,
      input.newState ?? null,
      actorIsUuid ? actor : null,
      input.userDisplayName ?? null,
      input.ipAddress ?? null,
      input.remarks ?? null,
      metadata,
    );
  }
}

/**
 * A trail entry as read back, with the fields the database assigned.
 *
 * Structurally identical to the columns of `audit_events`, and deliberately so: the audit-log
 * controller returns these straight to the client as `data`, so this is the wire shape and
 * changing it is an API change.
 */
export interface RecordedAuditEvent {
  id: string;
  category: string;
  eventType: string;
  entityType: string;
  entityId: string;
  previousState: string | null;
  newState: string | null;
  userId: string | null;
  userDisplayName: string | null;
  ipAddress: string | null;
  remarks: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface AuditEventPage {
  events: RecordedAuditEvent[];
  total: number;
}
