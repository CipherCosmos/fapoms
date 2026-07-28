import { Repository } from 'typeorm';
import { NotificationEntity } from './notification.entity';
import { PushNotificationService } from './push-notification.service';
export interface CreateNotificationDto {
    userId: string;
    title: string;
    message: string;
    link?: string;
    data?: Record<string, string>;
}
export declare class NotificationService {
    private readonly notificationRepository;
    private readonly pushNotificationService;
    constructor(notificationRepository: Repository<NotificationEntity>, pushNotificationService: PushNotificationService);
    create(dto: CreateNotificationDto, systemUser?: string): Promise<NotificationEntity>;
    findByUser(userId: string): Promise<NotificationEntity[]>;
    markAsRead(id: string, userId: string): Promise<NotificationEntity>;
}
