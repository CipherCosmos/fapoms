import { NotificationService } from './notification.service';
export declare class NotificationController {
    private readonly notificationService;
    constructor(notificationService: NotificationService);
    findMyNotifications(req: any): Promise<{
        success: boolean;
        data: import("./notification.entity").NotificationEntity[];
    }>;
    markAsRead(id: string, req: any): Promise<{
        success: boolean;
        data: import("./notification.entity").NotificationEntity;
    }>;
}
