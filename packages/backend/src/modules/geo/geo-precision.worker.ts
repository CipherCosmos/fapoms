import { Injectable, Logger } from '@nestjs/common';
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { GeoPrecisionService } from './geo-precision.service';
import {
  GEO_PRECISION_QUEUE,
  GEO_PRECISION_SWEEP_JOB,
  GEO_PRECISION_TARGETED_JOB,
  GEO_ADDRESS_ENRICH_JOB,
  GeoPrecisionSweepJobData,
  GeoPrecisionTargetedJobData,
  GeoAddressEnrichJobData,
} from './geo-precision.constants';

/**
 * The Bull side of coordinate precision: the part that makes "the backfill upgrades those rows
 * afterwards" (geocodeIndiaRobust's own contract) actually happen without a person remembering.
 *
 * Until this existed the backfill was reachable only through an admin-only POST that nothing
 * called. So every branch imported from a sheet — and the import takes the fast tiers on
 * purpose, to stay out of the request path — sat at a district centroid (~15 km) or a state
 * centroid (~100 km) indefinitely. Measured on a real 72-branch client file: 62 at 15 km, 10 on
 * the state centroid, all four Telangana branches on one identical point. A 15 km pin makes the
 * 2 km check-in geofence unreachable and every travel quote wrong, and the import had honestly
 * flagged all 72 as imprecise — to a screen nobody acted on.
 *
 * **`concurrency: 1` is a rate-limit decision.** The free providers publish roughly one request
 * per second per client and enforce it; `politely()` in the OSM geocoder serialises calls within
 * one process, and one job at a time keeps that true. Two sweeps side by side would double the
 * rate and earn an IP ban that takes every geocode down with it.
 */
@Injectable()
@Processor(GEO_PRECISION_QUEUE)
export class GeoPrecisionWorker {
  private readonly logger = new Logger(GeoPrecisionWorker.name);

  constructor(private readonly precision: GeoPrecisionService) {}

  /** Rows named by whoever enqueued them — an import's freshly placed branches. */
  @Process({ name: GEO_PRECISION_TARGETED_JOB, concurrency: 1 })
  async backfillIds(job: Job<GeoPrecisionTargetedJobData>): Promise<void> {
    const { target, ids, reason } = job.data;
    if (!ids?.length) return;
    const started = Date.now();
    const report = await this.precision.backfill(target, ids.length, ids);
    this.logger.log(
      `Precision (${reason ?? 'targeted'}): ${report.improved}/${report.examined} ${target} row(s) improved, ` +
        `${report.unchanged} unchanged, in ${Math.round((Date.now() - started) / 1000)}s.`,
    );
  }

  /**
   * Rows per nightly sweep. Raise it on an estate with a large backlog; the sweep converges
   * regardless, because a row that reaches the pincode tier (≤ 3 km) stops being selected.
   *
   * Sized to the slow case, not the typical one. A row costs several free-provider lookups —
   * measured at ~9 s when Overpass answers promptly and ~108 s when it does not (it has a 25 s
   * timeout and overpass-api.de is often overloaded). 150 rows is ~25 minutes on a good night
   * and ~4.5 hours on a bad one, which from 02:30 IST still finishes before anyone is planning
   * against the result. 300 on a bad night would run until late morning.
   */
  static get sweepLimit(): number {
    return Number(process.env.GEO_PRECISION_NIGHTLY_LIMIT) || 150;
  }

  /**
   * The nightly bounded sweep over whatever is still coarse. The repeatable schedule adds this
   * job with empty data (see `ensureRepeatableSchedules`), so target and bound default here.
   */
  @Process({ name: GEO_PRECISION_SWEEP_JOB, concurrency: 1 })
  async sweep(job: Job<Partial<GeoPrecisionSweepJobData>>): Promise<void> {
    const target = job.data?.target ?? 'branch';
    const limit = job.data?.limit ?? GeoPrecisionWorker.sweepLimit;
    const started = Date.now();
    const report = await this.precision.backfill(target, limit);
    if (report.examined === 0) return;
    this.logger.log(
      `Precision sweep: ${report.improved}/${report.examined} ${target} row(s) improved, ` +
        `${report.unchanged} unchanged, in ${Math.round((Date.now() - started) / 1000)}s.`,
    );
  }

  /** How many branches one enrich job/sweep processes. Generous because the reverse-geocode is the
   *  self-hosted India Nominatim (~200 ms, free), so a few thousand is minutes, not hours. */
  static get enrichLimit(): number {
    return Number(process.env.GEO_ADDRESS_ENRICH_LIMIT) || 3000;
  }

  /**
   * Fill derivable address fields (district/pincode/city + zone/territory/tier). Reads the
   * self-hosted geocoder, so it runs at its own pace rather than the public-provider rate limit —
   * but still concurrency 1 within this queue so one job's reverse calls stay serialised.
   */
  @Process({ name: GEO_ADDRESS_ENRICH_JOB, concurrency: 1 })
  async enrichAddresses(job: Job<GeoAddressEnrichJobData>): Promise<void> {
    const started = Date.now();
    const limit = job.data?.limit ?? (job.data?.ids?.length || GeoPrecisionWorker.enrichLimit);
    const report = await this.precision.enrichBranchAddresses(limit, job.data?.ids);
    if (report.examined === 0) return;
    this.logger.log(
      `Address enrich (${job.data?.reason ?? 'sweep'}): ${report.updated}/${report.examined} branch(es) filled ` +
        `(+${report.districtFilled} district, +${report.pincodeFilled} pincode, +${report.zoneFilled} zone, ` +
        `${report.cityCorrected} city corrected) in ${Math.round((Date.now() - started) / 1000)}s.`,
    );
  }
}
