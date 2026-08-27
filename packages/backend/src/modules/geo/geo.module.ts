import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from './geo.entities';
import { PostGISRoutingProvider, OSRMRoutingProvider, RoutingService } from './routing.provider';
import { GeoController } from './geo.controller';
import { GeoSeedService } from './geo-seed.service';
import { GeoPrecisionService } from './geo-precision.service';
import { GeoPrecisionWorker } from './geo-precision.worker';
import { GEO_PRECISION_QUEUE, GEO_PRECISION_SWEEP_JOB } from './geo-precision.constants';
import { TileProxyService } from './tile-proxy.service';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ensureRepeatableSchedules } from '../../infrastructure/queue/repeatable-schedules';

@Module({
  imports: [
    // Branch and assayer rows are registered here for the precision service alone. It reads and
    // rewrites only the geo columns, which is why it lives in the geo module rather than being
    // duplicated into both feature modules — the manual-pin rule has to have exactly one home.
    TypeOrmModule.forFeature([GeoStateEntity, GeoDistrictEntity, GeoCityEntity, BranchEntity, AssayerEntity]),
    // The precision backfill's own queue — see geo-precision.constants.ts for why not a shared one.
    BullModule.registerQueue({ name: GEO_PRECISION_QUEUE }),
  ],
  controllers: [GeoController],
  providers: [PostGISRoutingProvider, OSRMRoutingProvider, RoutingService, GeoSeedService, GeoPrecisionService, GeoPrecisionWorker, TileProxyService],
  exports: [RoutingService, GeoPrecisionService, TypeOrmModule],
})
export class GeoModule implements OnModuleInit {
  private readonly logger = new Logger(GeoModule.name);

  /**
   * Nightly, 02:30 IST. After the retention purge (hourly at :10) has had the small hours to
   * itself and well before the morning digest (08:30) reads branch positions for travel. The
   * free geocoders' rate limits make this the slowest job in the system — at roughly nine
   * seconds a row, the default bound is about 45 minutes — and the small hours are when that
   * costs nobody anything.
   */
  private static readonly SWEEP_CRON = '30 2 * * *';

  /** An hour after the branch sweep — see the note where these are registered. */
  private static readonly ASSAYER_SWEEP_CRON = '30 3 * * *';
  private static readonly TZ = 'Asia/Kolkata';

  constructor(@InjectQueue(GEO_PRECISION_QUEUE) private readonly queue: Queue) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;

    /**
     * Two schedules, one per target, so a branch backlog cannot starve assayer home pins of their
     * turn (or the reverse). Registration is fire-and-forget — a Redis that is down at boot must
     * not stop the API from starting. See `ensureRepeatableSchedules`.
     */
    ensureRepeatableSchedules(
      this.queue,
      /*
        TWO SCHEDULES, AND EACH SAYS WHICH TARGET IT IS FOR.

        The comment above has always described two. There was one, carrying no data, and the
        worker reads `job.data?.target ?? 'branch'` — so branches were swept nightly and assayer
        home pins never, in any environment, since the sweep was written. 1,155 of 1,163
        appraisers sat on no coordinates at all with a backfill job running past them every
        night.

        `jobId` is what lets both exist: Bull keys a repeatable by name, cron and jobId together,
        so two registrations of one job name without it replace each other rather than joining.

        An hour apart because both walk the same rate-limited free geocoders — Nominatim and
        Photon allow roughly one request a second between them — and two sweeps overlapping would
        halve the throughput of each while doubling the chance of being throttled.
      */
      [
        {
          name: GEO_PRECISION_SWEEP_JOB,
          cron: GeoModule.SWEEP_CRON,
          tz: GeoModule.TZ,
          jobId: 'sweep-branch',
          data: { target: 'branch' },
          // One attempt: the sweep is idempotent and runs again tomorrow; a retry inside the same
          // night just re-spends the rate budget on whatever made it fail.
          jobOptions: { attempts: 1 },
        },
        {
          name: GEO_PRECISION_SWEEP_JOB,
          cron: GeoModule.ASSAYER_SWEEP_CRON,
          tz: GeoModule.TZ,
          jobId: 'sweep-assayer',
          data: { target: 'assayer' },
          jobOptions: { attempts: 1 },
        },
      ],
      this.logger,
    );
  }
}
