import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('workflow_history')
export class WorkflowHistoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  workflowKey: string;

  @Column()
  entityId: string;

  @Column()
  previousState: string;

  @Column()
  newState: string;

  @Column()
  command: string;

  @Column()
  userId: string;

  @CreateDateColumn()
  timestamp: Date;

  @Column()
  correlationId: string;
}
