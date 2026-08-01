import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditEntity } from './audit.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { AuditHistoryService } from '../audit-history/audit-history.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditEntity)
    private readonly auditRepository: Repository<AuditEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly billingEngine: BillingEngineService,
    private readonly historyService: AuditHistoryService,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  async startAudit(assignmentId: string, assayerId: string, projectId: string, branchId: string, scheduledDate: Date): Promise<AuditEntity> {
    const audit = this.auditRepository.create({
      assignmentId,
      assayerId,
      projectId,
      branchId,
      status: 'IN_PROGRESS',
      scheduledDate,
      slaStatus: 'MET',
    });
    const saved = await this.auditRepository.save(audit);
    
    // Log timeline history entry
    await this.historyService.createRecord({
      auditId: saved.id,
      assayerId,
      clientId: 'system',
      projectId,
      status: 'IN_PROGRESS',
      outcome: 'PENDING',
      startTime: new Date(),
      slaStatus: 'MET',
    });

    this.eventPublisher.publish('audit:started', {
      eventType: 'audit:started',
      aggregateId: saved.id,
      assayerId,
      assignmentId,
      projectId,
      branchId,
      payload: { id: saved.id, status: 'IN_PROGRESS', scheduledDate },
    });

    return saved;
  }

  async closeAudit(id: string, baseFee?: number, travelAllowance?: number): Promise<AuditEntity> {
    const audit = await this.auditRepository.findOne({ where: { id } });
    if (!audit) throw new NotFoundException(`Audit ${id} not found.`);

    // Default the payout to what the assayer actually agreed to for this assignment,
    // rather than requiring it be re-typed from scratch — an explicit override still wins.
    let resolvedBaseFee = baseFee;
    let resolvedTravelAllowance = travelAllowance;
    if (resolvedBaseFee === undefined || resolvedTravelAllowance === undefined) {
      const assignment = audit.assignmentId
        ? await this.assignmentRepository.findOne({ where: { id: audit.assignmentId } }).catch(() => null)
        : null;
      const agreedTotal = assignment ? Number(assignment.agreedFee ?? assignment.proposedFee ?? 0) : 0;
      if (resolvedBaseFee === undefined) resolvedBaseFee = agreedTotal;
      if (resolvedTravelAllowance === undefined) resolvedTravelAllowance = 0;
    }

    audit.status = 'CLOSED';
    audit.completionDate = new Date();
    const saved = await this.auditRepository.save(audit);

    // Book what we owe the assayer through the billing engine. This used to write
    // a separate billing record and hand-credit a running balance in another
    // module, which meant closing an audit and completing its assignment each
    // produced their own record of the same debt. `syncPayableForAssignment` is
    // idempotent per assignment, so whichever event lands first creates the
    // payable and the other is a no-op — one obligation, one record.
    let payableId: string | undefined;
    if (saved.assignmentId) {
      const result = await this.billingEngine.syncPayableForAssignment(saved.assignmentId, 'system');
      payableId = result.payableId;
    }

    this.eventPublisher.publish('audit:closed', {
      eventType: 'audit:closed',
      aggregateId: id,
      assayerId: saved.assayerId,
      payableId,
      payload: { id, status: 'CLOSED', completionDate: saved.completionDate, baseFee: resolvedBaseFee, travelAllowance: resolvedTravelAllowance },
    });

    return saved;
  }
}
