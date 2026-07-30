import { Repository } from 'typeorm';
import { AuditEntity } from './audit.entity';
import { BillingService } from '../billing/billing.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditHistoryService } from '../audit-history/audit-history.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
export declare class AuditService {
    private readonly auditRepository;
    private readonly billingService;
    private readonly ledgerService;
    private readonly historyService;
    private readonly eventPublisher;
    constructor(auditRepository: Repository<AuditEntity>, billingService: BillingService, ledgerService: LedgerService, historyService: AuditHistoryService, eventPublisher: DomainEventPublisher);
    startAudit(assignmentId: string, assayerId: string, projectId: string, branchId: string, scheduledDate: Date): Promise<AuditEntity>;
    closeAudit(id: string, baseFee: number, travelAllowance: number): Promise<AuditEntity>;
}
