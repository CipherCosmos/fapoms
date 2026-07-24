import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne, JoinColumn } from 'typeorm';
import { AssignmentEntity } from '../assignment/assignment.entity';

@Entity('audits')
export class AuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  assignmentId: string;

  @Column()
  assayerId: string;

  @Column()
  projectId: string;

  @Column()
  branchId: string;

  @Column()
  status: string; // IN_PROGRESS, COMPLETED, CLOSED

  @Column({ nullable: true })
  scheduledDate: Date;

  @Column({ nullable: true })
  completionDate: Date;

  @Column({ nullable: true })
  slaStatus: string; // MET, BREACHED

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
