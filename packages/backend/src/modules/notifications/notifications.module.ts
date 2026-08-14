import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationEntity } from './notification.entity';
import { DeviceTokenEntity } from './device-token.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { UserEntity } from '../user/user.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { PushNotificationService } from './push-notification.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { AuditModule } from '../../core/audit/audit.module';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { NOTIFICATION_QUEUE } from './notification.constants';
import { NotificationSweeper } from './notification.sweeper';
import { NotificationSettingEntity } from './notification-setting.entity';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationAdminController } from './notification-admin.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationEntity, DeviceTokenEntity, UserEntity, AssayerEntity, NotificationPreferenceEntity,
      NotificationSettingEntity,
    ]),
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    // The admin screen's "run the digest now" enqueues onto the scanner's queue. Registering
    // the queue here (rather than importing SlaScannerModule, which imports this one) keeps
    // the two modules acyclic.
    BullModule.registerQueue({ name: 'sla-scanner' }),
    AuditModule,
  ],
  controllers: [NotificationController, NotificationAdminController],
  providers: [
    NotificationService, PushNotificationService, NotificationDispatchService,
    NotificationDeliveryWorker, NotificationSweeper, FcmProvider, EmailProvider, NotificationSettingsService,
  ],
  exports: [NotificationService, PushNotificationService, NotificationDispatchService, EmailProvider, NotificationSettingsService],
})
export class NotificationsModule implements OnModuleInit {
  private readonly logger = new Logger(NotificationsModule.name);

  /** Catches rows the enqueue never reached; see `NotificationSweeper`. */
  private static readonly SWEEP_CRON = '*/5 * * * *';
  /** Settles sends abandoned mid-flight. */
  private static readonly ABANDONED_CRON = '7 * * * *';

  constructor(@InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;

    // Bull keys repeatable jobs by their cron string, so changing a schedule
    // adds a second one rather than replacing the first — the old cadence keeps
    // firing forever alongside the new. Drop any stale schedule so this queue
    // converges on exactly one of each, whatever a previous deploy registered.
    const wanted: Record<string, string> = {
      sweep: NotificationsModule.SWEEP_CRON,
      'fail-abandoned': NotificationsModule.ABANDONED_CRON,
    };
    for (const job of await this.queue.getRepeatableJobs()) {
      if (wanted[job.name] && job.cron !== wanted[job.name]) {
        await this.queue.removeRepeatableByKey(job.key);
        this.logger.warn(`Removed stale ${job.name} schedule: ${job.cron}`);
      }
    }

    for (const [name, cron] of Object.entries(wanted)) {
      await this.queue.add(name, {}, { repeat: { cron }, removeOnComplete: true, removeOnFail: false });
    }
    this.logger.log('Notification sweeper schedules registered');
  }
}
