import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AssignmentEntity } from './assignment.entity';
import { AssayerEntity } from '../assayer/assayer.entity';

/**
 * One append-only row per interval of ownership of an assignment: who held it, who took it over,
 * who moved it, why, and between which two instants.
 *
 * This deliberately does NOT extend `BaseEntity`, and that is the whole of the fix for a total
 * outage of `POST /assignments/:id/reassign`. `BaseEntity` declares `@VersionColumn() version`,
 * so every statement TypeORM built for this entity named a `version` column: the SELECT that
 * finds the current open interval, the UPDATE that closes it, and the INSERT that opens the new
 * one. `assignment_reassignments` has never had that column — 1796200000000-Phase2OperationalIntegrity
 * created the table with created_by/updated_by/created_at/updated_at/is_active and no version —
 * so the first of those queries died with
 * `QueryFailedError: column AssignmentReassignmentEntity.version does not exist`.
 *
 * The shape of that failure is why it was expensive. It landed *after* the region check, the
 * assayer lookup, the double-booking check and the optimistic-lock check had all passed, inside
 * the transaction, so the caller who had done everything right got a 500 and the caller who had
 * asked for something illegal got a clean 409. Every reassignment the operations desk attempted
 * looked like a database outage, and the table has 0 rows to show for it — the lineage the
 * `getReassignmentHistory` endpoint and the audit trail read from has been empty since the day
 * it was introduced. The sibling write in `AssignmentService.create()`, which records lineage
 * when a create reassigns an existing branch, failed the same way for the same reason.
 *
 * Adding a `version` column by migration would also have silenced the error, and was rejected.
 * Optimistic locking exists to catch a lost update between two writers of the same row, and this
 * row has no second writer: it is inserted once, and later closed exactly once by stamping
 * `ownership_ended_at`, from inside the same transaction that moves the assignment itself — which
 * is already serialized by the `SELECT ... FOR UPDATE` on the parent assignment. The concurrency
 * this table genuinely needs is enforced in the schema rather than in a counter, by
 * `idx_assignment_reassignments_active_owner`, the partial unique index that permits at most one
 * open interval per assignment. A version column would add a migration, a column and a
 * lost-update failure mode to a history table that can never lose an update.
 *
 * It also puts this entity where the codebase's other append-only tables already are:
 * `AssayerDocumentVersionEntity`, `WorkflowHistoryEntity`, `AssignmentIdempotencyEntity` and
 * `AuditEventEntity` all declare their own columns rather than inherit the mutable-entity base.
 * The audit columns below are re-declared, not dropped, because the table really does have them:
 * `created_at` is what `getReassignmentHistory()` orders by, and `is_active` is read by the
 * current-owner lookup in `reassignAssignment()` and by the partial unique index above.
 */
@Entity('assignment_reassignments')
@Index(['assignmentId', 'createdAt'])
export class AssignmentReassignmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId: string;

  @Column({ name: 'previous_assayer_id', type: 'uuid', nullable: true })
  previousAssayerId: string | null;

  @Column({ name: 'new_assayer_id', type: 'uuid' })
  newAssayerId: string;

  @Column({ name: 'reassigned_by', type: 'uuid' })
  reassignedBy: string;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'request_id', type: 'varchar', length: 100, nullable: true })
  requestId: string | null;

  @Column({ name: 'ownership_started_at', type: 'timestamptz' })
  ownershipStartedAt: Date;

  /** NULL means this is the interval currently in force — the row the unique index protects. */
  @Column({ name: 'ownership_ended_at', type: 'timestamptz', nullable: true })
  ownershipEndedAt: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // uuid, matching the columns the migration actually created. `BaseEntity` types the same two
  // as untyped `string`, which TypeORM maps to varchar — harmless while it never had to build
  // DDL for this table, and wrong the moment anything compares the entity against the schema.
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => AssignmentEntity, (a) => a.reassignments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assignment_id' })
  assignment: AssignmentEntity;

  @ManyToOne(() => AssayerEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'previous_assayer_id' })
  previousAssayer: AssayerEntity | null;

  @ManyToOne(() => AssayerEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'new_assayer_id' })
  newAssayer: AssayerEntity;
}
