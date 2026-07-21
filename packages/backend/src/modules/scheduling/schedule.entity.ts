import { Entity, Column, Index, ManyToOne, JoinColumn, OneToOne } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ScheduleStatus } from '@fapoms/shared';

@Entity('schedules')
@Index(['projectId'])
@Index(['assayerId'])
@Index(['status'])
export class ScheduleEntity extends BaseEntity {
  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @Column({ name: 'scheduled_date', type: 'date' })
  scheduledDate: Date;

  @Column({
    type: 'enum',
    enum: ScheduleStatus,
    default: ScheduleStatus.TENTATIVE,
  })
  status: ScheduleStatus;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @OneToOne(() => AssignmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assignment_id' })
  assignment: AssignmentEntity;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;
}
