import { Entity, Column, ManyToMany, JoinTable } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { CapabilityEntity } from './capability.entity';

@Entity('responsibilities')
export class ResponsibilityEntity extends BaseEntity {
  @Column({ unique: true, length: 100 })
  name: string;

  @Column({ name: 'display_name', length: 100 })
  displayName: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @ManyToMany(() => CapabilityEntity, { eager: true })
  @JoinTable({
    name: 'responsibility_capabilities',
    joinColumn: { name: 'responsibility_id' },
    inverseJoinColumn: { name: 'capability_id' },
  })
  capabilities: CapabilityEntity[];
}
