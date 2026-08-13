import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeedbackThreadEntity } from './feedback-thread.entity';
import { FeedbackMessageEntity } from './feedback-message.entity';
import { FeedbackAuthorType, FeedbackStatus } from '@fapoms/shared';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

/**
 * Who is acting on a feedback thread, across both identity spaces.
 *
 * A reporter is either an internal `user` or a field `assayer` — exactly one id is
 * set. `isTeam` marks a PRODUCT_SUPPORT / admin principal, who may read every
 * thread, post on any thread, and leave internal (reporter-invisible) notes.
 */
export interface FeedbackActor {
  userId: string | null;
  assayerId: string | null;
  name: string | null;
  isTeam: boolean;
}

export interface PostFeedbackMessageDto {
  body?: string;
  attachments?: { url: string; fileName: string; fileType: string }[];
  /** Team-only note, never shown to the reporter. Ignored for non-team actors. */
  isInternal?: boolean;
}

/**
 * The conversation inside one feedback thread.
 *
 * Kept apart from {@link FeedbackService}, which owns the item's lifecycle
 * (open → acknowledged → in-progress → resolved). This owns the exchange: who said
 * what, read receipts, and telling the other side a message arrived. It mirrors
 * QueryThreadService for the assayer clarification thread, with the reporter/team
 * sides in place of assayer/desk.
 */
@Injectable()
export class FeedbackThreadService {
  constructor(
    @InjectRepository(FeedbackThreadEntity)
    private readonly threadRepository: Repository<FeedbackThreadEntity>,
    @InjectRepository(FeedbackMessageEntity)
    private readonly messageRepository: Repository<FeedbackMessageEntity>,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  /** True when the actor is the reporter of this thread (either identity space). */
  private isReporter(thread: FeedbackThreadEntity, actor: FeedbackActor): boolean {
    return (
      (!!actor.userId && thread.reporterUserId === actor.userId) ||
      (!!actor.assayerId && thread.reporterAssayerId === actor.assayerId)
    );
  }

  private async mustAccess(threadId: string, actor: FeedbackActor): Promise<FeedbackThreadEntity> {
    const thread = await this.threadRepository.findOne({ where: { id: threadId } });
    if (!thread) throw new NotFoundException(`Feedback thread ${threadId} not found.`);
    if (!actor.isTeam && !this.isReporter(thread, actor)) {
      throw new ForbiddenException('You can only view feedback you reported.');
    }
    return thread;
  }

  async listMessages(threadId: string, actor: FeedbackActor): Promise<FeedbackMessageEntity[]> {
    await this.mustAccess(threadId, actor);
    const messages = await this.messageRepository.find({
      where: { feedbackThreadId: threadId },
      order: { createdAt: 'ASC' },
    });
    // Internal notes are the team's back-channel — never surface them to the reporter.
    return actor.isTeam ? messages : messages.filter((m) => !m.isInternal);
  }

  async postMessage(threadId: string, actor: FeedbackActor, dto: PostFeedbackMessageDto): Promise<FeedbackMessageEntity> {
    const thread = await this.mustAccess(threadId, actor);
    const isInternal = actor.isTeam && !!dto.isInternal;

    if (thread.status === FeedbackStatus.CLOSED && !actor.isTeam) {
      throw new ForbiddenException('This item is closed. The team can reopen it if it still needs attention.');
    }
    if (!dto.body?.trim() && !(dto.attachments ?? []).length) {
      throw new ForbiddenException('A message needs text or an attachment.');
    }

    const message = this.messageRepository.create({
      feedbackThreadId: threadId,
      authorType: actor.isTeam ? FeedbackAuthorType.TEAM : FeedbackAuthorType.REPORTER,
      authorUserId: actor.userId,
      authorAssayerId: actor.assayerId,
      authorName: actor.name,
      body: dto.body?.trim() || null,
      attachments: (dto.attachments ?? []).length ? dto.attachments! : null,
      isInternal,
      createdBy: actor.userId ?? actor.assayerId ?? 'system',
      updatedBy: actor.userId ?? actor.assayerId ?? 'system',
    });
    const saved = await this.messageRepository.save(message);

    // An internal note is bookkeeping between team members; it must not move the item's
    // lifecycle or ping the reporter. Everything else does both.
    thread.lastMessageAt = saved.createdAt;
    if (!isInternal) {
      if (actor.isTeam) {
        // The team engaged — an untouched item is now acknowledged.
        if (thread.status === FeedbackStatus.OPEN) thread.status = FeedbackStatus.ACKNOWLEDGED;
        // Stamp the first team reply — this closes the first-response SLA clock. An
        // internal note is not a response to the reporter, so it does not count.
        if (!thread.firstRespondedAt) thread.firstRespondedAt = saved.createdAt;
      } else {
        // The reporter came back on something marked resolved — it evidently was not.
        if (thread.status === FeedbackStatus.RESOLVED) {
          thread.status = FeedbackStatus.ACKNOWLEDGED;
          thread.resolvedAt = null;
          thread.resolvedByUserId = null;
        }
      }
    }
    await this.threadRepository.save(thread);

    if (!isInternal) this.notifyOtherSide(thread, actor, saved);

    try {
      this.eventPublisher.publish('feedback:message', {
        eventType: 'feedback:message',
        threadId: thread.id,
        reporterUserId: thread.reporterUserId,
        reporterAssayerId: thread.reporterAssayerId,
        authorType: saved.authorType,
        status: thread.status,
        isInternal,
        messageId: saved.id,
      });
    } catch { /* realtime is best-effort; the message is already saved */ }

    return saved;
  }

  /** Notify whichever side did not just speak. */
  private notifyOtherSide(thread: FeedbackThreadEntity, actor: FeedbackActor, message: FeedbackMessageEntity): void {
    const payload = {
      threadId: thread.id,
      title: thread.title,
      category: thread.category,
      reporterName: thread.reporterName,
      messageId: message.id,
    };
    if (actor.isTeam) {
      // Team replied → tell the reporter. RECORD_OWNER reaches a user reporter,
      // ASSIGNED_ASSAYER reaches an assayer reporter; only the set one resolves.
      this.notificationDispatch.emitSafe({
        type: 'FEEDBACK_TEAM_REPLY',
        entityType: 'FEEDBACK',
        entityId: thread.id,
        actorUserId: actor.userId ?? undefined,
        ownerUserId: thread.reporterUserId ?? undefined,
        assayerId: thread.reporterAssayerId ?? undefined,
        dedupeKey: `FEEDBACK_TEAM_REPLY:${message.id}`,
        payload,
      });
    } else {
      // Reporter replied → tell the team, and the assigned owner in particular.
      this.notificationDispatch.emitSafe({
        type: 'FEEDBACK_REPORTER_REPLY',
        entityType: 'FEEDBACK',
        entityId: thread.id,
        actorUserId: actor.userId ?? undefined,
        ownerUserId: thread.assignedToUserId ?? undefined,
        dedupeKey: `FEEDBACK_REPORTER_REPLY:${message.id}`,
        payload,
      });
    }
  }

  /**
   * Mark the other side's messages as read for this actor. Read state here is
   * coarse — "has the counterparty's latest been seen" — which is all the unread
   * badge on the thread list needs.
   */
  async markRead(threadId: string, actor: FeedbackActor): Promise<{ updated: number }> {
    await this.mustAccess(threadId, actor);
    const otherSide = actor.isTeam ? FeedbackAuthorType.REPORTER : FeedbackAuthorType.TEAM;
    const result = await this.messageRepository
      .createQueryBuilder()
      .update(FeedbackMessageEntity)
      .set({ isRead: true, readAt: () => 'NOW()' })
      .where('feedback_thread_id = :threadId', { threadId })
      .andWhere('author_type = :otherSide', { otherSide })
      .andWhere('is_read = false')
      .execute();
    return { updated: result.affected ?? 0 };
  }
}
