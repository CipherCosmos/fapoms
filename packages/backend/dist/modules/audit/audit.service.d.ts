import { Repository } from 'typeorm';
import { AuditEntity } from './audit.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { AuditHistoryService } from '../audit-history/audit-history.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
export declare class AuditService {
    private readonly auditRepository;
    private readonly assignmentRepository;
    private readonly billingEngine;
    private readonly historyService;
    private readonly eventPublisher;
    constructor(auditRepository: Repository<AuditEntity>, assignmentRepository: Repository<AssignmentEntity>, billingEngine: BillingEngineService, historyService: AuditHistoryService, eventPublisher: DomainEventPublisher);
    startAudit(assignmentId: string, assayerId: string, projectId: string, branchId: string, scheduledDate: Date): Promise<AuditEntity>;
    closeAudit(id: string, baseFee?: number, travelAllowance?: number): Promise<AuditEntity>;
}
