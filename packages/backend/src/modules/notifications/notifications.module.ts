import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationEntity } from './notification.entity';
import { DeviceTokenEntity } from './device-token.entity';
import { UserEntity } from '../user/user.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';
import { PushNotificationService } from './push-notification.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([NotificationEntity, DeviceTokenEntity, UserEntity]),
  ],
  controllers: [NotificationController],
  providers: [NotificationService, PushNotificationService, FcmProvider],
  exports: [NotificationService, PushNotificationService],
})
export class NotificationsModule {}
