import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ValidationCaseEntity } from '../../modules/validation/validation-case.entity';
import { ValidationQueryStatus } from '@fapoms/shared';

@Entity('validation_queries')
@Index(['validationCaseId'])
@Index(['assayerId'])
@Index(['status'])
export class ValidationQueryEntity extends BaseEntity {
  @Column({ name: 'validation_case_id', type: 'uuid' })
  validationCaseId: string;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({ name: 'query_text', type: 'text' })
  queryText: string;

  @Column({ name: 'target_field', type: 'varchar', length: 150, nullable: true })
  targetField: string | null;

  @Column({ name: 'assayer_response', type: 'text', nullable: true })
  assayerResponse: string | null;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt: Date | null;

  @Column({ name: 'attachments', type: 'jsonb', nullable: true })
  attachments: { url: string; fileName: string; fileType: string; uploadedBy: string; timestamp: string }[] | null;

  @Column({
    type: 'enum',
    enum: ValidationQueryStatus,
    default: ValidationQueryStatus.OPEN,
  })
  status: ValidationQueryStatus;

  @Column({ name: 'sla_due_date', type: 'timestamptz', nullable: true })
  slaDueDate: Date | null;

  @ManyToOne(() => ValidationCaseEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'validation_case_id' })
  validationCase: ValidationCaseEntity;
}
