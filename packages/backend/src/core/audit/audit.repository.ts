import { AuditEvent, AuditEventPage } from './audit-event';

/**
 * What the audit domain needs from storage, stated without reference to how storage works.
 *
 * ## Why the port is this narrow
 *
 * `AuditService` previously injected `Repository<AuditEventEntity>`, which gave it `delete`,
 * `update`, `remove`, `clear` and `softDelete` — every one of which violates the rule the file
 * header states in capital letters ("This table must NEVER have UPDATE or DELETE operations").
 * The rule was enforced by nobody reaching for those methods.
 *
 * This port has no way to express them. Append-only stops being a convention and becomes a
 * property of the type: a call site that wants to mutate the trail cannot be written against
 * this interface at all, so the review that would have had to catch it never has to happen.
 *
 * Declared as an abstract class rather than an interface so it can be a Nest injection token
 * directly, without a separate string symbol.
 */
export abstract class AuditRepository {
  /** Add one entry. There is deliberately no counterpart that removes or changes one. */
  abstract append(event: AuditEvent): Promise<RecordedId>;

  abstract findForEntity(
    entityType: string,
    entityId: string,
    limit: number,
    offset: number,
  ): Promise<AuditEventPage>;

  abstract findForUser(userId: string, limit: number, offset: number): Promise<AuditEventPage>;

  abstract findRecent(limit: number, offset: number, category?: string): Promise<AuditEventPage>;

  /** Recent entries of a single event type, newest first — for type-specific desk views. */
  abstract findByEventType(eventType: string, limit: number): Promise<AuditEventPage>;
}

export interface RecordedId {
  id: string;
}
