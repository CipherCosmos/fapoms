import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('assayer_financial_ledger')
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  assayerId: string;

  @Column()
  transactionType: string; // CREDIT, DEBIT

  @Column('decimal')
  amount: number;

  @Column('decimal')
  runningBalance: number;

  @Column({ nullable: true })
  referenceId: string;

  @CreateDateColumn()
  createdAt: Date;
}
