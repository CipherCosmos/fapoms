import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';

export enum CoveragePlanStatus {
  DRAFT = 'DRAFT',
  GENERATED = 'GENERATED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  LOCKED = 'LOCKED',
  DEPLOYED = 'DEPLOYED',
  ARCHIVED = 'ARCHIVED',
}

@Entity('coverage_plans')
@Index(['projectId'])
export class CoveragePlanEntity extends BaseEntity {
  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({
    type: 'enum',
    enum: CoveragePlanStatus,
    default: CoveragePlanStatus.DRAFT,
  })
  status: CoveragePlanStatus;

  @Column({ name: 'current_version', type: 'integer', default: 1 })
  currentVersion: number;

  @OneToMany(() => CoveragePlanVersionEntity, (v) => v.coveragePlan, { cascade: true })
  versions: CoveragePlanVersionEntity[];
}
