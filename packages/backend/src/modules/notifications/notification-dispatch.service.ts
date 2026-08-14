import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { In, Repository } from 'typeorm';
import {
  EventCategory,
  NotificationChannel,
  NotificationStatus,
} from '@fapoms/shared';
import { NotificationEntity } from './notification.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { UserEntity } from '../user/user.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NOTIFICATION_CATALOG, renderTemplate } from './notification-catalog';
import { NotificationSettingsService, EffectiveNotificationType } from './notification-settings.service';
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
    @InjectRepository(NotificationPreferenceEntity)
    private readonly preferenceRepository: Repository<NotificationPreferenceEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly deliveryQueue: Queue,
    private readonly settings: NotificationSettingsService,
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

  /**
   * Recipients for whom every channel this notification travels on is switched off.
   *
   * Absence of a preference row means opted in — nobody who has never opened the settings screen
   * is muted by omission. Only an explicit `false` counts, and only when it covers every channel
   * the type actually uses: muting push on an in-app-only type changes nothing, and muting in-app
   * on a type that also pushes leaves the push (and the row it is sent from) intact.
   *
   * One query for the whole audience rather than one per recipient: a fan-out to every operations
   * user already resolves N users, and this must not turn that into N round-trips.
   */
  private async fullyMutedRecipients(
    category: string,
    channels: NotificationChannel[],
    userIds: string[],
    assayerIds: string[],
  ): Promise<{ userIds: Set<string>; assayerIds: Set<string> }> {
    const empty = { userIds: new Set<string>(), assayerIds: new Set<string>() };
    if (!userIds.length && !assayerIds.length) return empty;

    const usesInApp = channels.includes(NotificationChannel.IN_APP);
    const usesPush = channels.includes(NotificationChannel.PUSH);
    const usesEmail = channels.includes(NotificationChannel.EMAIL);

    const prefs = await this.preferenceRepository.find({
      where: [
        ...(userIds.length ? [{ userId: In(userIds), category: category as any }] : []),
        ...(assayerIds.length ? [{ assayerId: In(assayerIds), category: category as any }] : []),
      ],
    }).catch((err: any) => {
      // Fail open. A preferences lookup that errors must not silence an escalation; the worst
      // case here is one notification somebody had muted, not a missing one.
      this.logger.warn(`Could not read notification preferences: ${err?.message}`);
      return [] as NotificationPreferenceEntity[];
    });

    const result = { userIds: new Set<string>(), assayerIds: new Set<string>() };
    for (const pref of prefs) {
      // Email only reaches internal users, so for an assayer the email channel can never be
      // the one keeping them audible — treating it as "on" for them would let an EMAIL-carrying
      // type resurrect an assayer who muted in-app and push.
      const emailSilent = pref.userId ? pref.email === false : true;
      const silent =
        (!usesInApp || pref.inApp === false) &&
        (!usesPush || pref.push === false) &&
        (!usesEmail || emailSilent);
      if (!silent) continue;
      if (pref.userId) result.userIds.add(pref.userId);
      if (pref.assayerId) result.assayerIds.add(pref.assayerId);
    }
    return result;
  }

  /**
   * Fold one event into a recipient's still-open notification of the same type, if there is one.
   *
   * "Still open" means unread, not deleted, and created inside the type's collapse window. Unread
   * is the important half: once somebody has read "New assayer onboarded", the next one is news
   * again and deserves its own line — merging into a read row would silently resurrect it.
   *
   * The surviving row keeps the first event's identity (`entityId`, and the payload the summary
   * renders from). Its text becomes the summary, its link the summary link, and its count goes
   * up. Returns true when the event was absorbed.
   *
   * Concurrency: bursts arrive from one bulk request in sequence, and a lost update here costs an
   * extra notification, never a missing one — so this is deliberately a read-then-write rather
   * than a lock. `collapsed_count` is incremented in SQL so parallel merges still add up.
   */
  private async mergeIntoOpenBurst(
    row: Partial<NotificationEntity>,
    def: (typeof NOTIFICATION_CATALOG)[string],
    payload: Record<string, any>,
  ): Promise<boolean> {
    const collapse = def.collapse!;
    const since = new Date(Date.now() - collapse.windowSeconds * 1000);

    try {
      const open = await this.notificationRepository
        .createQueryBuilder('n')
        .where('n.type = :type', { type: row.type })
        .andWhere(row.userId ? 'n.userId = :rid' : 'n.assayerId = :rid', {
          rid: row.userId ?? row.assayerId,
        })
        .andWhere('n.isRead = false')
        .andWhere('n.isActive = true')
        .andWhere('n.createdAt >= :since', { since })
        .orderBy('n.createdAt', 'DESC')
        .getOne();

      if (!open) return false;

      const count = (open.collapsedCount ?? 1) + 1;
      // Rendered from the FIRST event's payload plus the running count: a summary describes the
      // burst, and naming only the latest of 25 would be arbitrary and misleading.
      const summaryPayload = { ...(open.payload ?? {}), ...payload, count };

      await this.notificationRepository
        .createQueryBuilder()
        .update(NotificationEntity)
        .set({
          collapsedCount: () => '"collapsed_count" + 1',
          title: renderTemplate(collapse.title, summaryPayload),
          message: renderTemplate(collapse.body, summaryPayload),
          link: collapse.link
            ? renderTemplate(collapse.link, summaryPayload)
            : open.link,
        })
        .where('id = :id', { id: open.id })
        .execute();

      return true;
    } catch (err: any) {
      // Fail open: an error here must cost a tidier inbox, never the notification itself.
      this.logger.warn(`Could not collapse "${row.type}" into an open burst: ${err?.message}`);
      return false;
    }
  }

  async emit(opts: EmitOptions): Promise<EmitResult> {
    if (!NOTIFICATION_CATALOG[opts.type]) {
      // A typo in an event name must not take down the business action that
      // raised it, but it must not vanish either.
      this.logger.error(`Unknown notification type "${opts.type}" — nothing sent.`);
      return { groupKey: '', created: 0, suppressed: 0, recipients: { userIds: [], assayerIds: [] } };
    }

    /**
     * The live definition, not the compiled-in one: an operator can switch a type off or
     * re-route its channels from the admin screen, and that has to bite on the very next
     * event. `defFor` returns null for a type somebody has disabled.
     */
    let def: EffectiveNotificationType | null;
    try {
      def = await this.settings.defFor(opts.type);
    } catch (err: any) {
      /**
       * The fallback belongs HERE and nowhere else.
       *
       * `defFor` returns null for a type an operator has switched off — a legitimate answer,
       * not a failure. Written as `defFor(...).catch(() => null) ?? CATALOG[type]` the two
       * cases collapse: the `??` cannot tell "disabled" from "lookup broke", so it resurrected
       * every disabled event from the shipped catalog and the off switch did nothing at all.
       * Only a thrown error means the settings are unreadable, and only then is falling back to
       * the compiled-in default the right answer.
       */
      this.logger.warn(`Notification settings unreadable for "${opts.type}", using the shipped default: ${err?.message}`);
      def = NOTIFICATION_CATALOG[opts.type] as EffectiveNotificationType;
    }

    if (!def) {
      this.logger.debug(`"${opts.type}" is switched off in notification settings — nothing sent.`);
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

    /**
     * Drop anyone who has muted every channel this type travels on.
     *
     * Preferences were half-enforced: the delivery worker honoured `push`, and nothing anywhere
     * honoured `inApp`. So a user who turned a category off — through a confirmation dialog that
     * promises "you will stop seeing these in your notification bell entirely" — kept receiving
     * every one of them. The setting existed, was saved, and did nothing.
     *
     * Only a recipient with NO channel left is dropped here. In-app off but push on still needs
     * the row, because the row is what the push is sent from; that recipient's bell filtering
     * happens on read (NotificationService.findByUser), which is where "don't show me this"
     * belongs.
     */
    const muted = await this.fullyMutedRecipients(def.category, def.channels, [...userIds], assayerIds);
    for (const id of muted.userIds) userIds.delete(id);
    const audienceAssayerIds = assayerIds.filter((id) => !muted.assayerIds.has(id));

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

    /**
     * Email bookkeeping is stamped at birth, and only for internal users — assayers have the
     * app; their channels are in-app and push.
     *
     * Whether a mailer is configured is deliberately NOT decided here. This service runs in
     * whichever replica handled the request; the send happens in whichever replica drains the
     * queue, and those are not the same process. An emitter that stamped SUPPRESSED because
     * its own env lacked the credentials would permanently silence a row a properly configured
     * worker could have delivered. The worker settles SUPPRESSED with the reason when it finds
     * no transport, so "why did no email arrive" is still answerable from the row — just
     * answered by the process that actually knows.
     */
    const emailBirth = def.channels.includes(NotificationChannel.EMAIL)
      ? { emailStatus: NotificationStatus.PENDING }
      : { emailStatus: null };

    const rows: Partial<NotificationEntity>[] = [
      ...[...userIds].map((userId, i) => ({
        ...base,
        ...emailBirth,
        userId,
        assayerId: null,
        // Dedupe is per recipient: one event reaching five people is five rows,
        // but the same event re-fired reaches each of them only once.
        dedupeKey: dedupeKey ? `${dedupeKey}:u:${userId}` : null,
      })),
      ...audienceAssayerIds.map((assayerId) => ({
        ...base,
        emailStatus: null,
        userId: null,
        assayerId,
        dedupeKey: dedupeKey ? `${dedupeKey}:a:${assayerId}` : null,
      })),
    ];

    if (!rows.length) {
      this.logger.warn(`"${opts.type}" resolved to zero recipients — check the catalog roles.`);
      return { groupKey, created: 0, suppressed: 0, recipients: { userIds: [], assayerIds: [] } };
    }

    /**
     * Merge into a recipient's open notification of this type when one is still inside the
     * collapse window, instead of adding another line saying the same thing.
     *
     * Runs before the insert so a merged event never becomes a row at all — which is what keeps
     * the push count down too, since pushes are enqueued from inserted rows.
     */
    let merged = 0;
    if (def.collapse) {
      const remaining: Partial<NotificationEntity>[] = [];
      for (const row of rows) {
        const mergedInto = await this.mergeIntoOpenBurst(row, def, opts.payload);
        if (mergedInto) merged++;
        else remaining.push(row);
      }
      rows.length = 0;
      rows.push(...remaining);

      if (!rows.length) {
        // Everything merged: a real outcome, not a no-op, so it is reported as such.
        return {
          groupKey,
          created: 0,
          suppressed: merged,
          recipients: { userIds: [...userIds], assayerIds: audienceAssayerIds },
        };
      }
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

    // ── Hand email delivery to the queue ──────────────────────────────────
    // Same contract as push: the row is the source of truth, the queue is a cache of pending
    // work, and the sweeper re-queues anything the enqueue missed.
    const emailRows = createdRows.filter((row) => row.emailStatus === NotificationStatus.PENDING);
    if (emailRows.length > 0) {
      try {
        await this.deliveryQueue.addBulk(
          emailRows.map((row) => ({
            name: 'deliver-email',
            data: { notificationId: row.id },
            opts: {
              attempts: 5,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              removeOnFail: false,
            },
          })),
        );
      } catch (err: any) {
        this.logger.warn(`Could not bulk-enqueue email for ${emailRows.length} notification(s): ${err?.message}`);
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
