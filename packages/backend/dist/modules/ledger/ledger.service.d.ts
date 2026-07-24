import { Repository } from 'typeorm';
import { LedgerEntry } from './ledger-entry.entity';
export declare class LedgerService {
    private readonly ledgerRepository;
    constructor(ledgerRepository: Repository<LedgerEntry>);
    addEntry(assayerId: string, type: 'CREDIT' | 'DEBIT', amount: number, referenceId?: string): Promise<LedgerEntry>;
    getLedger(assayerId: string): Promise<LedgerEntry[]>;
}
