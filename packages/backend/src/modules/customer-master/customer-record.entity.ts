import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { CustomerMasterVersionEntity } from './customer-master-version.entity';
import { BranchEntity } from '../branch/branch.entity';

@Entity('customer_records')
@Index(['customerMasterVersionId'])
@Index(['branchId'])
@Index(['accountNumber'])
export class CustomerRecordEntity extends BaseEntity {
  @Column({ name: 'customer_master_version_id', type: 'uuid' })
  customerMasterVersionId: string;

  @Column({ name: 'branch_id', type: 'uuid', nullable: true })
  branchId: string | null;

  @Column({ name: 'account_number', type: 'varchar', length: 100 })
  accountNumber: string;

  @Column({ name: 'customer_name', type: 'varchar', length: 255 })
  customerName: string;

  @Column({ name: 'packet_count', type: 'integer', default: 1 })
  packetCount: number;

  @Column({ name: 'declared_weight_grams', type: 'numeric', precision: 10, scale: 2, nullable: true })
  declaredWeightGrams: number | null;

  @Column({ name: 'previous_record_id', type: 'uuid', nullable: true })
  previousRecordId: string | null;

  @Column({ name: 'raw_data', type: 'jsonb', nullable: true })
  rawData: any | null;

  @ManyToOne(() => CustomerMasterVersionEntity, (v) => v.records, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_master_version_id' })
  customerMasterVersion: CustomerMasterVersionEntity;

  @ManyToOne(() => BranchEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'branch_id' })
  branch: BranchEntity | null;
}
