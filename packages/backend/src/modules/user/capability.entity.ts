import { Entity, Column, ManyToMany, JoinTable } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { PermissionEntity } from './permission.entity';

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

  @ManyToMany(() => PermissionEntity, { eager: true })
  @JoinTable({
    name: 'capability_permissions',
    joinColumn: { name: 'capability_id' },
    inverseJoinColumn: { name: 'permission_id' },
  })
  permissions: PermissionEntity[];
}
