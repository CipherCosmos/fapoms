import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, Optional } from '@nestjs/common';
import {
  AssayerLifecycleStatus, CHECK_TYPE_LABELS, CheckReviewDecision, EventCategory, OnboardingApprovalEventKind,
  approvalTextProblem, businessTodayDateKey, type ComplianceHold,
} from '@fapoms/shared';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerEntity } from './assayer.entity';
import { AssayerService } from './assayer.service';
import { AuditService } from '../../core/audit/audit.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

export interface ReviewActor { id: string; name?: string | null }

/**
 * THE SENIOR'S DECISION ON AN ADVERSE RE-CHECK (owner, 2026-09-23).
 *
 * A re-check that comes back adverse on somebody already working holds them from new work
 * (`assayers.compliance_hold`) until a holder of ASSAYER:APPROVE — never whoever recorded the check
 * — decides: KEEP them working, or SUSPEND them. Either way the reason is kept on the check and the
 * trail, and the hold moves to the next adverse check still waiting, or is lifted.
 */
@Injectable()
export class ComplianceReviewService {
  constructor(
    private readonly assayerService: AssayerService,
    private readonly auditService: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Optional() private readonly notifications?: NotificationDispatchService,
  ) {}

  async decide(assayerId: string, checkId: string, decision: CheckReviewDecision, reason: string, actor: ReviewActor) {
    if (!Object.values(CheckReviewDecision).includes(decision)) {
      throw new BadRequestException('Decide to keep them working or to suspend them.');
    }
    const problem = approvalTextProblem(OnboardingApprovalEventKind.REJECTED, reason);
    if (problem) throw new BadRequestException(problem.replace('why they are not approved', 'why'));

    const person = await this.assayerService.findOne(assayerId);
    const check = await this.unitOfWork.run((m) => m.getRepository(AssayerBackgroundCheckEntity).findOne({ where: { id: checkId, assayerId } }));
    if (!check) throw new NotFoundException('No such check on this person.');
    if (check.reviewStatus !== 'PENDING') throw new ConflictException('This check has already been decided.');
    if (check.createdBy && check.createdBy === actor.id) {
      throw new ForbiddenException('You recorded this check, so somebody else has to decide it.');
    }
    if (decision === CheckReviewDecision.SUSPEND && person.lifecycleStatus !== AssayerLifecycleStatus.ACTIVE) {
      throw new ConflictException(
        `${person.displayName} is ${person.lifecycleStatus.toLowerCase().replace(/_/g, ' ')}, not working — `
        + 'a suspension is for somebody active. Keep the hold by leaving this undecided, or decide to keep them.',
      );
    }
    const label = CHECK_TYPE_LABELS[check.checkType];

    // The suspension first: if the lifecycle refuses it, nothing about the review has changed.
    if (decision === CheckReviewDecision.SUSPEND) {
      await this.assayerService.transitionLifecycle(
        assayerId, AssayerLifecycleStatus.SUSPENDED, actor.id, `${label} came back adverse: ${reason.trim()}`,
      );
    }

    const nextHold = await this.unitOfWork.run(async (m) => {
      const checks = m.getRepository(AssayerBackgroundCheckEntity);
      const fresh = await checks.findOne({ where: { id: checkId }, lock: { mode: 'pessimistic_write' } });
      if (!fresh || fresh.reviewStatus !== 'PENDING') throw new ConflictException('This check has already been decided.');
      fresh.reviewStatus = decision === CheckReviewDecision.KEEP ? 'KEPT' : 'SUSPENDED';
      fresh.reviewedBy = actor.id;
      fresh.reviewedAt = new Date();
      fresh.reviewReason = reason.trim();
      fresh.updatedBy = actor.id;
      await checks.save(fresh);

      // The hold follows whatever is still waiting — two adverse re-checks are two decisions.
      const waiting = await checks.findOne({
        where: { assayerId, reviewStatus: 'PENDING', isActive: true },
        order: { createdAt: 'ASC' },
      });
      const hold: ComplianceHold | null = waiting
        ? { checkId: waiting.id, checkType: waiting.checkType, verdict: waiting.verdict, since: businessTodayDateKey(), recordedBy: waiting.createdBy ?? '' }
        : null;
      await m.getRepository(AssayerEntity).update({ id: assayerId }, { complianceHold: hold as never, updatedBy: actor.id });
      return hold;
    });

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: decision === CheckReviewDecision.KEEP ? 'ASSAYER_RECHECK_KEPT' : 'ASSAYER_RECHECK_SUSPENDED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: actor.id,
      remarks: `${label} came back adverse; ${decision === CheckReviewDecision.KEEP ? 'kept working' : 'suspended'}: ${reason.trim()}`
        + (nextHold ? ' Still held: another adverse check is waiting.' : ''),
      metadata: { checkId, checkType: check.checkType, decision, stillHeld: !!nextHold },
    });

    // Whoever recorded the check hears what was decided.
    if (check.createdBy && check.createdBy !== actor.id) {
      this.notifications?.emitSafe({
        type: 'ASSAYER_RECHECK_REVIEWED',
        entityType: 'ASSAYER',
        entityId: assayerId,
        actorUserId: actor.id,
        ownerUserId: check.createdBy,
        assayerId,
        dedupeKey: `ASSAYER_RECHECK_REVIEWED:${checkId}`,
        payload: {
          assayerName: person.displayName,
          assayerId,
          checkLabel: label,
          decidedBy: actor.name?.trim() || 'The approver',
          outcome: decision === CheckReviewDecision.KEEP ? 'kept them working' : 'suspended them',
          reason: reason.trim().slice(0, 300),
        },
      });
    }
    return { checkId, decision, stillHeld: !!nextHold };
  }
}
