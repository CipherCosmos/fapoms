import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('workflow_history')
// Read by the unified audit trail: `WHERE "entityId" = $1 ORDER BY "timestamp" DESC`. Also in
// 1790300000000-RestoreScaleIndexes.
@Index('IDX_workflow_history_entity_timestamp', ['entityId', 'timestamp'])
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
