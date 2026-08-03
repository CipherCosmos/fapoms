import { NotificationCategory } from '@fapoms/shared';
import { NotificationService } from './notification.service';
import { PushNotificationService } from './push-notification.service';
import { DevicePlatform } from './device-token.entity';
export declare class NotificationController {
    private readonly notificationService;
    private readonly pushService;
    constructor(notificationService: NotificationService, pushService: PushNotificationService);
    private isAssayer;
    findMyNotifications(req: any, category?: NotificationCategory, unreadOnly?: boolean, limit?: number, offset?: number): Promise<{
        success: boolean;
        data: import("./notification.entity").NotificationEntity[];
        meta: {
            total: number;
            unreadCount: number;
            limit: number | undefined;
            offset: number | undefined;
        };
    }>;
    unreadCount(req: any): Promise<{
        success: boolean;
        data: {
            count: number;
        };
    }>;
    getPreferences(req: any): Promise<{
        success: boolean;
        data: import("./notification.service").PreferenceRow[];
    }>;
    setPreference(category: NotificationCategory, req: any, dto: {
        inApp?: boolean;
        push?: boolean;
        email?: boolean;
    }): Promise<{
        success: boolean;
        data: import("./notification.service").PreferenceRow;
    }>;
    markAsRead(id: string, req: any): Promise<{
        success: boolean;
        data: import("./notification.entity").NotificationEntity;
    }>;
    markAllAsRead(req: any): Promise<{
        success: boolean;
        data: {
            updated: number;
        };
    }>;
    registerDeviceToken(req: any, dto: {
        token: string;
        platform: DevicePlatform;
    }): Promise<{
        success: boolean;
    }>;
    unregisterDeviceToken(req: any, dto: {
        token: string;
    }): Promise<{
        success: boolean;
    }>;
}
