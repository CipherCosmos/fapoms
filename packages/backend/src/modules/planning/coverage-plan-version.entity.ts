import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { CoveragePlanEntity } from './coverage-plan.entity';

@Entity('coverage_plan_versions')
@Index(['coveragePlanId'])
export class CoveragePlanVersionEntity extends BaseEntity {
  @Column({ name: 'coverage_plan_id', type: 'uuid' })
  coveragePlanId: string;

  @Column({ type: 'integer' })
  versionNumber: number;

  @Column({ type: 'jsonb' })
  planData: any; // stores serialized assignments, clusters, and KPI metrics

  @Column({ type: 'jsonb', nullable: true })
  overrides: any; // stores manual assignments, locks, or pins

  @Column({ type: 'text', nullable: true })
  changeJustification: string | null;

  @ManyToOne(() => CoveragePlanEntity, (cp) => cp.versions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'coverage_plan_id' })
  coveragePlan: CoveragePlanEntity;
}
