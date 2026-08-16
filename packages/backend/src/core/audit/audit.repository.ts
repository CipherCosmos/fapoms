import type { EntityManager } from 'typeorm';
import { AuditEvent, AuditEventPage } from './audit-event';

/**
 * An open transaction an audit write should join.
 *
 * Without it the write goes out on its own pooled connection. Inside a business transaction
 * that has two consequences the audit of 2026-08-16 found: the caller holds one connection and
 * blocks for a second, so twenty concurrent transitions exhaust a twenty-connection pool and
 * stall for the acquire timeout; and the audit row autocommits, so it survives a rollback of
 * the very change it describes. Passing the transaction's manager makes the row commit or roll
 * back with the change and takes no extra connection.
 *
 * Typed here rather than in `AuditService` so the service stays free of storage types; the
 * TypeORM implementation is the only reader.
 */
export interface AuditWriteScope {
  manager?: EntityManager;
}

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
  /**
   * Add one entry. There is deliberately no counterpart that removes or changes one.
   * With a scope, the entry joins that transaction — see AuditWriteScope.
   */
  abstract append(event: AuditEvent, scope?: AuditWriteScope): Promise<RecordedId>;

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
