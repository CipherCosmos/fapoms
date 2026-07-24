import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LedgerEntry } from './ledger-entry.entity';

@Injectable()
export class LedgerService {
  constructor(
    @InjectRepository(LedgerEntry)
    private readonly ledgerRepository: Repository<LedgerEntry>,
  ) {}

  async addEntry(assayerId: string, type: 'CREDIT' | 'DEBIT', amount: number, referenceId?: string): Promise<LedgerEntry> {
    const latest = await this.ledgerRepository.findOne({
      where: { assayerId },
      order: { createdAt: 'DESC' },
    });

    const currentBalance = latest ? Number(latest.runningBalance) : 0;
    const nextBalance = type === 'CREDIT' ? currentBalance + Number(amount) : currentBalance - Number(amount);

    const entry = this.ledgerRepository.create({
      assayerId,
      transactionType: type,
      amount,
      runningBalance: nextBalance,
      referenceId,
    });
    return this.ledgerRepository.save(entry);
  }

  async getLedger(assayerId: string): Promise<LedgerEntry[]> {
    return this.ledgerRepository.find({
      where: { assayerId },
      order: { createdAt: 'DESC' },
    });
  }
}
