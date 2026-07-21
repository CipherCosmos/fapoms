import { Repository } from 'typeorm';
import { NotificationEntity } from './notification.entity';
import { AuditService } from '../../core/audit/audit.service';
export interface CreateNotificationDto {
    userId: string;
    title: string;
    message: string;
    link?: string;
}
export declare class NotificationService {
    private readonly notificationRepository;
    private readonly auditService;
    constructor(notificationRepository: Repository<NotificationEntity>, auditService: AuditService);
    create(dto: CreateNotificationDto, systemUser?: string): Promise<NotificationEntity>;
    findByUser(userId: string): Promise<NotificationEntity[]>;
    markAsRead(id: string, userId: string): Promise<NotificationEntity>;
}
