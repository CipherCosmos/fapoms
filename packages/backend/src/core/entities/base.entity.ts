/**
 * FAPOMS — Base Entity
 *
 * All entities extend this base, which provides the audit metadata
 * required by Part 7 §11:
 *   - createdBy, createdAt, updatedBy, updatedAt
 *   - version (optimistic concurrency)
 *   - isActive (soft delete per Part 7 §9)
 *
 * System identifiers (UUID) are separate from business identifiers
 * per Part 7 §12.
 */

import {
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'created_by', nullable: true })
  createdBy: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_by', nullable: true })
  updatedBy: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @VersionColumn()
  version: number;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;
}

/**
 * Extended base for entities that track state transitions.
 * Adds previous/new state and change reason fields
 * per Part 7 §11 (business-critical entities).
 */
export abstract class StatefulEntity extends BaseEntity {
  @Column({ name: 'previous_state', nullable: true })
  previousState: string;

  @Column({ name: 'change_reason', nullable: true })
  changeReason: string;
}
