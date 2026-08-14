import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
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
    if (process.env.NODE_ENV !== 'test') {
      // Bull tracks repeatable jobs by their cron string, so simply changing the cron
      // here (e.g. 5min -> 15min) registers an ADDITIONAL repeatable job rather than
      // replacing the old one — any previously-deployed schedule keeps firing forever
      // alongside the new one. Remove every other stale repeatable first so this
      // queue always converges to exactly one active schedule per job, whatever ran before.
      const wanted: Record<string, string> = {
        scan: SlaScannerModule.CRON,
        digest: await this.digestCron(),
      };
      const existing = await this.slaQueue.getRepeatableJobs();
      for (const job of existing) {
        if (wanted[job.name] && job.cron !== wanted[job.name]) {
          await this.slaQueue.removeRepeatableByKey(job.key);
          this.logger.warn(`Removed stale ${job.name} schedule: ${job.cron}`);
        }
      }

      await this.slaQueue.add(
        'scan',
        {},
        {
          repeat: { cron: SlaScannerModule.CRON },
          removeOnComplete: true,
          removeOnFail: false,
          // Without this, Bull's default is a single attempt: any throw loses the whole tick until
          // the next cron 15 minutes later. Every phase is idempotent (dedupe keys, guarded
          // writes), so a transient DB blip is safe to retry — three tries with exponential
          // backoff recover within the tick instead of leaving escalations 15 minutes stale.
          // Changing `attempts` does not fork the schedule: Bull keys repeatables by cron string,
          // and the loop above already removes any stale cron.
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      );

      await this.slaQueue.add(
        'digest',
        {},
        {
          repeat: { cron: await this.digestCron(), tz: SlaScannerModule.DIGEST_TZ },
          removeOnComplete: true,
          removeOnFail: false,
          /**
           * Exactly one attempt, unlike the scan's three.
           *
           * The digest sends as it goes, recipient by recipient, and keeps no record of who it
           * already reached. A retry after a failure half-way through would re-send to everyone
           * before it — and a duplicate morning brief is worse than a missed one, which the
           * logs report and tomorrow's run supersedes anyway.
           */
          attempts: 1,
        },
      );
      this.logger.log(
        `SLA scanner repeatable job registered (every 15 minutes); morning digest at "${await this.digestCron()}" ${SlaScannerModule.DIGEST_TZ}`,
      );

      /**
       * Re-register when an operator changes the schedule.
       *
       * Bull keys repeatable jobs by their cron string, so a changed schedule ADDS one rather
       * than replacing it — the old cadence would keep firing forever beside the new. Running
       * the same converge-to-one routine on change is what makes the schedule field in the
       * settings screen mean something.
       */
      this.settings.onChange('digest.cron', async () => {
        const wanted = await this.digestCron();
        for (const job of await this.slaQueue.getRepeatableJobs()) {
          if (job.name === 'digest' && job.cron !== wanted) {
            await this.slaQueue.removeRepeatableByKey(job.key);
          }
        }
        await this.slaQueue.add('digest', {}, {
          repeat: { cron: wanted, tz: SlaScannerModule.DIGEST_TZ },
          removeOnComplete: true, removeOnFail: false, attempts: 1,
        });
        this.logger.log(`Morning digest rescheduled to "${wanted}" ${SlaScannerModule.DIGEST_TZ}`);
      });
    }
  }
}
