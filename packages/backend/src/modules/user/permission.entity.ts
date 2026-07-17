/**
 * FAPOMS — Permission Entity
 *
 * Represents a granular permission (Part 8 §7-9).
 * Format: Resource : Action : Scope
 *
 * Example: PROJECT:VIEW:ORGANIZATION
 */

import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

@Entity('permissions')
@Index(['resource', 'action', 'scope'], { unique: true })
export class PermissionEntity extends BaseEntity {
  @Column({
    length: 50,
    comment: 'Resource this permission applies to, e.g. PROJECT, ASSIGNMENT',
  })
  resource: string;

  @Column({
    length: 50,
    comment: 'Action permitted, e.g. VIEW, CREATE, EDIT',
  })
  action: string;

  @Column({
    length: 50,
    comment: 'Scope of the permission, e.g. SELF, ORGANIZATION, PLATFORM',
  })
  scope: string;

  @Column({ type: 'text', nullable: true })
  description: string;
}
