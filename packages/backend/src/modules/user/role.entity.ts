/**
 * FAPOMS — Role Entity
 *
 * Represents a system role (Part 8 §6).
 * Roles contain permissions that define what actions are authorized.
 */

import { Entity, Column, ManyToMany, JoinTable } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { PermissionEntity } from './permission.entity';

@Entity('roles')
export class RoleEntity extends BaseEntity {
  @Column({
    unique: true,
    length: 50,
    comment: 'Machine-readable role identifier, e.g. OPERATIONS_MANAGER',
  })
  name: string;

  @Column({ name: 'display_name', length: 100 })
  displayName: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @ManyToMany(() => PermissionEntity, { eager: true })
  @JoinTable({
    name: 'role_permissions',
    joinColumn: { name: 'role_id' },
    inverseJoinColumn: { name: 'permission_id' },
  })
  permissions: PermissionEntity[];
}
