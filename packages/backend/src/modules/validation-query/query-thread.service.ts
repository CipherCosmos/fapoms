import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationQueryMessageEntity, QueryMessageAuthor } from './validation-query-message.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ValidationQueryStatus } from '@fapoms/shared';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

export interface PostMessageDto {
  body?: string;
  attachments?: { url: string; fileName: string; fileType: string }[];
  pageNumber?: number;
  region?: { x: number; y: number; w: number; h: number };
  snapshotPath?: string;
  replyToMessageId?: string;
  annotations?: { type: string; color: string; coords: any; text?: string }[];
  voiceNote?: { url: string; durationSeconds: number; mimeType?: string };
}

/**
 * The clarification conversation between the data entry desk and the assayer.
 *
 * Kept apart from ValidationQueryService, which owns the query's *lifecycle*
 * (open → responded → resolved). This owns the exchange inside it.
 */
@Injectable()
export class QueryThreadService {
  constructor(
    @InjectRepository(ValidationQueryEntity)
    private readonly queryRepository: Repository<ValidationQueryEntity>,
    @InjectRepository(ValidationQueryMessageEntity)
    private readonly messageRepository: Repository<ValidationQueryMessageEntity>,
    @InjectRepository(ValidationCaseEntity)
    private readonly validationCaseRepository: Repository<ValidationCaseEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  /**
   * Resolve the assayer name, branch name and assignment id a query notification needs, the same
   * way ValidationQueryService does — via the case's project branch and its active assignment.
   * The templates fall back to "—" for anything missing, so a best-effort empty result still
   * delivers a usable notification.
   */
  private async notificationContext(query: ValidationQueryEntity): Promise<{ assayerName: string; branchName: string; assignmentId: string | null }> {
    const valCase = await this.validationCaseRepository
      .findOne({ where: { id: query.validationCaseId } })
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
    return {
      assayerName: assignment?.assayer?.displayName ?? 'The assayer',
      branchName: assignment?.projectBranch?.branch?.name ?? 'a branch',
      assignmentId: assignment?.id ?? null,
    };
  }

  async listMessages(queryId: string): Promise<ValidationQueryMessageEntity[]> {
    await this.mustExist(queryId);
    return this.messageRepository.find({
      where: { validationQueryId: queryId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Appends a message and moves the query's status to match who spoke: an assayer
   * reply marks it RESPONDED, a desk follow-up re-opens it. A resolved thread is
   * closed — reopening is a deliberate act, not a side effect of typing.
   */
  async postMessage(
    queryId: string,
    authorType: QueryMessageAuthor,
    authorId: string,
    authorName: string | null,
    dto: PostMessageDto,
  ): Promise<ValidationQueryMessageEntity> {
    const query = await this.mustExist(queryId);

    if (query.status === ValidationQueryStatus.RESOLVED) {
      throw new ForbiddenException('This clarification is resolved. Reopen it before adding to the thread.');
    }
    if (authorType === QueryMessageAuthor.ASSAYER && query.assayerId !== authorId) {
      throw new ForbiddenException('You may only reply to your own clarifications.');
    }
    if (!dto.body?.trim() && !dto.snapshotPath && !(dto.attachments ?? []).length && !dto.voiceNote) {
      throw new ForbiddenException('A message needs text, a snapshot, an attachment, or a voice note.');
    }

    let replyToSummary: { authorName: string; body: string } | null = null;
    if (dto.replyToMessageId) {
      const quoted = await this.messageRepository.findOne({ where: { id: dto.replyToMessageId, validationQueryId: queryId } });
      if (quoted) {
        replyToSummary = {
          authorName: quoted.authorName || (quoted.authorType === QueryMessageAuthor.ASSAYER ? 'Assayer' : 'Validator'),
          body: quoted.body || (quoted.snapshotPath ? '[Document Snippet]' : (quoted.voiceNote ? '[Voice Note]' : '[Attachment]')),
        };
      }
    }

    const message = this.messageRepository.create({
      validationQueryId: queryId,
      authorType,
      authorId,
      authorName,
      body: dto.body?.trim() || null,
      attachments: dto.attachments ?? null,
      pageNumber: dto.pageNumber ?? null,
      region: dto.region ?? null,
      snapshotPath: dto.snapshotPath ?? null,
      replyToMessageId: dto.replyToMessageId ?? null,
      replyToSummary,
      annotations: dto.annotations ?? null,
      voiceNote: dto.voiceNote ?? null,
      createdBy: authorId,
      updatedBy: authorId,
    });
    const saved = await this.messageRepository.save(message);

    query.lastMessageAt = saved.createdAt;
    // The desk points the assayer at a marked crop on the packet. That lives on the
    // *message* (snapshotPath), but the mobile chat reads attachments off the query —
    // so mirror the crop onto the query's attachment list, otherwise the assayer
    // never sees the image the desk is talking about.
    if (authorType === QueryMessageAuthor.STAFF && saved.snapshotPath) {
      const existing = Array.isArray(query.attachments) ? query.attachments : [];
      query.attachments = [
        ...existing,
        {
          url: saved.snapshotPath,
          fileName: saved.pageNumber ? `Marked area on page ${saved.pageNumber}` : 'Marked area',
          fileType: 'image/png',
          uploadedBy: 'VALIDATOR',
          timestamp: saved.createdAt?.toISOString?.() ?? new Date().toISOString(),
        },
      ];
    }
    if (authorType === QueryMessageAuthor.ASSAYER) {
      query.status = ValidationQueryStatus.RESPONDED;
      query.respondedAt = saved.createdAt;
      // Keep the legacy single-answer field aligned so older readers still work.
      if (saved.body) query.assayerResponse = saved.body;
    } else if (query.status === ValidationQueryStatus.RESPONDED) {
      query.status = ValidationQueryStatus.OPEN;
    }
    await this.queryRepository.save(query);

    /**
     * Tell the other side a message arrived.
     *
     * This is the message path BOTH clients actually use — the mobile assayer and the web desk
     * post here — yet it emitted nothing, so an assayer's answer reached the database and the
     * desk was never told. The notifying code lived only in the legacy /respond route that
     * nothing calls. Without this, the "chat with the assayer" loop is one-way: the desk finds
     * a reply only by reopening the case by hand.
     */
    const ctx = await this.notificationContext(query);
    if (authorType === QueryMessageAuthor.ASSAYER) {
      // The assayer answered — the ball is now in the desk's court.
      this.notificationDispatch.emitSafe({
        type: 'VALIDATION_QUERY_ANSWERED',
        entityType: 'VALIDATION_QUERY',
        entityId: query.id,
        actorUserId: authorId,
        assayerId: query.assayerId ?? null,
        // A query can be answered more than once; each reply is its own event.
        dedupeKey: `VALIDATION_QUERY_ANSWERED:${saved.id}:${saved.createdAt?.toISOString?.() ?? ''}`,
        payload: { queryId: query.id, validationCaseId: query.validationCaseId, messageId: saved.id, assayerName: ctx.assayerName, branchName: ctx.branchName },
      });
    } else {
      // The desk added to the thread — the assayer needs to see it and reply.
      this.notificationDispatch.emitSafe({
        type: 'VALIDATION_QUERY_RAISED',
        entityType: 'VALIDATION_QUERY',
        entityId: query.id,
        actorUserId: authorId,
        assayerId: query.assayerId ?? null,
        dedupeKey: `VALIDATION_QUERY_MESSAGE:${saved.id}`,
        payload: { queryId: query.id, validationCaseId: query.validationCaseId, messageId: saved.id, branchName: ctx.branchName, assignmentId: ctx.assignmentId },
      });
    }

    try {
      this.eventPublisher.publish('query:message', {
        eventType: 'query:message',
        queryId: query.id,
        validationCaseId: query.validationCaseId,
        assayerId: query.assayerId ?? null,
        authorType,
        status: query.status,
        messageId: saved.id,
      });
    } catch { /* realtime is best-effort; the message is already saved */ }

    return saved;
  }

  async addReaction(messageId: string, emoji: string, userId: string, userName: string): Promise<ValidationQueryMessageEntity> {
    const msg = await this.messageRepository.findOne({ where: { id: messageId } });
    if (!msg) throw new NotFoundException(`Message ${messageId} not found`);

    const existing = msg.reactions || [];
    const filtered = existing.filter((r) => !(r.userId === userId && r.emoji === emoji));
    filtered.push({ emoji, userId, userName, timestamp: new Date().toISOString() });
    msg.reactions = filtered;
    return this.messageRepository.save(msg);
  }

  async removeReaction(messageId: string, emoji: string, userId: string): Promise<ValidationQueryMessageEntity> {
    const msg = await this.messageRepository.findOne({ where: { id: messageId } });
    if (!msg) throw new NotFoundException(`Message ${messageId} not found`);

    const existing = msg.reactions || [];
    msg.reactions = existing.filter((r) => !(r.userId === userId && r.emoji === emoji));
    return this.messageRepository.save(msg);
  }

  async markThreadAsRead(queryId: string, userId: string): Promise<{ updatedCount: number }> {
    await this.mustExist(queryId);
    const unread = await this.messageRepository.find({
      where: { validationQueryId: queryId, isRead: false },
    });
    const target = unread.filter((m) => m.authorId !== userId);
    if (!target.length) return { updatedCount: 0 };

    const now = new Date();
    for (const m of target) {
      m.isRead = true;
      m.readAt = now;
    }
    await this.messageRepository.save(target);
    return { updatedCount: target.length };
  }

  async toggleStarMessage(messageId: string): Promise<ValidationQueryMessageEntity> {
    const msg = await this.messageRepository.findOne({ where: { id: messageId } });
    if (!msg) throw new NotFoundException(`Message ${messageId} not found`);
    msg.isStarred = !msg.isStarred;
    return this.messageRepository.save(msg);
  }

  private async mustExist(queryId: string): Promise<ValidationQueryEntity> {
    const query = await this.queryRepository.findOne({ where: { id: queryId } });
    if (!query) throw new NotFoundException(`Clarification ${queryId} not found`);
    return query;
  }
}
