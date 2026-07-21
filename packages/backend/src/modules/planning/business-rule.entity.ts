import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

@Entity('business_rules')
@Index(['scope', 'targetId'])
export class BusinessRuleEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'varchar', length: 50 })
  scope: string; // 'GLOBAL', 'CLIENT', 'BRANCH'

  @Column({ name: 'target_id', type: 'uuid', nullable: true })
  targetId: string | null;

  @Column({ name: 'rule_type', type: 'varchar', length: 100 })
  ruleType: string; // 'ELIGIBILITY', 'CAPACITY', 'CERTIFICATION', 'TERRITORY'

  @Column({ type: 'jsonb' })
  conditions: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  actions: Record<string, any> | null;
}
