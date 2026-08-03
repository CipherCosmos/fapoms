import { Repository } from 'typeorm';
import { NotificationCategory } from '@fapoms/shared';
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
export declare const ALL_NOTIFICATION_CATEGORIES: NotificationCategory[];
export interface PreferenceRow {
    category: NotificationCategory;
    inApp: boolean;
    push: boolean;
    email: boolean;
}
export declare class NotificationService {
    private readonly notificationRepository;
    private readonly preferenceRepository;
    private readonly userRepository;
    private readonly assayerRepository;
    private readonly pushNotificationService;
    private readonly eventPublisher;
    constructor(notificationRepository: Repository<NotificationEntity>, preferenceRepository: Repository<NotificationPreferenceEntity>, userRepository: Repository<UserEntity>, assayerRepository: Repository<AssayerEntity>, pushNotificationService: PushNotificationService, eventPublisher: DomainEventPublisher);
    notifyAssayer(assayerId: string, assayerEmail: string | null | undefined, payload: {
        title: string;
        message: string;
        link?: string;
        data?: Record<string, string>;
    }, systemUser?: string): Promise<{
        inAppDelivered: boolean;
    }>;
    create(dto: CreateNotificationDto, systemUser?: string): Promise<NotificationEntity>;
    findByUser(recipientId: string, opts?: FindNotificationsOptions): Promise<NotificationPage>;
    getUnreadCount(recipientId: string): Promise<number>;
    markAsRead(id: string, recipientId: string): Promise<NotificationEntity>;
    markAllAsRead(recipientId: string): Promise<number>;
    getPreferences(recipientId: string, isAssayer: boolean): Promise<PreferenceRow[]>;
    setPreference(recipientId: string, isAssayer: boolean, category: NotificationCategory, updates: Partial<Pick<PreferenceRow, 'inApp' | 'push' | 'email'>>): Promise<PreferenceRow>;
}
