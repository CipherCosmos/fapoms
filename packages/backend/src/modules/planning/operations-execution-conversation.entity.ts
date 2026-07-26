import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

export enum NegotiationParticipant {
  OPERATIONS = 'OPERATIONS',
  ASSAYER = 'ASSAYER',
  SYSTEM = 'SYSTEM',
}

@Entity('operations_execution_conversations')
@Index(['groupId'])
export class OperationsExecutionConversationEntity extends BaseEntity {
  @Column({ name: 'group_id', type: 'uuid' })
  groupId: string;

  @Column({
    type: 'enum',
    enum: NegotiationParticipant,
  })
  sender: NegotiationParticipant;

  @Column({ type: 'text' })
  message: string;

  @Column({ name: 'proposed_fee_override', type: 'numeric', precision: 10, scale: 2, nullable: true })
  proposedFeeOverride: number | null;

  @Column({ name: 'proposed_date_override', type: 'date', nullable: true })
  proposedDateOverride: string | null;
}
