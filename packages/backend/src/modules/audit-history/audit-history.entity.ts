import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('assayer_audit_history')
export class AuditHistoryRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  auditId: string;

  @Column()
  assayerId: string;

  @Column()
  clientId: string;

  @Column()
  projectId: string;

  @Column()
  status: string;

  @Column()
  outcome: string;

  @Column({ nullable: true })
  startTime: Date;

  @Column({ nullable: true })
  endTime: Date;

  @Column({ nullable: true })
  slaStatus: string;

  @CreateDateColumn()
  createdAt: Date;
}
