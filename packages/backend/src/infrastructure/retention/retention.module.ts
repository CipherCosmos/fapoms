import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { RetentionService } from './retention.service';
import { RetentionWorker } from './retention.worker';
import { AuthModule } from '../../modules/auth/auth.module';
import { ensureRepeatableSchedules } from '../queue/repeatable-schedules';

/**
 * Data retention — the scheduled purge and nothing else.
 *
 * ## Wiring
 *
 * Imports `AuthModule` for `AuthService.pruneRefreshTokens`: `refresh_tokens` belongs to the auth
 * module and "what counts as a dead token" is an auth question, so this module owns the schedule
 * and auth owns the definition. The dependency runs one way only — nothing in `AuthModule` knows
 * this exists — so there is no cycle.
 *
 * `CacheService` (the cluster lock) and `PlatformSettingsService` (the retention window) both come
 * from global modules and need no import. The `DataSource` comes from the root `TypeOrmModule`.
 *
 * ## Scheduling
 *
 * Hourly, at ten past. Not on the hour, because the hour boundary is where the SLA scanner tick,
 * the digest and every other cron already land, and the one job that generates sustained write I/O
 * should not share that moment with the job that has to finish quickly.
 *
 * Hourly rather than nightly on purpose. A nightly job has to clear a whole day's accumulation in
 * one window, so its batch ceiling has to be high, so its worst case is long — and the first run
 * after this ships has years of backlog behind it. Twenty-four smaller passes spread the same work
 * out and keep any single pass's ceiling at 10 batches per table.
 *
 * Registration is fire-and-forget: a Redis that is down at boot must not stop the API from
 * starting. See `ensureRepeatableSchedules`.
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'retention' }), AuthModule],
  providers: [RetentionService, RetentionWorker],
  exports: [RetentionService],
})
export class RetentionModule implements OnModuleInit {
  private readonly logger = new Logger(RetentionModule.name);

  /** Ten past every hour, IST — see the class comment for why not on the hour. */
  private static readonly CRON = '10 * * * *';
  private static readonly TZ = 'Asia/Kolkata';

  constructor(@InjectQueue('retention') private readonly queue: Queue) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;

    ensureRepeatableSchedules(
      this.queue,
      [
        {
          name: 'purge',
          cron: RetentionModule.CRON,
          tz: RetentionModule.TZ,
          /**
           * One attempt. A retention pass is idempotent and runs again in an hour, so retrying a
           * failed one inside the same hour adds load during whatever incident caused the failure
           * without shortening the backlog by anything that matters.
           */
          jobOptions: { attempts: 1 },
        },
      ],
      this.logger,
    );
  }
}
