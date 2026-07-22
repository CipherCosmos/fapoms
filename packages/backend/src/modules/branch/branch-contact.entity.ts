import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import type { BranchEntity } from './branch.entity';

@Entity('branch_contacts')
@Index(['branchId'])
export class BranchContactEntity extends BaseEntity {
  @Column({ name: 'branch_id', type: 'uuid' })
  branchId: string;

  @ManyToOne('BranchEntity', 'contacts', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'branch_id' })
  branch: BranchEntity;

  @Column({ length: 200 })
  name: string;

  @Column({ length: 255 })
  email: string;

  @Column({ length: 20 })
  phone: string;

  @Column({ length: 200 })
  designation: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  department: string | null;

  @Column({ name: 'is_primary', default: false })
  isPrimary: boolean;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
