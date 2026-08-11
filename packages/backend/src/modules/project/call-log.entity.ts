import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssessmentEntity } from './assessment.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { UserEntity } from '../user/user.entity';

@Entity('call_logs')
@Index(['assessmentId'])
@Index(['assessorId'])
@Index(['calledBy'])
export class CallLogEntity extends BaseEntity {
  @Column({ name: 'assessment_id', type: 'uuid' })
  assessmentId: string;

  @Column({ name: 'assessor_id', type: 'uuid' })
  assessorId: string;

  @Column({ name: 'called_by', type: 'uuid' })
  calledBy: string;

  @Column({ name: 'timestamp', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  timestamp: Date;

  @Column({ name: 'outcome', type: 'varchar', length: 50 })
  outcome: string;

  @Column({ name: 'negotiated_fee', type: 'decimal', precision: 12, scale: 2, nullable: true })
  negotiatedFee: number | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes: string | null;

  @ManyToOne(() => AssessmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessment_id' })
  assessment: AssessmentEntity;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assessor_id' })
  assessor: AssayerEntity;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'called_by' })
  caller: UserEntity;
}
