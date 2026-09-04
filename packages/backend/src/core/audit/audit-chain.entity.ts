import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/**
 * The tamper-evidence ledger for `audit_events` — one row per sealed event, in a hash chain.
 *
 * Kept as its OWN append-only table rather than as columns on `audit_events` for one deliberate
 * reason: sealing writes the chain, and if the chain lived on the event row, sealing would be an
 * UPDATE — which the `audit_events` immutability trigger rightly forbids, and which would mean
 * relaxing that trigger to allow "just the hash columns, just once". Instead the sealer only ever
 * INSERTs here, so `audit_events` stays absolutely immutable and the chain is a separate ledger that
 * references it. `seq` is the chain's own monotonic order (the order events were sealed in); the
 * hash binds each event's content to its predecessor.
 *
 * This table is itself append-only (see the migration's trigger): a chain you could edit proves
 * nothing.
 */
@Entity('audit_chain')
@Index('IDX_audit_chain_event', ['auditEventId'], { unique: true })
export class AuditChainEntity {
  /** Monotonic chain position — the order events were sealed into the chain. */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  seq: string;

  @Column({ name: 'audit_event_id', type: 'uuid', comment: 'The audit_events row this seals.' })
  auditEventId: string;

  @Column({
    name: 'prev_hash',
    type: 'char',
    length: 64,
    comment: 'row_hash of the previous chain entry (genesis for the first).',
  })
  prevHash: string;

  @Column({
    name: 'row_hash',
    type: 'char',
    length: 64,
    comment: 'SHA-256 of prev_hash + this event’s canonical content.',
  })
  rowHash: string;

  @CreateDateColumn({ name: 'sealed_at', type: 'timestamptz' })
  sealedAt: Date;
}
