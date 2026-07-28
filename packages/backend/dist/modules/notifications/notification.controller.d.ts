import { NotificationService } from './notification.service';
import { PushNotificationService } from './push-notification.service';
import { DevicePlatform } from './device-token.entity';
export declare class NotificationController {
    private readonly notificationService;
    private readonly pushService;
    constructor(notificationService: NotificationService, pushService: PushNotificationService);
    findMyNotifications(req: any): Promise<{
        success: boolean;
        data: import("./notification.entity").NotificationEntity[];
    }>;
    markAsRead(id: string, req: any): Promise<{
        success: boolean;
        data: import("./notification.entity").NotificationEntity;
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
