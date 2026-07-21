import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { CommunicationType } from '@fapoms/shared';

@Entity('communications')
@Index(['assignmentId'])
@Index(['type'])
export class CommunicationEntity extends BaseEntity {
  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId: string;

  @Column({
    type: 'enum',
    enum: CommunicationType,
  })
  type: CommunicationType;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'initiated_by', type: 'uuid' })
  initiatedBy: string;

  @Column({ name: 'recipient_ref', type: 'varchar', length: 150, nullable: true })
  recipientRef: string | null;

  @Column({ name: 'is_delivered', type: 'boolean', default: true })
  isDelivered: boolean;

  @ManyToOne(() => AssignmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assignment_id' })
  assignment: AssignmentEntity;
}
