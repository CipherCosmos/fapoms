/**
 * FAPOMS — Destructive Action Request
 *
 * One row per request under the two-person rule: a DEVELOPER asks for a wipe, an ADMIN decides,
 * the requesting developer executes. The row is the whole ledger of that handshake — who asked,
 * what exactly they asked for (frozen), who decided, and when it was consumed.
 *
 * Two deliberate departures from the house entity shape, both load-bearing:
 *
 *  - `requested_by` / `decided_by` are plain uuids with NO foreign key to `users`. Any enforced
 *    FK would make the `users` domain unwipeable: a RESTRICT edge becomes a hard conflict in
 *    `DataResetService.execute()`, and a CASCADE/SET NULL edge pulls this table into the FK-graph
 *    closure — where `NEVER_WIPEABLE_TABLES` (which now lists this table) rightly refuses the
 *    selection. The approval trail must survive the wipe it approved, so names are joined
 *    LEFT at read time and may come back null for accounts that no longer exist.
 *
 *  - The service reads and writes this table with raw SQL on the root `DataSource`, the same
 *    style as `DataResetService` — so this class is not registered in any `forFeature` and, with
 *    `autoLoadEntities`, never reaches TypeORM's metadata at runtime. It exists as the one typed,
 *    reviewable declaration of the table's shape; the migration
 *    (`1795900000000-DeveloperRole.ts`) is what actually creates it.
 */

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { DestructiveActionType, DestructiveActionRequestStatus } from '@fapoms/shared';

/** What the developer asked for, frozen at request time — the thing the admin's approval covers. */
export interface DestructiveActionPayload {
  /** Sorted domain keys. Execute refuses any selection that is not EXACTLY this list. */
  domainKeys: string[];
  /** Row counts previewed at request time, keyed by domain — what the approver saw. */
  previewCounts: Record<string, number>;
}

@Entity('destructive_action_requests')
export class DestructiveActionRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'action_type', type: 'varchar', length: 32 })
  actionType: DestructiveActionType;

  @Index('IDX_destructive_action_requests_status')
  @Column({ type: 'varchar', length: 16 })
  status: DestructiveActionRequestStatus;

  @Column({ type: 'jsonb' })
  payload: DestructiveActionPayload;

  /** Plain uuid, no FK — see the file comment for why that is a requirement, not an omission. */
  @Index('IDX_destructive_action_requests_requested_by')
  @Column({ name: 'requested_by', type: 'uuid' })
  requestedBy: string;

  @Column({ name: 'decided_by', type: 'uuid', nullable: true })
  decidedBy: string | null;

  @Column({ name: 'decision_reason', type: 'text', nullable: true })
  decisionReason: string | null;

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt: Date;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ name: 'executed_at', type: 'timestamptz', nullable: true })
  executedAt: Date | null;

  /** Set on approval: the moment the approval stops being executable. */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
