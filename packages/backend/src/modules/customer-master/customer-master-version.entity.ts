import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectEntity } from '../../modules/project/project.entity';
import { CustomerMasterStatus } from '@fapoms/shared';
import { CustomerRecordEntity } from './customer-record.entity';

@Entity('customer_master_versions')
@Index(['projectId'])
@Index(['versionNumber'])
@Index(['status'])
export class CustomerMasterVersionEntity extends BaseEntity {
  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @Column({ name: 'version_number', type: 'integer' })
  versionNumber: number;

  /**
   * The audit date this batch is for.
   *
   * The client sends one file the day before covering every branch scheduled for
   * that date — so the batch, not the branch, is the unit of a day's intake. Without
   * this the batch was only "version N of the project", which could not answer
   * "did tomorrow's data arrive?" or "which branches are in tomorrow's run?".
   *
   * Nullable so batches created before this existed remain readable.
   */
  @Column({ name: 'audit_date', type: 'date', nullable: true })
  auditDate: string | null;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({ name: 'file_path', type: 'text' })
  filePath: string;

  @Column({ name: 'total_rows', type: 'integer', default: 0 })
  totalRows: number;

  @Column({ name: 'unique_accounts', type: 'integer', default: 0 })
  uniqueAccounts: number;

  @Column({ name: 'duplicate_accounts', type: 'integer', default: 0 })
  duplicateAccounts: number;

  @Column({
    type: 'enum',
    enum: CustomerMasterStatus,
    default: CustomerMasterStatus.DRAFT,
  })
  status: CustomerMasterStatus;

  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @OneToMany(() => CustomerRecordEntity, (r) => r.customerMasterVersion)
  records: CustomerRecordEntity[];
}
