import { Entity, Column, ManyToMany, JoinTable } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { PermissionEntity } from './permission.entity';

/**
 * Documentation, not authorization input.
 *
 * A capability's permissions describe what it means, not what anyone is granted by holding it.
 * Every capability-path permission a role can reach is also a direct role_permissions grant
 * (verified: capability-only count is 0 across every role), and both the guards
 * (`permissionKeysHeldBy` in guards.ts) and the JWT claim built at login read only
 * `role.permissions`. See `ResponsibilityEntity` for the fuller explanation and the drift guard
 * that keeps this true.
 */
@Entity('capabilities')
export class CapabilityEntity extends BaseEntity {
  @Column({ unique: true, length: 100 })
  name: string;

  @Column({ name: 'display_name', length: 100 })
  displayName: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ length: 50, nullable: true, comment: 'Logical grouping, e.g. PROJECT, ASSIGNMENT' })
  category: string;

  @ManyToMany(() => PermissionEntity)
  @JoinTable({
    name: 'capability_permissions',
    joinColumn: { name: 'capability_id' },
    inverseJoinColumn: { name: 'permission_id' },
  })
  permissions: PermissionEntity[];
}
