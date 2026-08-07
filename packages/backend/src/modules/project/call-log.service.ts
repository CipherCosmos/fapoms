import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { CallLogEntity } from './call-log.entity';
import { AssessmentEntity } from './assessment.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';

/**
 * Records of ops phoning an assayer about a branch.
 *
 * `call_logs` and `CallLogEntity` have existed since the initial migration — registered in
 * ProjectModule, indexed on three columns, with fields for outcome, negotiated fee and notes —
 * and had no service, no controller, no repository injection and no writes anywhere. The table
 * has never held a row.
 *
 * Meanwhile the actual workflow is phone-first: the Planning screen's primary action is
 * literally "Call & Assign", and three of eight live assignments went through fee negotiation.
 * None of those calls left a trace, so nobody could answer "have we already tried this
 * person?", "who agreed this fee, and when?", or produce a record if an assayer later disputes
 * what was agreed.
 */

export enum CallOutcome {
  /** Spoke to them and they took the work at the stated fee. */
  AGREED = 'AGREED',
  /** Spoke to them, they want a different fee. */
  NEGOTIATING = 'NEGOTIATING',
  /** Spoke to them, they turned it down. */
  DECLINED = 'DECLINED',
  NO_ANSWER = 'NO_ANSWER',
  CALLBACK_REQUESTED = 'CALLBACK_REQUESTED',
  WRONG_NUMBER = 'WRONG_NUMBER',
}

export interface CreateCallLogDto {
  projectBranchId: string;
  assayerId: string;
  outcome: CallOutcome;
  negotiatedFee?: number;
  notes?: string;
}

@Injectable()
export class CallLogService {
  constructor(
    @InjectRepository(CallLogEntity)
    private readonly callLogRepository: Repository<CallLogEntity>,
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepository: Repository<AssessmentEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * The entity keys on `assessmentId`, but every caller works in terms of a project branch —
   * assessments are keyed by (projectId, branchId), so resolve across.
   */
  private async resolveAssessmentId(projectBranchId: string): Promise<string> {
    const pb = await this.projectBranchRepository.findOne({ where: { id: projectBranchId } });
    if (!pb) {
      throw new NotFoundException(`Project branch ${projectBranchId} not found.`);
    }
    const assessment = await this.assessmentRepository.findOne({
      where: { projectId: pb.projectId, branchId: pb.branchId },
    });
    if (!assessment) {
      throw new NotFoundException(`No assessment exists for project branch ${projectBranchId}.`);
    }
    return assessment.id;
  }

  async create(dto: CreateCallLogDto, userId: string): Promise<CallLogEntity> {
    if (!Object.values(CallOutcome).includes(dto.outcome)) {
      throw new BadRequestException(`Unknown call outcome: ${dto.outcome}`);
    }

    const fee = dto.negotiatedFee != null ? Number(dto.negotiatedFee) : null;
    if (fee != null && (!Number.isFinite(fee) || fee < 0)) {
      throw new BadRequestException('Negotiated fee must be a non-negative number.');
    }
    // A fee only means something when someone actually discussed one. Recording "no answer,
    // agreed ₹1500" would put a number on the record that no conversation produced.
    const feeBearing = [CallOutcome.AGREED, CallOutcome.NEGOTIATING];
    if (fee != null && !feeBearing.includes(dto.outcome)) {
      throw new BadRequestException(
        `A negotiated fee can only be recorded against an ${feeBearing.join(' or ')} outcome.`,
      );
    }

    const assessmentId = await this.resolveAssessmentId(dto.projectBranchId);

    const saved = await this.callLogRepository.save(
      this.callLogRepository.create({
        assessmentId,
        assessorId: dto.assayerId,
        calledBy: userId,
        timestamp: new Date(),
        outcome: dto.outcome,
        negotiatedFee: fee,
        notes: dto.notes?.trim() || null,
        createdBy: userId,
        updatedBy: userId,
      }),
    );

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_CALLED',
      entityType: 'CALL_LOG',
      entityId: saved.id,
      userId,
      remarks: `Called assayer ${dto.assayerId} about branch ${dto.projectBranchId}: ${dto.outcome}${fee != null ? ` at ₹${fee}` : ''}`,
    });

    return saved;
  }

  /** Call history for one branch, newest first — "who has already been approached". */
  async findForProjectBranch(projectBranchId: string): Promise<CallLogEntity[]> {
    const assessmentId = await this.resolveAssessmentId(projectBranchId);
    return this.callLogRepository.find({
      where: { assessmentId, isActive: true },
      relations: ['assessor'],
      order: { timestamp: 'DESC' },
    });
  }

  /**
   * Most recent contact per assayer for a branch, so the candidate list can show "called 2h
   * ago — no answer" instead of ops rediscovering it by dialling again.
   */
  async lastContactByAssayer(
    projectBranchId: string,
  ): Promise<Record<string, { outcome: string; timestamp: Date; negotiatedFee: number | null }>> {
    const logs = await this.findForProjectBranch(projectBranchId);
    const out: Record<string, { outcome: string; timestamp: Date; negotiatedFee: number | null }> = {};
    for (const log of logs) {
      // findForProjectBranch is newest-first, so the first entry per assayer is the latest.
      if (!out[log.assessorId]) {
        out[log.assessorId] = {
          outcome: log.outcome,
          timestamp: log.timestamp,
          negotiatedFee: log.negotiatedFee != null ? Number(log.negotiatedFee) : null,
        };
      }
    }
    return out;
  }
}
