import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
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

/** Which slice of the worklist a caller wants. Mirrored by the tabs on the clarifications page. */
export type ClarificationFilter = 'US' | 'ASSAYER' | 'OVERDUE' | 'DONE' | 'ALL';

/**
 * The worklist is a window, not the table.
 *
 * `validation_queries` is append-only and never pruned, so "every clarification, enriched with
 * four joins" grew without limit — and the page then filtered it in the browser, shipping every
 * resolved clarification ever raised on each load.
 */
const CLARIFICATION_PAGE_DEFAULT = 100;
const CLARIFICATION_PAGE_MAX = 200;

@Injectable()
export class ValidationQueryService {
  private readonly logger = new Logger(ValidationQueryService.name);

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
      status: ValidationQueryStatus.OPEN,
      slaDueDate,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.queryRepository.save(query);

    /**
     * Seed the question as the thread's first message.
     *
     * The opening question lived only on `validation_queries.query_text`, while every thread view
     * — CaseWorkspace, ThreadPanel, `GET :id/messages` — reads `validation_query_messages`. So a
     * freshly-raised clarification showed "No messages yet in this clarification thread" to the
     * very person who had just typed it, and once the assayer replied the thread read as an answer
     * to nothing: a gross-weight figure with no visible question above it.
     *
     * The reply path already mirrors into the thread for exactly this reason (see `respond`
     * below); the opening question was the half that never did. Best-effort, like that mirror:
     * losing the message must not lose the clarification itself, which is still delivered to the
     * assayer via `queryText` on their list endpoint.
     */
    try {
      await this.threadService.postMessage(
        saved.id,
        QueryMessageAuthor.STAFF,
        userId,
        null,
        {
          body: dto.queryText,
          attachments: rawAttachments.length > 0 ? rawAttachments : undefined,
        } as any,
      );
    } catch (err: any) {
      this.logger.error(
        `Clarification ${saved.id} was raised but its opening question could not be seeded into ` +
          `the thread: ${err?.message ?? err}. The assayer still receives it as queryText.`,
      );
    }

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

    /**
     * One notification for one question.
     *
     * This used to hand-roll `notificationService.notifyAssayer(...)` here while `reopenQuery`
     * — the same `VALIDATION_QUERY_RAISED` event, one status later — went through the catalog.
     * Two code paths for one thing, and only one of them had role fan-out, push preferences,
     * dedupe and a working deep link. The catalog emit is the one kept; the hand-rolled call
     * carried nothing it does not, since the query text is already on the thread the link opens.
     */
    // Same resolution the worklist uses: case → project branch → branch/assignment.
    const assignment = await this.assignmentRepository
      .findOne({
        where: { projectBranchId: valCase.projectBranchId, isActive: true },
        relations: ['projectBranch', 'projectBranch.branch'],
        order: { createdAt: 'DESC' },
      })
      .catch(() => null);

    this.notificationDispatch.emitSafe({
      type: 'VALIDATION_QUERY_RAISED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      actorUserId: userId,
      assayerId: resolvedAssayerId,
      dedupeKey: `VALIDATION_QUERY_RAISED:${saved.id}`,
      payload: {
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        branchName: assignment?.projectBranch?.branch?.name ?? 'a branch',
        assignmentId: assignment?.id ?? '',
      },
    });

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

    /**
     * The reply itself goes to the thread below, not onto this row.
     *
     * This used to append `[timestamp] text` lines into an `assayer_response` column while the
     * web route overwrote that same column with just the latest body — two writers, two
     * incompatible formats, and no screen rendering either of them. Attachments were copied
     * here too, alongside the copies already hanging off their own messages. The row now
     * records only that an answer arrived and when.
     */
    query.respondedAt = new Date();
    query.status = ValidationQueryStatus.RESPONDED;
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
    const reopenCase = await this.validationCaseRepository
      .findOne({ where: { id: saved.validationCaseId } })
      .catch(() => null);
    const reopenAssignment = reopenCase?.projectBranchId
      ? await this.assignmentRepository
          .findOne({
            where: { projectBranchId: reopenCase.projectBranchId, isActive: true },
            relations: ['projectBranch', 'projectBranch.branch'],
            order: { createdAt: 'DESC' },
          })
          .catch(() => null)
      : null;

    this.notificationDispatch.emitSafe({
      type: 'VALIDATION_QUERY_RAISED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      actorUserId: userId,
      assayerId: query.assayerId ?? null,
      dedupeKey: `VALIDATION_QUERY_REOPENED:${saved.id}:${Date.now()}`,
      // The template names the branch and links by assignment; without these two the assayer
      // reads "A question was raised on your report for ." and the link goes nowhere.
      payload: {
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        branchName: reopenAssignment?.projectBranch?.branch?.name ?? 'a branch',
        assignmentId: reopenAssignment?.id ?? '',
      },
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

    // Resolving an already-resolved query was silently repeated: a second audit row, a second
    // socket event, and now a second notification to the assayer for a thread that closed once.
    if (query.status === ValidationQueryStatus.RESOLVED) return query;

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

    /**
     * Tell the assayer it is closed.
     *
     * Raising a query notified them and answering notified the desk, but closing told nobody —
     * so from the field the thread just stopped, and `QueryThreadService` then refuses any
     * further message on it with a 403. Same resolution the raise path uses, so the notification
     * carries the branch name and opens the same screen.
     */
    const closedCase = await this.validationCaseRepository
      .findOne({ where: { id: saved.validationCaseId } })
      .catch(() => null);
    const closedOn = closedCase?.projectBranchId
      ? await this.assignmentRepository
          .findOne({
            where: { projectBranchId: closedCase.projectBranchId, isActive: true },
            relations: ['projectBranch', 'projectBranch.branch'],
            order: { createdAt: 'DESC' },
          })
          .catch(() => null)
      : null;

    this.notificationDispatch.emitSafe({
      type: 'VALIDATION_QUERY_RESOLVED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      actorUserId: userId,
      assayerId: saved.assayerId,
      dedupeKey: `VALIDATION_QUERY_RESOLVED:${saved.id}`,
      payload: {
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        branchName: closedOn?.projectBranch?.branch?.name ?? 'a branch',
        assignmentId: closedOn?.id ?? '',
      },
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

  /**
   * The assayer a clarification belongs to — for the controller's ownership check on the read
   * routes. Returns `undefined` when the query does not exist (distinct from a null owner).
   */
  async ownerAssayerId(queryId: string): Promise<string | null | undefined> {
    const q = await this.queryRepository.findOne({
      where: { id: queryId, isActive: true },
      select: { id: true, assayerId: true },
    });
    return q ? q.assayerId : undefined;
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
  async getClarificationWorklist(opts: { filter?: ClarificationFilter; limit?: number } = {}): Promise<{
    items: Array<{
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
    }>;
    /** Counts across the whole worklist, not the page — these draw the tabs. */
    counts: { US: number; ASSAYER: number; DONE: number; OVERDUE: number; total: number };
    limit: number;
  }> {
    const filter: ClarificationFilter = opts.filter ?? 'ALL';
    const limit = Math.min(CLARIFICATION_PAGE_MAX, Math.max(1, Number(opts.limit) || CLARIFICATION_PAGE_DEFAULT));

    /**
     * Whose court a clarification is in, as SQL.
     *
     * OPEN → waiting on the assayer; RESPONDED → they answered, our move; RESOLVED → done. The
     * same split the rows are mapped with below, expressed once here so the tab counts and the
     * filtered list cannot disagree.
     */
    const AWAITING = `CASE WHEN q.status = 'OPEN' THEN 'ASSAYER'
                           WHEN q.status = 'RESPONDED' THEN 'US'
                           ELSE 'DONE' END`;
    const OVERDUE = `(q.sla_due_date IS NOT NULL AND q.status <> 'RESOLVED' AND q.sla_due_date < NOW())`;

    // One grouped pass for the tabs. The page used to fetch every clarification ever raised —
    // including every resolved one, forever — and count them in the browser.
    const countRow = await this.queryRepository.manager.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ${AWAITING} = 'US')::int       AS us,
              COUNT(*) FILTER (WHERE ${AWAITING} = 'ASSAYER')::int  AS assayer,
              COUNT(*) FILTER (WHERE ${AWAITING} = 'DONE')::int     AS done,
              COUNT(*) FILTER (WHERE ${OVERDUE})::int               AS overdue
         FROM validation_queries q
        WHERE q.is_active = true`,
    );
    const c = countRow?.[0] ?? {};
    const counts = {
      US: Number(c.us ?? 0),
      ASSAYER: Number(c.assayer ?? 0),
      DONE: Number(c.done ?? 0),
      OVERDUE: Number(c.overdue ?? 0),
      total: Number(c.total ?? 0),
    };

    const filterSql =
      filter === 'OVERDUE' ? `AND ${OVERDUE}`
      : filter === 'ALL' ? ''
      : `AND ${AWAITING} = '${filter}'`;

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
        WHERE q.is_active = true ${filterSql}
        -- Soonest deadline first: what is left off the end is what can wait longest.
        ORDER BY q.sla_due_date ASC NULLS LAST, q.created_at DESC, q.id DESC
        LIMIT ${limit}`,
    );
    const now = Date.now();
    const items = rows.map((r: any) => {
      // Same split as `AWAITING` above — kept here because the row shape is what the page reads.
      const awaiting = r.status === 'OPEN' ? 'ASSAYER' : r.status === 'RESPONDED' ? 'US' : 'DONE';
      const slaOverdue = !!r.slaDueDate && r.status !== 'RESOLVED' && new Date(r.slaDueDate).getTime() < now;
      return { ...r, awaiting, slaOverdue };
    });

    return { items, counts, limit };
  }

  /**
   * Paginated list of active validation queries, newest first.
   *
   * This table is append-only and never pruned, so an unbounded `find()` grew
   * heavier with every clarification ever raised. Defaults to the first 50 rows;
   * `limit` is clamped to a sane 1..200 window so a caller can't ask for the
   * whole table back in one request.
   */
  async findAllQueries(
    page = 1,
    limit = 50,
  ): Promise<{ items: ValidationQueryEntity[]; total: number; page: number; limit: number }> {
    const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200);
    const safePage = Math.max(Math.trunc(Number(page)) || 1, 1);
    const [items, total] = await this.queryRepository.findAndCount({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
      take: safeLimit,
      skip: (safePage - 1) * safeLimit,
    });
    return { items, total, page: safePage, limit: safeLimit };
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
