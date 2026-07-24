import { Repository } from 'typeorm';
import { AuditEntity } from './audit.entity';
import { BillingService } from '../billing/billing.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditHistoryService } from '../audit-history/audit-history.service';
export declare class AuditService {
    private readonly auditRepository;
    private readonly billingService;
    private readonly ledgerService;
    private readonly historyService;
    constructor(auditRepository: Repository<AuditEntity>, billingService: BillingService, ledgerService: LedgerService, historyService: AuditHistoryService);
    startAudit(assignmentId: string, assayerId: string, projectId: string, branchId: string, scheduledDate: Date): Promise<AuditEntity>;
    closeAudit(id: string, baseFee: number, travelAllowance: number): Promise<AuditEntity>;
}
