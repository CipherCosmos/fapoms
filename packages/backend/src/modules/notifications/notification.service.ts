import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationCategory, NotificationStatus } from '@fapoms/shared';
import { NotificationEntity } from './notification.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { UserEntity } from '../user/user.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { PushNotificationService } from './push-notification.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

export interface CreateNotificationDto {
  userId: string;
  title: string;
  message: string;
  link?: string;
  data?: Record<string, string>;
}

export interface FindNotificationsOptions {
  category?: NotificationCategory;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface NotificationPage {
  items: NotificationEntity[];
  total: number;
  unreadCount: number;
}

/** Every category a recipient can set a preference for — the fixed set the catalog uses. */
export const ALL_NOTIFICATION_CATEGORIES = Object.values(NotificationCategory);

export interface PreferenceRow {
  category: NotificationCategory;
  inApp: boolean;
  push: boolean;
  email: boolean;
}

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
    @InjectRepository(NotificationPreferenceEntity)
    private readonly preferenceRepository: Repository<NotificationPreferenceEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    private readonly pushNotificationService: PushNotificationService,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  /**
   * Notifies an assayer, given an **assayer** id.
   *
   * Assayers and users are separate identity spaces: assayers authenticate straight from the
   * `assayers` table, but `notifications.user_id` is a foreign key into `users`. Passing an
   * assayer id to `create()` therefore throws a FK violation — and because every caller wraps
   * notification sends in try/catch, it failed *silently*. That was happening in the document
   * dispatch path (assayer never told their audit PDF was sent) and in the validation-query
   * path (assayer never told a clarification was raised).
   *
   * Both channels key off the assayer id: the in-app row is addressed via `assayer_id` (see
   * NotificationEntity), and push device tokens are registered under the same id.
   *
   * Centralised here so callers never have to reason about which identity space applies, and
   * returns whether the in-app row was written so callers can log a real miss rather than
   * assuming success.
   *
   * @param assayerEmail optional, for logging/diagnostics only — delivery does not depend on it.
   */
  async notifyAssayer(
    assayerId: string,
    assayerEmail: string | null | undefined,
    payload: { title: string; message: string; link?: string; data?: Record<string, string> },
    systemUser?: string,
  ): Promise<{ inAppDelivered: boolean }> {
    let inAppDelivered = false;

    // Addressed directly to the assayer. An earlier attempt matched the assayer's email to a
    // `users` row and wrote that user's id, but no assayer has a user account at all, so it
    // never delivered anything. The assayer id is also exactly what the read path looks for:
    // their JWT carries `sub: assayer.id` and findForRecipient() queries on it.
    try {
      await this.notificationRepository.save(
        this.notificationRepository.create({
          userId: null,
          assayerId,
          title: payload.title,
          message: payload.message,
          link: payload.link ?? null,
          createdBy: systemUser ?? 'SYSTEM',
          updatedBy: systemUser ?? 'SYSTEM',
        }),
      );
      inAppDelivered = true;
    } catch (err: any) {
      console.error(`Failed to create in-app notification for assayer ${assayerId}:`, err?.message);
    }

    // Push is keyed by assayer id and is independent of whether a user account exists.
    try {
      await this.pushNotificationService.sendToUser(
        assayerId,
        payload.title,
        payload.message,
        payload.data || (payload.link ? { link: payload.link } : undefined),
      );
    } catch (err: any) {
      console.error('Failed to send push notification to assayer:', err?.message);
    }

    return { inAppDelivered };
  }

  async create(dto: CreateNotificationDto, systemUser?: string): Promise<NotificationEntity> {
    const notif = this.notificationRepository.create({
      userId: dto.userId,
      title: dto.title,
      message: dto.message,
      link: dto.link ?? null,
      createdBy: systemUser ?? 'SYSTEM',
      updatedBy: systemUser ?? 'SYSTEM',
    });

    const saved = await this.notificationRepository.save(notif);

    // Automatically send push notification to the targeted user/assayer
    try {
      await this.pushNotificationService.sendToUser(
        dto.userId,
        dto.title,
        dto.message,
        dto.data || (dto.link ? { link: dto.link } : undefined),
      );
    } catch (err: any) {
      // Don't break notification creation if push fails
    }

    // Emit real-time event for the notification
    try {
      this.eventPublisher.publish('notification:new', {
        eventType: 'notification:new',
        id: saved.id,
        userId: dto.userId,
        title: dto.title,
        message: dto.message,
        link: dto.link,
        isRead: false,
        createdAt: saved.createdAt?.toISOString?.() || new Date().toISOString(),
      });
    } catch (err: any) {
      // Don't break if event publish fails
    }

    return saved;
  }

  /**
   * Notifications for whoever is authenticated. The JWT `sub` is a user id for internal staff
   * and an assayer id for field assayers, so both recipient columns are matched.
   *
   * Unbounded before this — a long-lived account's entire history came back on every open of
   * the bell. Paginated now, and `unreadCount` is returned alongside the page so the badge
   * reflects the whole inbox rather than just whatever page happens to be showing.
   */
  async findByUser(recipientId: string, opts: FindNotificationsOptions = {}): Promise<NotificationPage> {
    const limit = Math.min(opts.limit ?? 25, 100);
    const offset = Math.max(opts.offset ?? 0, 0);

    const qb = this.notificationRepository
      .createQueryBuilder('n')
      .where('(n.userId = :rid OR n.assayerId = :rid)', { rid: recipientId })
      .andWhere('n.isActive = true');

    // Categories this recipient has switched off for in-app. The settings screen tells them
    // "you will stop seeing these in your notification bell entirely" and nothing enforced it —
    // rows were written and listed regardless. Filtered on read rather than never written,
    // because a category muted for in-app may still be on for push, and the push is sent from
    // the row. Explicitly asking for a muted category still returns it, so the inbox's own
    // category filter is not silently empty.
    const mutedCategories = await this.mutedInAppCategories(recipientId);
    if (mutedCategories.length && !opts.category) {
      qb.andWhere('n.category NOT IN (:...mutedCategories)', { mutedCategories });
    }

    if (opts.category) qb.andWhere('n.category = :category', { category: opts.category });
    if (opts.unreadOnly) qb.andWhere('n.isRead = false');

    const [items, total] = await qb
      .orderBy('n.createdAt', 'DESC')
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    const unreadCount = await this.getUnreadCount(recipientId);

    return { items, total, unreadCount };
  }

  /**
   * The categories this recipient has turned off for in-app.
   *
   * Absence of a row means opted in, so nobody is muted by omission. Fails open on a lookup
   * error — showing a notification somebody muted is a smaller harm than hiding their inbox.
   */
  private async mutedInAppCategories(recipientId: string): Promise<string[]> {
    try {
      const rows = await this.preferenceRepository.find({
        where: [
          { userId: recipientId, inApp: false },
          { assayerId: recipientId, inApp: false },
        ],
      });
      return rows.map((r) => r.category);
    } catch {
      return [];
    }
  }

  /**
   * Cheap enough to poll: used for the bell badge without pulling the whole inbox.
   *
   * Counts the same set the bell lists. It did not: muted categories were excluded from
   * neither, and once they are excluded from the list a badge that still counted them would
   * show unread items the user cannot open — a number that can never be cleared.
   */
  async getUnreadCount(recipientId: string): Promise<number> {
    const muted = await this.mutedInAppCategories(recipientId);
    const qb = this.notificationRepository
      .createQueryBuilder('n')
      .where('(n.userId = :rid OR n.assayerId = :rid)', { rid: recipientId })
      .andWhere('n.isActive = true')
      .andWhere('n.isRead = false');
    if (muted.length) qb.andWhere('n.category NOT IN (:...muted)', { muted });
    return qb.getCount();
  }

  async markAsRead(id: string, recipientId: string): Promise<NotificationEntity> {
    const notif = await this.notificationRepository.findOne({
      where: [
        { id, userId: recipientId, isActive: true },
        { id, assayerId: recipientId, isActive: true },
      ],
    });

    if (!notif) {
      throw new NotFoundException(`Notification ${id} not found.`);
    }

    notif.isRead = true;
    notif.status = NotificationStatus.READ;
    notif.readAt = new Date();
    notif.updatedBy = recipientId;

    return this.notificationRepository.save(notif);
  }

  /** For the "mark all read" action — one write rather than N round trips from the UI. */
  async markAllAsRead(recipientId: string): Promise<number> {
    const result = await this.notificationRepository
      .createQueryBuilder()
      .update(NotificationEntity)
      .set({ isRead: true, status: NotificationStatus.READ, readAt: new Date(), updatedBy: recipientId })
      .where('(user_id = :rid OR assayer_id = :rid)', { rid: recipientId })
      .andWhere('is_read = false')
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Every category's preference row for this recipient, filled in with the opt-out default
   * (everything on, including email) wherever no row has been saved yet. The caller never has to
   * special-case "no preference set" — the list is always complete and always the right shape
   * for a settings screen to render directly.
   */
  async getPreferences(recipientId: string, isAssayer: boolean): Promise<PreferenceRow[]> {
    const saved = await this.preferenceRepository.find({
      where: isAssayer ? { assayerId: recipientId } : { userId: recipientId },
    });
    const byCategory = new Map(saved.map((p) => [p.category, p]));

    return ALL_NOTIFICATION_CATEGORIES.map((category) => {
      const row = byCategory.get(category);
      return {
        category,
        inApp: row?.inApp ?? true,
        push: row?.push ?? true,
        email: row?.email ?? true,
      };
    });
  }

  async setPreference(
    recipientId: string,
    isAssayer: boolean,
    category: NotificationCategory,
    updates: Partial<Pick<PreferenceRow, 'inApp' | 'push' | 'email'>>,
  ): Promise<PreferenceRow> {
    const where = isAssayer ? { assayerId: recipientId, category } : { userId: recipientId, category };
    let row = await this.preferenceRepository.findOne({ where });

    if (!row) {
      row = this.preferenceRepository.create({
        userId: isAssayer ? null : recipientId,
        assayerId: isAssayer ? recipientId : null,
        category,
        inApp: true,
        push: true,
        // Opted in, matching the other channels and what delivery actually does. A row created
        // because somebody touched a different switch must not arrive pre-muted.
        email: true,
        createdBy: recipientId,
      });
    }

    if (updates.inApp !== undefined) row.inApp = updates.inApp;
    if (updates.push !== undefined) row.push = updates.push;
    if (updates.email !== undefined) row.email = updates.email;
    row.updatedBy = recipientId;

    const saved = await this.preferenceRepository.save(row);
    return { category: saved.category, inApp: saved.inApp, push: saved.push, email: saved.email };
  }
}
