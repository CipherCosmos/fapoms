import { BaseEntity } from '../../core/entities/base.entity';
import { UserEntity } from '../user/user.entity';
export declare class NotificationEntity extends BaseEntity {
    userId: string;
    title: string;
    message: string;
    isRead: boolean;
    link: string | null;
    user: UserEntity;
}
