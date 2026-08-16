import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ensureRepeatableSchedules, WantedSchedule } from '../queue/repeatable-schedules';
import { SlaScannerWorker } from './sla-scanner.worker';
import { EmailDigestService } from './email-digest.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { SETTING_BY_KEY } from '../settings/settings.registry';
import { AssignmentModule } from '../../modules/assignment/assignment.module';
import { AssayerModule } from '../../modules/assayer/assayer.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { ValidationModule } from '../../modules/validation/validation.module';
import { FeedbackModule } from '../../modules/feedback/feedback.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'sla-scanner' }),
    AssignmentModule,
    // The scan also warns HR about credentials falling due — see SlaScannerWorker.
    AssayerModule,
    NotificationsModule,
    // And chases the data-entry desk's stalled stages — see DeskEscalationService.
    ValidationModule,
    // And the feedback desk's response-time SLAs — see FeedbackEscalationService.
    FeedbackModule,
  ],
  providers: [SlaScannerWorker, EmailDigestService],
  exports: [SlaScannerWorker],
})
export class SlaScannerModule implements OnModuleInit {
  private readonly logger = new Logger(SlaScannerModule.name);

  constructor(
    @InjectQueue('sla-scanner') private readonly slaQueue: Queue,
    private readonly settings: PlatformSettingsService,
  ) {}

  private static readonly CRON = '*/15 * * * *';
  private static readonly DIGEST_TZ = 'Asia/Kolkata';

  /**
   * Read inside a method, not a static field: statics evaluate at import time, BEFORE
   * ConfigModule has loaded the .env files, so a static read sees only real process env
   * (docker) and silently ignores a `.env` override in bare `nest start`.
   *
   * The morning digest fires once, at the start of the business day, in business time.
   * Overridable because "morning" is a policy: EMAIL_DIGEST_CRON in standard cron syntax,
   * interpreted in Asia/Kolkata.
   */
  private async digestCron(): Promise<string> {
    // The service already resolves saved → environment → default; the registry holds the
    // shipped literal, so it is not written down a second time here.
    const configured = await this.settings.get<string>('digest.cron').catch(() => null);
    return configured || String(SETTING_BY_KEY['digest.cron'].default);
  }

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;

    // Both schedules, registered without being able to block or fail boot (see
    // ensureRepeatableSchedules). The scan gets three attempts with exponential backoff: every
    // phase is idempotent (dedupe keys, guarded writes), so a transient DB blip is safe to retry
    // and recovers within the tick instead of leaving escalations 15 minutes stale. The digest
    // gets exactly one: it sends as it goes and keeps no record of who it already reached, so a
    // retry half-way through would re-mail everyone before the failure — a duplicate morning
    // brief is worse than a missed one, which the logs report and tomorrow's run supersedes.
    ensureRepeatableSchedules(this.slaQueue, await this.wantedSchedules(), this.logger);

    /**
     * Re-register when an operator changes the schedule.
     *
     * Bull keys repeatable jobs by their cron string, so a changed schedule ADDS one rather
     * than replacing it — the old cadence would keep firing forever beside the new. Running
     * the same converge-to-one routine on change is what makes the schedule field in the
     * settings screen mean something.
     */
    this.settings.onChange('digest.cron', async () => {
      ensureRepeatableSchedules(this.slaQueue, await this.wantedSchedules(), this.logger);
    });
  }

  private async wantedSchedules(): Promise<WantedSchedule[]> {
    return [
      {
        name: 'scan',
        cron: SlaScannerModule.CRON,
        jobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
      },
      {
        name: 'digest',
        cron: await this.digestCron(),
        tz: SlaScannerModule.DIGEST_TZ,
        jobOptions: { attempts: 1 },
      },
    ];
  }
}
