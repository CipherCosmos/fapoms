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
    return this.ledgerRepository.manager.transaction(async (manager) => {
      const assayerRes = await manager.query(
        `SELECT running_balance FROM assayers WHERE id = $1 FOR UPDATE`,
        [assayerId],
      );

      if (!assayerRes || assayerRes.length === 0) {
        throw new Error(`Assayer ${assayerId} not found`);
      }

      const currentBalance = Number(assayerRes[0].running_balance || 0);
      const nextBalance = type === 'CREDIT' ? currentBalance + Number(amount) : currentBalance - Number(amount);

      await manager.query(
        `UPDATE assayers SET running_balance = $1 WHERE id = $2`,
        [nextBalance, assayerId],
      );

      const entry = manager.create(LedgerEntry, {
        assayerId,
        transactionType: type,
        amount,
        runningBalance: nextBalance,
        referenceId,
      });
      return manager.save(entry);
    });
  }

  async getLedger(assayerId: string): Promise<LedgerEntry[]> {
    return this.ledgerRepository.find({
      where: { assayerId },
      order: { createdAt: 'DESC' },
    });
  }
}
