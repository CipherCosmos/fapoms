import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationEntity } from './notification.entity';
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

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
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
   */
  async findByUser(recipientId: string): Promise<NotificationEntity[]> {
    return this.notificationRepository.find({
      where: [
        { userId: recipientId, isActive: true },
        { assayerId: recipientId, isActive: true },
      ],
      order: { createdAt: 'DESC' },
    });
  }

  async markAsRead(id: string, userId: string): Promise<NotificationEntity> {
    const notif = await this.notificationRepository.findOne({
      where: [
        { id, userId, isActive: true },
        { id, assayerId: userId, isActive: true },
      ],
    });

    if (!notif) {
      throw new NotFoundException(`Notification ${id} not found.`);
    }

    notif.isRead = true;
    notif.updatedBy = userId;

    const saved = await this.notificationRepository.save(notif);

    return saved;
  }
}
