import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import {
  EventCategory,
  NotificationChannel,
  NotificationStatus,
} from '@fapoms/shared';
import { NotificationEntity } from './notification.entity';
import { UserEntity } from '../user/user.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NOTIFICATION_CATALOG, renderTemplate } from './notification-catalog';
import { NOTIFICATION_QUEUE } from './notification.constants';

export interface EmitOptions {
  /** A key in `NOTIFICATION_CATALOG`. */
  type: string;
  /** Fills the templates and is stored for deep-linking. */
  payload: Record<string, any>;
  entityType?: string;
  entityId?: string;
  /** Whoever triggered this — excluded from recipients when `skipActor`. */
  actorUserId?: string | null;
  /** Resolves the `ASSIGNED_ASSAYER` recipient. */
  assayerId?: string | null;
  /** Resolves the `RECORD_OWNER` recipient. */
  ownerUserId?: string | null;
  /**
   * Collapses repeats of one logical event. Same key twice = one notification.
   * Defaults to `type:entityId`, which is right for state changes and wrong for
   * anything genuinely repeatable — pass an explicit key there.
   */
  dedupeKey?: string;
}

export interface EmitResult {
  groupKey: string;
  created: number;
  suppressed: number;
  recipients: { userIds: string[]; assayerIds: string[] };
}

/**
 * Turns one business event into the right set of notifications.
 *
 * This is the piece that was missing. Previously a service that wanted to tell
 * someone something had to know *who* — so it either hardcoded a single user id
 * or, far more often, told nobody. Here a service says only what happened, and
 * the catalog plus the live role assignments decide who hears about it.
 *
 * Delivery is split by channel. In-app recipients are `DELIVERED` the moment the
 * row exists — for them the row *is* the delivery, already visible in their
 * bell. Push is handed to `NotificationDeliveryWorker` via the queue, so a slow
 * or unreachable FCM delays a push instead of slowing down, or failing, the
 * business action that raised it.
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly deliveryQueue: Queue,
  ) {}

  /**
   * Every active user holding any of these roles.
   *
   * Locked and inactive accounts are excluded — notifying a suspended user
   * creates an unread count nobody will ever clear, and for the auditor role in
   * particular it would leak operational detail to a disabled account.
   */
  private async usersInRoles(roleNames: string[]): Promise<UserEntity[]> {
    if (!roleNames.length) return [];
    return this.userRepository
      .createQueryBuilder('u')
      .innerJoin('u.roles', 'r')
      .where('r.name IN (:...roleNames)', { roleNames })
      .andWhere('u.is_active = true')
      .andWhere('u.status = :status', { status: 'ACTIVE' })
      .getMany();
  }

  async emit(opts: EmitOptions): Promise<EmitResult> {
    const def = NOTIFICATION_CATALOG[opts.type];
    if (!def) {
      // A typo in an event name must not take down the business action that
      // raised it, but it must not vanish either.
      this.logger.error(`Unknown notification type "${opts.type}" — nothing sent.`);
      return { groupKey: '', created: 0, suppressed: 0, recipients: { userIds: [], assayerIds: [] } };
    }

    const groupKey = `${opts.type}:${opts.entityId ?? 'na'}:${Date.now()}`;
    const dedupeKey = opts.dedupeKey ?? (opts.entityId ? `${opts.type}:${opts.entityId}` : null);

    // ── Resolve recipients ────────────────────────────────────────────────
    const roleUsers = await this.usersInRoles(def.roles);
    const userIds = new Set(roleUsers.map((u) => u.id));

    if (def.special?.includes('RECORD_OWNER') && opts.ownerUserId) {
      userIds.add(opts.ownerUserId);
    }
    if (def.skipActor && opts.actorUserId) {
      userIds.delete(opts.actorUserId);
    }

    const assayerIds: string[] = [];
    if (def.special?.includes('ASSIGNED_ASSAYER') && opts.assayerId) {
      assayerIds.push(opts.assayerId);
    }

    const title = renderTemplate(def.title, opts.payload);
    const message = renderTemplate(def.body, opts.payload);
    const link = def.link ? renderTemplate(def.link, opts.payload) : null;

    /**
     * A row is only born DELIVERED when in-app is the ONLY channel it has — then the row
     * genuinely is the delivery.
     *
     * When it also carries PUSH, it stays PENDING until the queue has sent that push.
     * Marking it DELIVERED up front (because in-app was instant) collided with the delivery
     * worker's terminal-state guard, which refuses to send for a row already DELIVERED — so
     * every notification carrying BOTH channels was silently never pushed. That is almost
     * every assayer-facing type, i.e. exactly the ones whose whole purpose is to reach a
     * phone that is not currently open. Reads are unaffected: `findByUser` filters on
     * isActive/isRead and never on status.
     */
    const inAppOnly = def.channels.includes(NotificationChannel.IN_APP)
      && !def.channels.includes(NotificationChannel.PUSH);
    const initialStatus = inAppOnly ? NotificationStatus.DELIVERED : NotificationStatus.PENDING;

    const base = {
      type: opts.type,
      category: def.category,
      priority: def.priority,
      status: initialStatus,
      channels: def.channels,
      title,
      message,
      link,
      entityType: opts.entityType ?? null,
      entityId: opts.entityId ?? null,
      payload: opts.payload ?? null,
      actorUserId: opts.actorUserId ?? null,
      groupKey,
      // Stamped now only when nothing further has to happen for this to count as delivered;
      // otherwise the delivery worker sets it once the push actually goes out.
      deliveredAt: inAppOnly ? new Date() : null,
      isRead: false,
      attempts: 0,
    };

    const rows: Partial<NotificationEntity>[] = [
      ...[...userIds].map((userId, i) => ({
        ...base,
        userId,
        assayerId: null,
        // Dedupe is per recipient: one event reaching five people is five rows,
        // but the same event re-fired reaches each of them only once.
        dedupeKey: dedupeKey ? `${dedupeKey}:u:${userId}` : null,
      })),
      ...assayerIds.map((assayerId) => ({
        ...base,
        userId: null,
        assayerId,
        dedupeKey: dedupeKey ? `${dedupeKey}:a:${assayerId}` : null,
      })),
    ];

    if (!rows.length) {
      this.logger.warn(`"${opts.type}" resolved to zero recipients — check the catalog roles.`);
      return { groupKey, created: 0, suppressed: 0, recipients: { userIds: [], assayerIds: [] } };
    }

    // `orIgnore` lets the partial unique index on `dedupe_key` absorb repeats
    // without the caller having to pre-check or catch a constraint violation.
    await this.notificationRepository
      .createQueryBuilder()
      .insert()
      .into(NotificationEntity)
      .values(rows as any)
      .orIgnore()
      .execute();

    // `groupKey` is generated fresh above on every call, so it belongs only to
    // rows this exact call actually wrote — a skipped duplicate keeps whichever
    // groupKey its original insert had. Reading it back this way, rather than
    // trusting positional alignment with the insert result's `identifiers`
    // array, is what caught this: `orIgnore` silently had nothing to conflict
    // on for a long stretch (see NotificationEntity's class comment) and every
    // duplicate call still reported a plausible-looking `created` count the
    // whole time, because the row count and the reported count were computed
    // from two different things that happened to agree only by coincidence.
    const createdRows = await this.notificationRepository.find({ where: { groupKey } });
    const created = createdRows.length;
    const suppressed = rows.length - created;

    // ── Real-time ─────────────────────────────────────────────────────────
    // A suppressed duplicate must not re-notify anyone live — that's the whole
    // point of dedupe — so this only fires for rows genuinely just inserted.
    for (const row of createdRows) {
      try {
        this.eventPublisher.publish('notification:new', {
          id: row.id,
          userId: row.userId,
          assayerId: row.assayerId,
          title: row.title,
          message: row.message,
          category: row.category,
          priority: row.priority,
          link: row.link,
          isRead: false,
          createdAt: row.createdAt?.toISOString?.() ?? new Date().toISOString(),
        });
      } catch (err: any) {
        this.logger.warn(`Could not publish real-time notification ${row.id}: ${err?.message}`);
      }
    }

    // ── Hand push delivery to the queue ───────────────────────────────────
    // In-app is already done — the row is the delivery. Only push needs a job.
    // Enqueue failure is logged, never thrown: the row still exists and the
    // stranded-row sweeper will pick it up, so Redis being down delays a push
    // rather than losing it.
    if (def.channels.includes(NotificationChannel.PUSH) && createdRows.length > 0) {
      // One bulk enqueue rather than a Redis round-trip per recipient — a fan-out to a whole role
      // (e.g. every operations user on a project event) was N sequential `add()` calls.
      try {
        await this.deliveryQueue.addBulk(
          createdRows.map((row) => ({
            name: 'deliver',
            data: { notificationId: row.id },
            opts: {
              attempts: 5,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              // Kept so a failed delivery can still be inspected in the queue.
              removeOnFail: false,
            },
          })),
        );
      } catch (err: any) {
        // Never thrown: the rows exist, so the stranded-row sweeper still delivers if Redis is down.
        this.logger.warn(`Could not bulk-enqueue push for ${createdRows.length} notification(s): ${err?.message}`);
      }
    }

    // ── Audit ─────────────────────────────────────────────────────────────
    // A notification that was sent is a fact about the business, not just about
    // the mail system: "nobody told me" is answerable from here.
    try {
      await this.auditService.recordEvent({
        category: EventCategory.SYSTEM,
        eventType: `NOTIFICATION_${opts.type}`,
        entityType: opts.entityType ?? 'NOTIFICATION',
        entityId: opts.entityId ?? groupKey,
        userId: opts.actorUserId ?? undefined,
        remarks: `Notified ${created} recipient(s)${suppressed ? `, ${suppressed} suppressed as duplicate` : ''}: ${title}`,
        metadata: {
          groupKey,
          notificationType: opts.type,
          userIds: [...userIds],
          assayerIds,
          channels: def.channels,
          created,
          suppressed,
        },
      });
    } catch (err: any) {
      // Never let the audit write fail the notification.
      this.logger.warn(`Could not audit notification ${groupKey}: ${err?.message}`);
    }

    return { groupKey, created, suppressed, recipients: { userIds: [...userIds], assayerIds } };
  }

  /**
   * Fire-and-forget wrapper for call sites inside a business transaction.
   *
   * Notification failure must never roll back or block the action that caused
   * it — an assayer's acceptance is still valid if the ops team's alert fails.
   */
  emitSafe(opts: EmitOptions): void {
    this.emit(opts).catch((err) =>
      this.logger.error(`Notification "${opts.type}" failed: ${err?.message}`),
    );
  }
}
