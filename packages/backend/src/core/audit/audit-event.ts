import { EventCategory } from '@fapoms/shared';

/** Postgres uuid form; anything else cannot be an actor id. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    // Copied, never aliased: the caller keeps a reference to the object it passed, and a
    // frozen instance holding a mutable object is only half append-only.
    const metadata =
      rejectedActor !== null
        ? { ...(input.metadata ?? {}), unresolvedActor: rejectedActor }
        : input.metadata
          ? { ...input.metadata }
          : null;

    return new AuditEvent(
      input.category,
      input.eventType,
      input.entityType,
      input.entityId,
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
