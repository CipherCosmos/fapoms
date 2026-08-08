import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { ValidationQueryStatus, EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

import { AssignmentEntity } from '../assignment/assignment.entity';

import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { QueryMessageAuthor } from './validation-query-message.entity';
import { QueryThreadService } from './query-thread.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

export interface CreateValidationQueryDto {
  validationCaseId: string;
  assayerId?: string;
  queryText: string;
  targetField?: string;
  slaHours?: number;
  attachments?: { url: string; fileName: string; fileType: string; uploadedBy: string; timestamp: string }[];
}

@Injectable()
export class ValidationQueryService {
  constructor(
    @InjectRepository(ValidationQueryEntity)
    private readonly queryRepository: Repository<ValidationQueryEntity>,
    @InjectRepository(ValidationCaseEntity)
    private readonly validationCaseRepository: Repository<ValidationCaseEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly notificationService: NotificationService,
    private readonly pushNotificationService: PushNotificationService,
    private readonly threadService: QueryThreadService,
    private readonly notificationDispatch: NotificationDispatchService,
  ) {}

  async createQuery(dto: CreateValidationQueryDto, userId: string): Promise<ValidationQueryEntity> {
    const valCase = await this.validationCaseRepository.findOne({ where: { id: dto.validationCaseId, isActive: true } });
    if (!valCase) throw new NotFoundException(`ValidationCase ${dto.validationCaseId} not found.`);

    let resolvedAssayerId = dto.assayerId;
    if (!resolvedAssayerId || resolvedAssayerId === '00000000-0000-0000-0000-000000000000') {
      const assignment = await this.assignmentRepository.findOne({
        where: { projectBranchId: valCase.projectBranchId, isActive: true },
        order: { createdAt: 'DESC' },
      });
      if (assignment?.assayerId) {
        resolvedAssayerId = assignment.assayerId;
      }
    }

    if (!resolvedAssayerId) {
      throw new BadRequestException(`No active assayer assigned to project branch for validation case ${dto.validationCaseId}.`);
    }

    const slaHours = dto.slaHours || 4;
    const slaDueDate = new Date();
    slaDueDate.setHours(slaDueDate.getHours() + slaHours);

    const rawAttachments = (dto.attachments || []).flat(Infinity).filter((a: any) => a && a.url);

    const query = this.queryRepository.create({
      validationCaseId: dto.validationCaseId,
      assayerId: resolvedAssayerId,
      queryText: dto.queryText,
      targetField: dto.targetField ?? null,
      // Who on the desk raised it — this was never set, so no clarification could be attributed
      // to a staffer or counted toward their throughput.
      raisedByUserId: userId,
      attachments: rawAttachments.length > 0 ? rawAttachments : null,
      status: ValidationQueryStatus.OPEN,
      slaDueDate,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.queryRepository.save(query);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'VALIDATION_QUERY_RAISED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      userId,
      // The assayer the query was actually saved against. This recorded `dto.assayerId`, which
      // is optional — when the caller omits it (or sends the zero-UUID sentinel) the recipient
      // is resolved from the branch's active assignment above, and the trail named "undefined"
      // while the row named a real person.
      remarks: `Raised query to assayer ${resolvedAssayerId}: "${dto.queryText}"`,
      metadata: { assayerId: resolvedAssayerId, validationCaseId: dto.validationCaseId, targetField: dto.targetField ?? null },
    });

    // Create persistent text & push notification for the Assayer
    try {
      // `resolvedAssayerId` is an assayer id. It used to be passed as `userId` into
      // notificationService.create(), which foreign-keys to `users` — so this threw a FK
      // violation that the catch below swallowed, and the assayer was never actually told a
      // clarification had been raised (spec Phase 11). notifyAssayer() handles the id
      // translation and resolves the email itself.
      await this.notificationService.notifyAssayer(
        resolvedAssayerId,
        undefined,
        {
          title: '❓ New Clarification Query Raised',
          message: `Data Entry Team: "${dto.queryText.slice(0, 100)}${dto.queryText.length > 100 ? '...' : ''}"`,
          data: { queryId: saved.id, validationCaseId: saved.validationCaseId },
        },
        userId,
      );
    } catch (err) {
      console.error('Failed to create/send notification for raised query:', err);
    }

    try {
      this.eventPublisher.publish('query:raised', {
        eventType: 'query:raised',
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        assayerId: resolvedAssayerId,
        validatorId: (valCase as any).reviewerId || userId,
        organizationId: (valCase as any).organizationId,
        queryText: dto.queryText,
        targetField: dto.targetField,
        attachments: dto.attachments,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish query:raised event:', err);
    }

    return saved;
  }

  async respondToQuery(queryId: string, assayerResponse: string, userId: string, attachments?: any[]): Promise<ValidationQueryEntity> {
    const query = await this.queryRepository.findOne({ where: { id: queryId, isActive: true } });
    if (!query) throw new NotFoundException(`ValidationQuery ${queryId} not found.`);

    if (query.status !== ValidationQueryStatus.OPEN && query.status !== ValidationQueryStatus.RESPONDED) {
      throw new BadRequestException(`Cannot respond to query in status ${query.status}.`);
    }

    // Append new response as a timestamped chat message if text exists, preserving conversation history
    if (assayerResponse && assayerResponse.trim().length > 0) {
      const timestamp = new Date().toISOString();
      const newMessage = `[${timestamp}] ${assayerResponse.trim()}`;
      query.assayerResponse = query.assayerResponse
        ? `${query.assayerResponse}\n${newMessage}`
        : newMessage;
    }
    query.respondedAt = new Date();
    query.status = ValidationQueryStatus.RESPONDED;
    if (attachments && attachments.length > 0) {
      const existing = (Array.isArray(query.attachments) ? query.attachments : []).flat(Infinity).filter((a: any) => a && a.url);
      const incoming = attachments.flat(Infinity).filter((a: any) => a && a.url);
      query.attachments = [...existing, ...incoming];
      console.log(`[respondToQuery] Saved ${incoming.length} attachments for query ${queryId}`);
    } else {
      console.log(`[respondToQuery] No attachments received for query ${queryId} (attachments=${JSON.stringify(attachments)})`);
    }
    query.updatedBy = userId;

    const saved = await this.queryRepository.save(query);

    /**
     * Mirror the reply into the message thread, which is the channel the web actually reads.
     *
     * The clarification loop ran on two channels that never met. The desk posts into
     * `validation_query_messages` (and `QueryThreadService` mirrors that back onto
     * `assayer_response`), and every web screen — CaseWorkspace, ThreadPanel — renders that
     * table. But this route, the one the mobile app calls, wrote *only* to the
     * `assayer_response` column, which no frontend reads anywhere.
     *
     * The live data shows the consequence exactly: 4 clarifications exist, all 4 have thread
     * messages, and 0 have an `assayer_response`. Every answer an assayer typed went into a
     * column nobody displays. The validator saw silence and the assayer saw their message
     * accepted — the correction loop had no path back.
     */
    try {
      await this.threadService.postMessage(
        saved.id,
        QueryMessageAuthor.ASSAYER,
        userId,
        null,
        {
          body: assayerResponse?.trim() || undefined,
          attachments: attachments?.flat(Infinity).filter((a: any) => a && a.url) ?? undefined,
        } as any,
      );
    } catch (err: any) {
      // Never lose the answer itself over a thread write — but say so loudly, because a
      // silent failure here is precisely the bug being fixed.
      console.error(
        `Query ${saved.id}: assayer reply saved, but it did NOT reach the message thread the desk reads: ${err?.message}`,
      );
    }

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'VALIDATION_QUERY_RESPONDED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      userId,
      remarks: `Assayer responded to query ${queryId}: "${assayerResponse}"`,
    });

    /**
     * Tell the validation desk an answer arrived.
     *
     * `VALIDATION_QUERY_ANSWERED` has existed in the notification catalogue, addressed to the
     * validation roles, with nothing anywhere able to emit it. Raising a query notifies the
     * assayer; answering it notified nobody, so the desk had to keep reopening cases to
     * discover whether a reply had come in. That is the half of the clarification loop that
     * decides how long a case sits open.
     */
    // Resolved the same way createQuery() does: a query hangs off a validation case, and the
    // case carries the project branch, which is what links back to the assignment.
    const valCase = await this.validationCaseRepository
      .findOne({ where: { id: saved.validationCaseId } })
      .catch(() => null);

    const assignment = valCase?.projectBranchId
      ? await this.assignmentRepository
          .findOne({
            where: { projectBranchId: valCase.projectBranchId, isActive: true },
            relations: ['assayer', 'projectBranch', 'projectBranch.branch'],
            order: { createdAt: 'DESC' },
          })
          .catch(() => null)
      : null;

    this.notificationDispatch.emitSafe({
      type: 'VALIDATION_QUERY_ANSWERED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      actorUserId: userId,
      assayerId: query.assayerId ?? null,
      // Not defaulted to the type+id pair: a query can legitimately be answered more than
      // once, and each reply is a distinct thing the desk needs to see.
      dedupeKey: `VALIDATION_QUERY_ANSWERED:${saved.id}:${saved.respondedAt?.toISOString()}`,
      payload: {
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        assayerName: assignment?.assayer?.displayName ?? 'The assayer',
        branchName: assignment?.projectBranch?.branch?.name ?? 'a branch',
      },
    });

    try {
      this.eventPublisher.publish('query:responded', {
        eventType: 'query:responded',
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        assayerId: query.assayerId,
        validatorId: (query as any).validatorId || userId,
        assayerResponse,
        attachments: saved.attachments,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish query:responded event:', err);
    }

    return saved;
  }

  /**
   * Reopen a resolved clarification.
   *
   * A RESOLVED query was permanently frozen — postMessage refuses to add to it — so if the
   * resolution turned out wrong, or the answer needs a follow-up, there was no way back and the
   * desk had to raise a brand-new query, losing the thread. Reopen returns it to OPEN (the ball
   * back with the assayer) so the existing conversation continues.
   */
  async reopenQuery(queryId: string, userId: string): Promise<ValidationQueryEntity> {
    const query = await this.queryRepository.findOne({ where: { id: queryId, isActive: true } });
    if (!query) throw new NotFoundException(`ValidationQuery ${queryId} not found.`);
    if (query.status !== ValidationQueryStatus.RESOLVED) {
      throw new BadRequestException('Only a resolved clarification can be reopened.');
    }

    query.status = ValidationQueryStatus.OPEN;
    query.updatedBy = userId;
    const saved = await this.queryRepository.save(query);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'VALIDATION_QUERY_REOPENED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      userId,
      remarks: `Reopened resolved clarification ${queryId}.`,
    });

    // The assayer is on the hook again — notify them, and refresh any live thread.
    this.notificationDispatch.emitSafe({
      type: 'VALIDATION_QUERY_RAISED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      actorUserId: userId,
      assayerId: query.assayerId ?? null,
      dedupeKey: `VALIDATION_QUERY_REOPENED:${saved.id}:${Date.now()}`,
      payload: { queryId: saved.id, validationCaseId: saved.validationCaseId },
    });
    try {
      this.eventPublisher.publish('query:reopened', {
        eventType: 'query:reopened', queryId: saved.id, validationCaseId: saved.validationCaseId,
        assayerId: query.assayerId, status: saved.status, userId,
      });
    } catch { /* realtime is best-effort */ }

    return saved;
  }

  async resolveQuery(queryId: string, userId: string): Promise<ValidationQueryEntity> {
    const query = await this.queryRepository.findOne({ where: { id: queryId, isActive: true } });
    if (!query) throw new NotFoundException(`ValidationQuery ${queryId} not found.`);

    query.status = ValidationQueryStatus.RESOLVED;
    query.updatedBy = userId;

    const saved = await this.queryRepository.save(query);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'VALIDATION_QUERY_RESOLVED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      userId,
      remarks: `Validator marked query ${queryId} as RESOLVED.`,
    });

    try {
      this.eventPublisher.publish('query:responded', {
        eventType: 'query:responded',
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        assayerId: query.assayerId,
        validatorId: userId,
        status: saved.status,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish query:responded event:', err);
    }

    return saved;
  }

  async countOpenQueries(validationCaseId: string): Promise<number> {
    return this.queryRepository.count({
      where: {
        validationCaseId,
        status: ValidationQueryStatus.OPEN,
        isActive: true,
      },
    });
  }

  async findByValidationCase(validationCaseId: string): Promise<ValidationQueryEntity[]> {
    return this.queryRepository.find({
      where: { validationCaseId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Every clarification across all cases, enriched for a worklist: who it is with (the branch's
   * assayer), which branch/case, whether the ball is with us or the assayer, and its SLA state.
   *
   * The board only ever drew an aggregate open count and per-branch chips, so there was no way
   * to answer "which clarifications are open, whose court are they in, and which are overdue"
   * without walking every case. This is that list.
   */
  async getClarificationWorklist(): Promise<Array<{
    id: string;
    validationCaseId: string;
    projectBranchId: string | null;
    status: string;
    queryText: string;
    targetField: string | null;
    branchName: string | null;
    assayerName: string | null;
    assayerCode: string | null;
    createdAt: string;
    lastMessageAt: string | null;
    slaDueDate: string | null;
    slaOverdue: boolean;
    awaiting: 'US' | 'ASSAYER' | 'DONE';
  }>> {
    const rows = await this.queryRepository.manager.query(
      `SELECT q.id, q.validation_case_id AS "validationCaseId", vc.project_branch_id AS "projectBranchId", q.status,
              q.query_text AS "queryText", q.target_field AS "targetField",
              q.created_at AS "createdAt", q.last_message_at AS "lastMessageAt",
              q.sla_due_date AS "slaDueDate",
              b.name AS "branchName", a.display_name AS "assayerName", a.assayer_code AS "assayerCode"
         FROM validation_queries q
         LEFT JOIN validation_cases vc ON vc.id = q.validation_case_id
         LEFT JOIN project_branches pb ON pb.id = vc.project_branch_id
         LEFT JOIN branches b ON b.id = pb.branch_id
         LEFT JOIN assayers a ON a.id = q.assayer_id
        WHERE q.is_active = true
        ORDER BY q.sla_due_date ASC NULLS LAST, q.created_at DESC`,
    );
    const now = Date.now();
    return rows.map((r: any) => {
      // OPEN → we are waiting on the assayer; RESPONDED → the assayer answered, our move;
      // RESOLVED → done. This split is the whole point of the worklist.
      const awaiting = r.status === 'OPEN' ? 'ASSAYER' : r.status === 'RESPONDED' ? 'US' : 'DONE';
      const slaOverdue = !!r.slaDueDate && r.status !== 'RESOLVED' && new Date(r.slaDueDate).getTime() < now;
      return { ...r, awaiting, slaOverdue };
    });
  }

  async findAllQueries(): Promise<ValidationQueryEntity[]> {
    return this.queryRepository.find({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findByAssayer(assayerId: string): Promise<ValidationQueryEntity[]> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assayerId || '');
    if (!assayerId || !isUuid) {
      throw new BadRequestException('A valid assayerId UUID is required to query validation queries.');
    }
    return this.queryRepository.find({
      where: { assayerId, isActive: true },
      relations: ['validationCase'],
      order: { createdAt: 'DESC' },
    });
  }
}
