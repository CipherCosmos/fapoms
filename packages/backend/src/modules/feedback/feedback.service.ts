import { Injectable, Inject, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Brackets } from 'typeorm';

import { FeedbackThreadEntity } from './feedback-thread.entity';
import { FeedbackMessageEntity } from './feedback-message.entity';
import { FeedbackVoteEntity } from './feedback-vote.entity';
import {
  FeedbackCategory,
  FeedbackSeverity,
  FeedbackStatus,
  FeedbackAuthorType,
  EventCategory,
} from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { FeedbackActor } from './feedback-thread.service';
import { FEEDBACK_INTELLIGENCE, FeedbackIntelligence } from './feedback-intelligence';
import { UserEntity } from '../user/user.entity';

/**
 * The roles that receive and triage feedback. Defined once in `feedback-roles.ts` (super
 * administrators only, by decision) and re-exported here for the callers that already import
 * it from the service. Gates the team endpoints and populates the "assign to" list.
 */
import { FEEDBACK_TEAM_ROLES } from './feedback-roles';
export { FEEDBACK_TEAM_ROLES };

export interface CreateFeedbackDto {
  title?: string;
  body: string;
  /** Reporter may pick a category; otherwise the classifier proposes one. */
  category?: FeedbackCategory;
  /** The part of the product the item is about, e.g. 'planning' — usually the page they filed from. */
  area?: string;
  appContext?: Record<string, unknown>;
  attachments?: { url: string; fileName: string; fileType: string }[];
}

export interface TriageFeedbackDto {
  category?: FeedbackCategory;
  severity?: FeedbackSeverity;
  status?: FeedbackStatus;
  /** '' or null clears the assignee; a uuid assigns it. */
  assignedToUserId?: string | null;
  /** Mark this thread a duplicate of another (also moves it to CLOSED). */
  duplicateOfId?: string | null;
  note?: string;
}

export interface TeamQueueQuery {
  page?: number;
  limit?: number;
  status?: FeedbackStatus;
  category?: FeedbackCategory;
  severity?: FeedbackSeverity;
  assignedToUserId?: string; // 'me' resolved by caller; 'none' → unassigned
  search?: string;
  // 'recent' (default) sorts by last activity; 'impact' surfaces the most-voted, most-severe first.
  sort?: 'recent' | 'impact';
}

// Statuses that still need the team's attention — used for queue defaults, duplicate
// scanning and the digest. CLOSED and RESOLVED are settled.
const OPEN_STATUSES = [FeedbackStatus.OPEN, FeedbackStatus.ACKNOWLEDGED, FeedbackStatus.IN_PROGRESS];

@Injectable()
export class FeedbackService {
  constructor(
    @InjectRepository(FeedbackThreadEntity)
    private readonly threadRepository: Repository<FeedbackThreadEntity>,
    @InjectRepository(FeedbackMessageEntity)
    private readonly messageRepository: Repository<FeedbackMessageEntity>,
    @InjectRepository(FeedbackVoteEntity)
    private readonly voteRepository: Repository<FeedbackVoteEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly notificationDispatch: NotificationDispatchService,
    @Inject(FEEDBACK_INTELLIGENCE)
    private readonly intelligence: FeedbackIntelligence,
  ) {}

  // ── Reporter side ──────────────────────────────────────────────────────────

  async create(dto: CreateFeedbackDto, reporter: FeedbackActor): Promise<FeedbackThreadEntity> {
    if (!dto.body?.trim()) throw new BadRequestException('Feedback needs a description.');
    if (!reporter.userId && !reporter.assayerId) throw new BadRequestException('A reporter identity is required.');

    const title = (dto.title?.trim() || this.deriveTitle(dto.body)).slice(0, 200);
    const signal = { title, body: dto.body, area: dto.area ?? null };
    const inferred = this.intelligence.classify(signal);
    const duplicateCandidateIds = await this.findDuplicateCandidates(signal);

    const reporterId = reporter.userId ?? reporter.assayerId!;
    const thread = this.threadRepository.create({
      reporterUserId: reporter.userId,
      reporterAssayerId: reporter.assayerId,
      reporterName: reporter.name || 'A user',
      // A display snapshot ("Nilesh · SUPER_ADMINISTRATOR"), not an authorisation. A team
      // reporter is stamped with the first team role rather than a hardcoded PRODUCT_SUPPORT,
      // which stopped being on the team when the desk narrowed to super administrators.
      reporterRole: reporter.assayerId ? 'ASSAYER' : reporter.isTeam ? FEEDBACK_TEAM_ROLES[0] : null,
      title,
      // The reporter's own category wins when they set one; otherwise trust the classifier.
      category: dto.category ?? inferred.category,
      severity: inferred.severity,
      status: FeedbackStatus.OPEN,
      area: dto.area?.slice(0, 100) ?? null,
      appContext: dto.appContext ?? null,
      lastMessageAt: new Date(),
      aiMeta: {
        suggestedCategory: inferred.category,
        suggestedSeverity: inferred.severity,
        confidence: inferred.confidence,
        keywords: inferred.keywords,
        duplicateCandidateIds,
      },
      createdBy: reporterId,
      updatedBy: reporterId,
    });
    const saved = await this.threadRepository.save(thread);

    // The reporter is the item's first voice — seed their vote so impact counts from one,
    // and so they can't then "me too" their own item to inflate it.
    await this.voteRepository.save(
      this.voteRepository.create({
        feedbackThreadId: saved.id,
        voterUserId: reporter.userId,
        voterAssayerId: reporter.assayerId,
        createdBy: reporterId,
        updatedBy: reporterId,
      }),
    );

    // The reporter's opening description is the thread's first message, so the whole
    // item reads as one conversation rather than a header plus a hidden body.
    await this.messageRepository.save(
      this.messageRepository.create({
        feedbackThreadId: saved.id,
        authorType: FeedbackAuthorType.REPORTER,
        authorUserId: reporter.userId,
        authorAssayerId: reporter.assayerId,
        authorName: reporter.name,
        body: dto.body.trim(),
        attachments: (dto.attachments ?? []).length ? dto.attachments! : null,
        createdBy: reporterId,
        updatedBy: reporterId,
      }),
    );

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'FEEDBACK_CREATED',
      entityType: 'FEEDBACK',
      entityId: saved.id,
      userId: reporter.userId ?? undefined,
      userDisplayName: reporter.name ?? undefined,
      remarks: `${saved.category} reported: "${title}"`,
      metadata: { category: saved.category, severity: saved.severity, area: saved.area, reporterAssayerId: reporter.assayerId },
    });

    this.notificationDispatch.emitSafe({
      type: 'FEEDBACK_SUBMITTED',
      entityType: 'FEEDBACK',
      entityId: saved.id,
      actorUserId: reporter.userId ?? undefined,
      dedupeKey: `FEEDBACK_SUBMITTED:${saved.id}`,
      payload: { threadId: saved.id, title, category: saved.category, severity: saved.severity, reporterName: saved.reporterName },
    });

    this.publish('feedback:new', saved);
    return saved;
  }

  /**
   * Open items similar to what a reporter is about to file, so they can add their
   * voice to an existing one instead of creating a duplicate — dedup at the source.
   * Returns only non-sensitive fields (no reporter identity), the same the reporter
   * would see on any shared item, plus whether the caller has already voted.
   */
  async similar(text: string, actor: FeedbackActor): Promise<Array<{ id: string; title: string; category: FeedbackCategory; severity: FeedbackSeverity; status: FeedbackStatus; voteCount: number; hasVoted: boolean }>> {
    if (!text || text.trim().length < 6) return [];
    const signal = { title: text.slice(0, 120), body: text };
    const open = await this.threadRepository.find({
      where: { status: In(OPEN_STATUSES) } as any,
      order: { createdAt: 'DESC' },
      take: 100,
    });
    const scored = open
      .map((t) => ({ t, score: this.intelligence.similarity(signal, { title: t.title, body: (t.aiMeta?.keywords as string[] | undefined)?.join(' ') ?? t.title }) }))
      .filter((x) => x.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const results = [];
    for (const { t } of scored) {
      results.push({
        id: t.id,
        title: t.title,
        category: t.category,
        severity: t.severity,
        status: t.status,
        voteCount: t.voteCount,
        hasVoted: await this.hasVoted(t.id, actor),
      });
    }
    return results;
  }

  async findMine(reporter: FeedbackActor): Promise<FeedbackThreadEntity[]> {
    const where = reporter.assayerId
      ? { reporterAssayerId: reporter.assayerId }
      : { reporterUserId: reporter.userId! };
    return this.threadRepository.find({ where, order: { lastMessageAt: 'DESC' } });
  }

  // ── Team side ──────────────────────────────────────────────────────────────

  async findAllForTeam(q: TeamQueueQuery): Promise<{ items: FeedbackThreadEntity[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));

    const qb = this.threadRepository.createQueryBuilder('f');
    if (q.status) qb.andWhere('f.status = :status', { status: q.status });
    if (q.category) qb.andWhere('f.category = :category', { category: q.category });
    if (q.severity) qb.andWhere('f.severity = :severity', { severity: q.severity });
    if (q.assignedToUserId === 'none') qb.andWhere('f.assignedToUserId IS NULL');
    else if (q.assignedToUserId) qb.andWhere('f.assignedToUserId = :assignee', { assignee: q.assignedToUserId });
    if (q.search?.trim()) {
      const term = `%${q.search.trim()}%`;
      qb.andWhere(new Brackets((w) => {
        w.where('f.title ILIKE :term', { term }).orWhere('f.reporterName ILIKE :term', { term });
      }));
    }

    if (q.sort === 'impact') {
      // Most people affected first, then the sharper severity, then freshest.
      qb.orderBy('f.voteCount', 'DESC')
        .addOrderBy(`CASE f.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`, 'ASC')
        .addOrderBy('f.lastMessageAt', 'DESC');
    } else {
      qb.orderBy('f.lastMessageAt', 'DESC');
    }

    const [items, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items, total, page, limit };
  }

  /** People a thread can be assigned to: whoever holds a FEEDBACK_TEAM_ROLES role (super administrators). */
  async teamMembers(): Promise<{ id: string; name: string }[]> {
    const rows = await this.userRepository
      .createQueryBuilder('u')
      .innerJoin('u.roles', 'r')
      .where('r.name IN (:...roles)', { roles: FEEDBACK_TEAM_ROLES as unknown as string[] })
      .andWhere('u.status = :status', { status: 'ACTIVE' })
      .andWhere('u.isActive = true')
      .select(['u.id', 'u.displayName', 'u.firstName', 'u.lastName', 'u.username'])
      .distinct(true)
      .getMany();
    return rows.map((u) => ({
      id: u.id,
      name: u.displayName || `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.username,
    }));
  }

  /** Headline counts for the team dashboard. */
  async stats(): Promise<Record<string, unknown>> {
    const rows = await this.threadRepository
      .createQueryBuilder('f')
      .select('f.status', 'status')
      .addSelect('f.category', 'category')
      .addSelect('f.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .groupBy('f.status')
      .addGroupBy('f.category')
      .addGroupBy('f.severity')
      .getRawMany<{ status: FeedbackStatus; category: FeedbackCategory; severity: FeedbackSeverity; count: string }>();

    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.count);
      total += n;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + n;
      byCategory[r.category] = (byCategory[r.category] ?? 0) + n;
      bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + n;
    }

    const openCount = OPEN_STATUSES.reduce((s, st) => s + (byStatus[st] ?? 0), 0);
    const unassigned = await this.threadRepository.count({ where: { status: In(OPEN_STATUSES), assignedToUserId: null } as any });
    const untriaged = byStatus[FeedbackStatus.OPEN] ?? 0;
    const criticalOpen = await this.threadRepository.count({ where: { status: In(OPEN_STATUSES), severity: FeedbackSeverity.CRITICAL } as any });

    return { total, open: openCount, untriaged, unassigned, criticalOpen, byStatus, byCategory, bySeverity };
  }

  /**
   * A digest for the team: what is coming in, what is loudest, what is aging. This
   * is the reporting surface the heuristic feeds today; an LLM implementation would
   * later replace the keyword rollup with real theme extraction while the shape
   * stays the same, so the UI does not change.
   */
  async digest(): Promise<Record<string, unknown>> {
    const open = await this.threadRepository.find({
      where: { status: In(OPEN_STATUSES) } as any,
      order: { lastMessageAt: 'DESC' },
      take: 300,
    });

    // Roll up the keywords the classifier already extracted into themes, weighted so
    // higher-severity reports lift a theme up the list.
    const severityWeight: Record<FeedbackSeverity, number> = {
      [FeedbackSeverity.LOW]: 1,
      [FeedbackSeverity.MEDIUM]: 2,
      [FeedbackSeverity.HIGH]: 3,
      [FeedbackSeverity.CRITICAL]: 5,
    };
    const themes = new Map<string, { term: string; weight: number; count: number; threadIds: string[] }>();
    for (const t of open) {
      const kws = (t.aiMeta?.keywords as string[] | undefined) ?? [];
      for (const kw of kws) {
        const e = themes.get(kw) ?? { term: kw, weight: 0, count: 0, threadIds: [] };
        e.weight += severityWeight[t.severity] ?? 1;
        e.count += 1;
        if (e.threadIds.length < 5) e.threadIds.push(t.id);
        themes.set(kw, e);
      }
    }
    const topThemes = [...themes.values()]
      .filter((e) => e.count > 1) // a theme is more than one voice
      .sort((a, b) => b.weight - a.weight || b.count - a.count)
      .slice(0, 8);

    const now = Date.now();
    const aging = open
      .filter((t) => t.status !== FeedbackStatus.IN_PROGRESS)
      .map((t) => ({ id: t.id, title: t.title, category: t.category, severity: t.severity, status: t.status, ageDays: Math.floor((now - new Date(t.createdAt).getTime()) / 86_400_000), reporterName: t.reporterName }))
      .filter((t) => t.ageDays >= 3)
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, 10);

    const criticalOpen = open
      .filter((t) => t.severity === FeedbackSeverity.CRITICAL)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, reporterName: t.reporterName }));

    return { openCount: open.length, topThemes, aging, criticalOpen };
  }

  // ── Shared ───────────────────────────────────────────────────────────────

  async findOne(id: string, actor: FeedbackActor): Promise<FeedbackThreadEntity & { duplicateCandidates?: FeedbackThreadEntity[]; hasVoted?: boolean }> {
    const thread = await this.threadRepository.findOne({ where: { id } });
    if (!thread) throw new NotFoundException(`Feedback thread ${id} not found.`);
    if (!actor.isTeam) {
      const mine =
        (!!actor.userId && thread.reporterUserId === actor.userId) ||
        (!!actor.assayerId && thread.reporterAssayerId === actor.assayerId);
      if (!mine) throw new ForbiddenException('You can only view feedback you reported.');
      return Object.assign(thread, { hasVoted: await this.hasVoted(id, actor) });
    }
    // The team sees the near-duplicates the classifier flagged, resolved to real rows.
    const candidateIds = (thread.aiMeta?.duplicateCandidateIds as string[] | undefined) ?? [];
    const duplicateCandidates = candidateIds.length
      ? await this.threadRepository.find({ where: { id: In(candidateIds) } })
      : [];
    return Object.assign(thread, { duplicateCandidates, hasVoted: await this.hasVoted(id, actor) });
  }

  /**
   * Add or remove the caller's "me too" on a thread. Returns the fresh count so the
   * UI reflects impact immediately. The denormalised `vote_count` is kept exact by
   * recounting the rows rather than incrementing, so a double-tap can never drift it.
   */
  async vote(id: string, actor: FeedbackActor): Promise<{ voted: boolean; voteCount: number }> {
    const thread = await this.threadRepository.findOne({ where: { id } });
    if (!thread) throw new NotFoundException(`Feedback thread ${id} not found.`);

    const where = actor.assayerId
      ? { feedbackThreadId: id, voterAssayerId: actor.assayerId }
      : { feedbackThreadId: id, voterUserId: actor.userId! };
    const existing = await this.voteRepository.findOne({ where });
    let voted: boolean;
    if (existing) {
      await this.voteRepository.delete(existing.id);
      voted = false;
    } else {
      await this.voteRepository.save(
        this.voteRepository.create({
          feedbackThreadId: id,
          voterUserId: actor.userId,
          voterAssayerId: actor.assayerId,
          createdBy: actor.userId ?? actor.assayerId ?? 'system',
          updatedBy: actor.userId ?? actor.assayerId ?? 'system',
        }),
      );
      voted = true;
    }
    const voteCount = await this.voteRepository.count({ where: { feedbackThreadId: id } });
    await this.threadRepository.update(id, { voteCount });
    return { voted, voteCount };
  }

  /**
   * Move every voter of a duplicate onto the canonical item (skipping anyone who
   * already voted there), then refresh the canonical count. Impact is consolidated,
   * not lost, when duplicates are merged.
   */
  private async mergeVotes(fromThreadId: string, toThreadId: string): Promise<void> {
    await this.voteRepository.query(
      `
      INSERT INTO feedback_votes (id, feedback_thread_id, voter_user_id, voter_assayer_id, version, is_active, created_by, updated_by, created_at, updated_at)
      SELECT uuid_generate_v4(), $2, v.voter_user_id, v.voter_assayer_id, 1, true, 'system', 'system', NOW(), NOW()
      FROM feedback_votes v
      WHERE v.feedback_thread_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM feedback_votes e
          WHERE e.feedback_thread_id = $2
            AND ((e.voter_user_id IS NOT NULL AND e.voter_user_id = v.voter_user_id)
              OR (e.voter_assayer_id IS NOT NULL AND e.voter_assayer_id = v.voter_assayer_id))
        )
      `,
      [fromThreadId, toThreadId],
    );
    const voteCount = await this.voteRepository.count({ where: { feedbackThreadId: toThreadId } });
    await this.threadRepository.update(toThreadId, { voteCount });
  }

  private async hasVoted(id: string, actor: FeedbackActor): Promise<boolean> {
    const where = actor.assayerId
      ? { feedbackThreadId: id, voterAssayerId: actor.assayerId }
      : { feedbackThreadId: id, voterUserId: actor.userId! };
    return (await this.voteRepository.count({ where })) > 0;
  }

  async triage(id: string, dto: TriageFeedbackDto, userId: string): Promise<FeedbackThreadEntity> {
    const thread = await this.threadRepository.findOne({ where: { id } });
    if (!thread) throw new NotFoundException(`Feedback thread ${id} not found.`);

    const before = { category: thread.category, severity: thread.severity, status: thread.status, assignedToUserId: thread.assignedToUserId };
    const statusChanged = dto.status && dto.status !== thread.status;
    const newlyAssigned = dto.assignedToUserId !== undefined && dto.assignedToUserId && dto.assignedToUserId !== thread.assignedToUserId;

    if (dto.category) thread.category = dto.category;
    if (dto.severity) thread.severity = dto.severity;
    if (dto.assignedToUserId !== undefined) thread.assignedToUserId = dto.assignedToUserId || null;
    if (dto.duplicateOfId !== undefined) {
      thread.duplicateOfId = dto.duplicateOfId || null;
      if (dto.duplicateOfId) {
        thread.status = FeedbackStatus.CLOSED; // a duplicate is settled here
        // Roll this item's voters into the canonical one so impact aggregates rather
        // than scattering across duplicates — the whole point of merging.
        await this.mergeVotes(thread.id, dto.duplicateOfId);
      }
    }
    if (dto.status) {
      thread.status = dto.status;
      if (dto.status === FeedbackStatus.RESOLVED) {
        thread.resolvedAt = new Date();
        thread.resolvedByUserId = userId;
      }
    }
    thread.updatedBy = userId;
    const saved = await this.threadRepository.save(thread);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'FEEDBACK_TRIAGED',
      entityType: 'FEEDBACK',
      entityId: saved.id,
      userId,
      remarks: dto.note?.trim() || `Triaged: ${saved.category} / ${saved.severity} / ${saved.status}`,
      previousState: JSON.stringify(before),
      newState: JSON.stringify({ category: saved.category, severity: saved.severity, status: saved.status, assignedToUserId: saved.assignedToUserId }),
    });

    // A triage note is a visible system line so the reporter sees "we're on it".
    if (dto.note?.trim()) {
      await this.messageRepository.save(
        this.messageRepository.create({
          feedbackThreadId: saved.id,
          authorType: FeedbackAuthorType.SYSTEM,
          authorName: 'Product team',
          body: dto.note.trim(),
          createdBy: userId,
          updatedBy: userId,
        }),
      );
    }

    if (newlyAssigned) {
      this.notificationDispatch.emitSafe({
        type: 'FEEDBACK_ASSIGNED',
        entityType: 'FEEDBACK',
        entityId: saved.id,
        actorUserId: userId,
        ownerUserId: saved.assignedToUserId ?? undefined,
        dedupeKey: `FEEDBACK_ASSIGNED:${saved.id}:${saved.assignedToUserId}`,
        payload: { threadId: saved.id, title: saved.title, category: saved.category },
      });
    }
    if (statusChanged) this.notifyReporterStatus(saved, userId);

    this.publish('feedback:updated', saved);
    return saved;
  }

  async resolve(id: string, userId: string, note?: string): Promise<FeedbackThreadEntity> {
    return this.triage(id, { status: FeedbackStatus.RESOLVED, note }, userId);
  }

  async reopen(id: string, userId: string): Promise<FeedbackThreadEntity> {
    const thread = await this.threadRepository.findOne({ where: { id } });
    if (!thread) throw new NotFoundException(`Feedback thread ${id} not found.`);
    thread.resolvedAt = null;
    thread.resolvedByUserId = null;
    await this.threadRepository.save(thread);
    return this.triage(id, { status: FeedbackStatus.ACKNOWLEDGED }, userId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private notifyReporterStatus(thread: FeedbackThreadEntity, actorUserId: string): void {
    this.notificationDispatch.emitSafe({
      type: 'FEEDBACK_STATUS_CHANGED',
      entityType: 'FEEDBACK',
      entityId: thread.id,
      actorUserId,
      ownerUserId: thread.reporterUserId ?? undefined,
      assayerId: thread.reporterAssayerId ?? undefined,
      dedupeKey: `FEEDBACK_STATUS_CHANGED:${thread.id}:${thread.status}`,
      payload: { threadId: thread.id, title: thread.title, status: thread.status },
    });
  }

  private async findDuplicateCandidates(signal: { title: string; body: string; area?: string | null }): Promise<string[]> {
    // Only scan still-open items — a near-match that was already resolved is not a
    // duplicate worth flagging. Cap the scan so submit stays cheap.
    const recent = await this.threadRepository.find({
      where: { status: In(OPEN_STATUSES) } as any,
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return recent
      .map((t) => ({ id: t.id, score: this.intelligence.similarity(signal, { title: t.title, body: (t.aiMeta?.keywords as string[] | undefined)?.join(' ') ?? t.title }) }))
      .filter((c) => c.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((c) => c.id);
  }

  private deriveTitle(body: string): string {
    const firstLine = body.trim().split('\n')[0].trim();
    return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}…`;
  }

  private publish(eventType: string, thread: FeedbackThreadEntity): void {
    try {
      this.eventPublisher.publish(eventType, {
        eventType,
        threadId: thread.id,
        reporterUserId: thread.reporterUserId,
        reporterAssayerId: thread.reporterAssayerId,
        status: thread.status,
        category: thread.category,
        severity: thread.severity,
      });
    } catch { /* realtime is best-effort */ }
  }
}
