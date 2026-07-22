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

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

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

  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  budget: number | null;

  @Column({ type: 'text', nullable: true })
  scope: string | null;

  @Column({ name: 'required_skills', type: 'jsonb', nullable: true })
  requiredSkills: string[] | null;

  @Column({ name: 'required_certifications', type: 'jsonb', nullable: true })
  requiredCertifications: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  sla: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  risks: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  milestones: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  dependencies: Record<string, any> | null;

  @ManyToOne(() => ClientEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity;

  @OneToMany(() => ProjectBranchEntity, (pb) => pb.project)
  projectBranches: ProjectBranchEntity[];
}
