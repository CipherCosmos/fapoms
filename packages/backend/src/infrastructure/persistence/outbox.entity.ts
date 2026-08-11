import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A domain event, written in the same transaction as the change it describes.
 *
 * ## The gap this closes
 *
 * `UnitOfWork` buffers events in memory and publishes them after COMMIT. That correctly stops
 * a subscriber from seeing state that can still roll back, but it leaves a window: if the
 * process dies between the COMMIT and the publish loop — a deploy, an OOM kill, a lost node —
 * the transaction is durable and the events describing it are gone. Nothing records that they
 * were owed, so nothing can replay them. A payable is created and the realtime clients never
 * learn of it, permanently.
 *
 * Writing the event inside the transaction makes the event and the change succeed or fail
 * together. The publish that follows becomes an optimisation — the fast path — and the relay
 * is the guarantee.
 *
 * ## Delivery is at-least-once, not exactly-once
 *
 * A row is marked dispatched *after* it is published, so a crash in between causes the relay
 * to publish it a second time. That is deliberate: the alternative ordering loses events
 * instead, and duplicates are the cheaper failure for the two subscribers that exist.
 * `BillingEngineService`'s assignment listener is already idempotent (its
 * "already billed / already exists" guards plus a Redis lock), and the realtime gateway's
 * worst case is a repeated broadcast. Any new subscriber has to tolerate redelivery.
 */
@Entity('outbox_events')
@Index(['dispatchedAt', 'occurredAt'])
export class OutboxEntity {
  /**
   * Assigned by the writer rather than the database, so the id is known before the INSERT and
   * the row can be marked dispatched after commit without reading back what was written.
   */
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'event_name', type: 'varchar', length: 200 })
  eventName: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  /** Null until the event has been handed to the publisher. The relay's work queue. */
  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /**
   * Why the last dispatch failed. Kept rather than only logged: a row that has been retried
   * for hours needs to say why on the row itself, or diagnosing it means correlating against
   * logs that may have rotated.
   */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;
}
