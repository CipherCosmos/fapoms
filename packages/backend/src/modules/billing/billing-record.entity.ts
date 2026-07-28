import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('assayer_billing_records')
export class BillingRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  auditId?: string;

  @Column()
  assayerId: string;

  @Column('decimal')
  baseFee: number;

  @Column('decimal', { default: 0 })
  travelAllowance: number;

  @Column('decimal', { default: 0 })
  penalties: number;

  @Column('decimal', { default: 0 })
  gst: number;

  @Column('decimal', { default: 0 })
  tds: number;

  @Column('decimal')
  netPayable: number;

  @Column()
  invoiceStatus: string; // DRAFT, ISSUED, PAID, CANCELLED

  @CreateDateColumn()
  createdAt: Date;
}
