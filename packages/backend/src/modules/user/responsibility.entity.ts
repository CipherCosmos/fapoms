import { Entity, Column, ManyToMany, JoinTable } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { CapabilityEntity } from './capability.entity';

/**
 * Documentation, not authorization input.
 *
 * Every permission reachable from a role via role_responsibilities -> responsibility_capabilities
 * -> capability_permissions is also granted directly in role_permissions (verified: the
 * capability-only count is 0 across every role). The guards (`permissionKeysHeldBy` in
 * guards.ts) and the JWT claim built at login read only `role.permissions`. This table and
 * `CapabilityEntity` describe *why* a role holds a grant, for the admin UI and audit trail, but
 * granting or revoking access must go through role_permissions. A drift guard in the auth module
 * (`AuthService.runRbacDriftCheck`) warns on boot if this ever stops being true.
 */
@Entity('responsibilities')
export class ResponsibilityEntity extends BaseEntity {
  @Column({ unique: true, length: 100 })
  name: string;

  @Column({ name: 'display_name', length: 100 })
  displayName: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @ManyToMany(() => CapabilityEntity)
  @JoinTable({
    name: 'responsibility_capabilities',
    joinColumn: { name: 'responsibility_id' },
    inverseJoinColumn: { name: 'capability_id' },
  })
  capabilities: CapabilityEntity[];
}
