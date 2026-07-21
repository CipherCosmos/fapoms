import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationEntity } from './notification.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';

export interface CreateNotificationDto {
  userId: string;
  title: string;
  message: string;
  link?: string;
}

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
    private readonly auditService: AuditService,
  ) {}

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

    return saved;
  }

  async findByUser(userId: string): Promise<NotificationEntity[]> {
    return this.notificationRepository.find({
      where: { userId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async markAsRead(id: string, userId: string): Promise<NotificationEntity> {
    const notif = await this.notificationRepository.findOne({
      where: { id, userId, isActive: true },
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
