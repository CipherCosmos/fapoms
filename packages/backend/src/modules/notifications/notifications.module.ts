import { SLA_SCANNER_QUEUE, SLA_SCANNER_QUEUE_SETTINGS } from '../../infrastructure/scheduler/sla-scanner.constants';
import { AssignmentRefreshPushService } from './assignment-refresh-push.service';
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
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { ensureRepeatableSchedules } from '../../infrastructure/queue/repeatable-schedules';
import { PushNotificationService } from './push-notification.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { AuditModule } from '../../core/audit/audit.module';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { NOTIFICATION_QUEUE, OUTBOUND_EMAIL_QUEUE, OUTBOUND_SMS_QUEUE } from './notification.constants';
import { SmsService } from './sms.service';
import { SmsTemplateService } from './sms-template.service';
import { OutboundSmsWorker } from './outbound-sms.worker';
import { NotificationSweeper } from './notification.sweeper';
import { NotificationSettingEntity } from './notification-setting.entity';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationAdminController } from './notification-admin.controller';
import { NotificationTenancyService } from './notification-tenancy';
import { OutboundMessageEntity } from './outbound-message.entity';
import { OutboundMessageService } from './outbound-message.service';
import { OutboundEmailWorker, OUTBOUND_MESSAGE_SWEEP_JOB } from './outbound-email.worker';
import { OutboundMessageController } from './outbound-message.controller';
import { EmailService } from './email.service';

import { EmailTemplateLoader } from '../../infrastructure/notifications/email-template-loader';
import { MessageTokensService } from '../../infrastructure/notifications/message-tokens';
import { EmailTemplateRenderer } from '../../infrastructure/notifications/email-template-renderer';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationEntity, DeviceTokenEntity, UserEntity, AssayerEntity, NotificationPreferenceEntity,
      NotificationSettingEntity, OutboundMessageEntity,
    ]),
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    // Its own queue so a burst of action emails cannot hold the notification queue's loops; see
    // OUTBOUND_EMAIL_QUEUE. A stalled send is safe to re-run: the job must claim its row first.
    BullModule.registerQueue({ name: OUTBOUND_EMAIL_QUEUE }),
    // Texts: same ledger and lifecycle as emails, their own queue so a slow gateway holds only texts.
    BullModule.registerQueue({ name: OUTBOUND_SMS_QUEUE }),
    // The admin screen's "run the digest now" enqueues onto the scanner's queue. Registering
    // the queue here (rather than importing SlaScannerModule, which imports this one) keeps
    // the two modules acyclic.
    BullModule.registerQueue({ name: SLA_SCANNER_QUEUE, settings: SLA_SCANNER_QUEUE_SETTINGS }),
    AuditModule,
  ],
  controllers: [NotificationController, NotificationAdminController, OutboundMessageController],
  providers: [
    NotificationService, PushNotificationService, NotificationDispatchService,
    // The silent "your jobs changed" push — see its own comment.
    AssignmentRefreshPushService,
    NotificationDeliveryWorker, NotificationSweeper, FcmProvider, EmailProvider, SmsProvider, NotificationSettingsService,
    EmailTemplateLoader, EmailTemplateRenderer, MessageTokensService,
    // Emails an action asks for leave the request here; see OutboundMessageService.
    OutboundMessageService, OutboundEmailWorker,
    // The one way anything in the application sends email — see its class comment.
    EmailService,
    // Its SMS twin, on the same ledger and delivery routine.
    SmsService, SmsTemplateService, OutboundSmsWorker,
    // Deliberately a plain singleton, not request-scoped: dispatch is reached from Bull workers
    // and cron scans where there is no request to be scoped to. See its own comment.
    NotificationTenancyService,
  ],
  /*
    Email leaves this module only as `EmailService`, and texts only as `SmsService`. The transports
    (`EmailProvider`, `SmsProvider`), the template renderers/loader and the queue
    (`OutboundMessageService`) are internal: exporting them is what let feature modules grow seven
    direct paths to the mail server, two to the SMS gateway, and their own copies of the wording.
    `messaging-single-path.spec.ts` guards the source; not exporting them makes Nest refuse the
    injection outright.
  */
  exports: [
    // The queues registered above — `SlaScannerModule` takes its queue from here (registered once).
    BullModule,
    NotificationService, PushNotificationService, NotificationDispatchService, NotificationSettingsService,
    EmailService, SmsService, AssignmentRefreshPushService,
  ],
})
export class NotificationsModule implements OnModuleInit {
  private readonly logger = new Logger(NotificationsModule.name);

  /** Catches rows the enqueue never reached; see `NotificationSweeper`. */
  private static readonly SWEEP_CRON = '*/5 * * * *';
  /** Settles sends abandoned mid-flight. */
  private static readonly ABANDONED_CRON = '7 * * * *';
  /**
   * Re-queues emails whose job was lost and settles abandoned sends. Every two minutes, because a
   * person may be watching one of these say "Sending…" — five minutes is too long to leave it.
   */
  private static readonly OUTBOUND_SWEEP_CRON = '*/2 * * * *';

  constructor(
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue,
    @InjectQueue(OUTBOUND_EMAIL_QUEUE) private readonly outboundQueue: Queue,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;

    // Non-blocking and non-fatal: a Redis that is down at boot must not stop the API from
    // starting over a cron registration. See ensureRepeatableSchedules.
    ensureRepeatableSchedules(
      this.queue,
      [
        { name: 'sweep', cron: NotificationsModule.SWEEP_CRON },
        { name: 'fail-abandoned', cron: NotificationsModule.ABANDONED_CRON },
      ],
      this.logger,
    );
    ensureRepeatableSchedules(
      this.outboundQueue,
      [{ name: OUTBOUND_MESSAGE_SWEEP_JOB, cron: NotificationsModule.OUTBOUND_SWEEP_CRON }],
      this.logger,
    );
  }
}
