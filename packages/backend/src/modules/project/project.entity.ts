/**
 * FAPOMS — Project Entity
 *
 * Represents an audit project cycle (Part 2 §3, Part 5 §3).
 */

import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { ProjectStatus, Priority } from '@fapoms/shared';

@Entity('projects')
@Index(['projectNumber'])
@Index(['clientId'])
export class ProjectEntity extends BaseEntity {
  @Column({ name: 'project_number', length: 50, unique: true })
  projectNumber: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  @Column({
    type: 'enum',
    enum: ProjectStatus,
    default: ProjectStatus.DRAFT,
  })
  status: ProjectStatus;

  @Column({
    type: 'enum',
    enum: Priority,
    default: Priority.MEDIUM,
  })
  priority: Priority;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate: Date | null;

  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate: Date | null;

  @ManyToOne(() => ClientEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity;

  @OneToMany(() => ProjectBranchEntity, (pb) => pb.project)
  projectBranches: ProjectBranchEntity[];
}
