import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { AssayerLocationPingEntity, LocationPingSource } from './assayer-location-ping.entity';
import { assessTravel, TravelAssessment, TrackFix } from './travel-track';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

/** One position as offered by a client. Validated here before it becomes evidence. */
export interface IncomingPing {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  speedMps?: number | null;
  /** Device clock, ISO 8601. */
  recordedAt: string;
  assignmentId?: string | null;
  isMocked?: boolean;
  source?: LocationPingSource;
}

export interface IngestResult {
  accepted: number;
  /** Already stored — a retried batch, not an error. */
  duplicates: number;
  /** Rejected as unusable, with the reason, so a bad client is diagnosable. */
  rejected: { index: number; reason: string }[];
}

/**
 * The field movement record: writing positions down, and reading them back as a journey.
 *
 * Two jobs, kept in one place because they share the definition of what a stored fix is. What a
 * trail *means* — whether a claim is consistent with it — lives in `travel-track.ts` as pure
 * functions, so that judgement can be tested exhaustively and re-run over history when a threshold
 * turns out to be wrong.
 */
@Injectable()
export class LocationTrailService {
  private readonly logger = new Logger(LocationTrailService.name);

  /**
   * A batch bigger than this is a client bug or an attempt to flood the table. A day of 30-second
   * fixes is ~2,900, so 1,000 comfortably covers an offline spell being flushed in chunks.
   */
  private static readonly MAX_BATCH = 1000;

  /**
   * How far ahead of the server a device clock may be before its fix is refused. Handset clocks
   * drift and time zones are misconfigured, so a small tolerance is realistic — but a fix
   * timestamped into the future would sit beyond every verification window and could be used to
   * park evidence where no query looks for it.
   */
  private static readonly MAX_CLOCK_SKEW_MS = 10 * 60_000;

  constructor(
    @InjectRepository(AssayerLocationPingEntity)
    private readonly pingRepository: Repository<AssayerLocationPingEntity>,
    private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * Store a batch of fixes for one assayer.
   *
   * Never throws for one bad fix in a batch: the field app flushes what it queued while offline,
   * and rejecting the whole upload because a single row has a broken timestamp would discard hours
   * of legitimate evidence. Each fix is judged on its own and the outcome is reported per index.
   */
  async ingest(
    assayerId: string,
    pings: IncomingPing[],
    recordedBy?: string,
  ): Promise<IngestResult> {
    if (!Array.isArray(pings) || pings.length === 0) {
      throw new BadRequestException('No positions were supplied.');
    }
    if (pings.length > LocationTrailService.MAX_BATCH) {
      throw new BadRequestException(
        `Too many positions in one batch (${pings.length}). Send at most ${LocationTrailService.MAX_BATCH} and repeat.`,
      );
    }

    const now = Date.now();
    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: [] };
    const rows: AssayerLocationPingEntity[] = [];
    // Guards against a batch that repeats an instant within itself, which the unique index would
    // otherwise reject as a whole-batch failure.
    const seenInstants = new Set<number>();

    pings.forEach((p, index) => {
      const lat = Number(p.latitude);
      const lng = Number(p.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        result.rejected.push({ index, reason: 'Latitude or longitude is not a valid coordinate.' });
        return;
      }
      // 0,0 is in the Atlantic. It is what a failed fix serialises to, never where an assayer is.
      if (lat === 0 && lng === 0) {
        result.rejected.push({ index, reason: 'Null Island (0,0) is a failed fix, not a position.' });
        return;
      }
      const recordedAt = new Date(p.recordedAt);
      if (Number.isNaN(recordedAt.getTime())) {
        result.rejected.push({ index, reason: 'recordedAt is not a valid timestamp.' });
        return;
      }
      if (recordedAt.getTime() > now + LocationTrailService.MAX_CLOCK_SKEW_MS) {
        result.rejected.push({ index, reason: 'recordedAt is in the future.' });
        return;
      }
      if (seenInstants.has(recordedAt.getTime())) {
        result.duplicates++;
        return;
      }
      seenInstants.add(recordedAt.getTime());

      rows.push(
        this.pingRepository.create({
          assayerId,
          assignmentId: p.assignmentId ?? null,
          latitude: lat,
          longitude: lng,
          location: { type: 'Point', coordinates: [lng, lat] } as any,
          accuracyMeters:
            p.accuracyMeters == null || !Number.isFinite(Number(p.accuracyMeters))
              ? null
              : Math.round(Number(p.accuracyMeters)),
          speedMps:
            p.speedMps == null || !Number.isFinite(Number(p.speedMps)) ? null : Number(p.speedMps),
          recordedAt,
          source: p.source ?? LocationPingSource.APP_TRACKING,
          isMocked: Boolean(p.isMocked),
          createdBy: recordedBy ?? assayerId,
          updatedBy: recordedBy ?? assayerId,
        }),
      );
    });

    if (rows.length > 0) {
      /**
       * `orIgnore` against the (assayer, recorded_at) unique index. A retried upload is the normal
       * case, not an error — and silently double-counting a re-sent trail would inflate the exact
       * distance this record exists to check.
       */
      const inserted = await this.pingRepository
        .createQueryBuilder()
        .insert()
        .into(AssayerLocationPingEntity)
        .values(rows as any)
        .orIgnore()
        .execute();

      const count = inserted.identifiers.filter(Boolean).length;
      result.accepted = count;
      result.duplicates += rows.length - count;
    }

    return result;
  }

  /** Append a single fix. Used by the live-location push and by check-in. */
  async record(
    assayerId: string,
    latitude: number,
    longitude: number,
    opts: {
      source?: LocationPingSource;
      accuracyMeters?: number | null;
      assignmentId?: string | null;
      recordedAt?: Date;
      recordedBy?: string;
    } = {},
  ): Promise<void> {
    try {
      await this.ingest(
        assayerId,
        [
          {
            latitude,
            longitude,
            accuracyMeters: opts.accuracyMeters ?? null,
            recordedAt: (opts.recordedAt ?? new Date()).toISOString(),
            assignmentId: opts.assignmentId ?? null,
            source: opts.source ?? LocationPingSource.APP_TRACKING,
          },
        ],
        opts.recordedBy,
      );
    } catch (err) {
      // Best-effort by design: the trail is supporting evidence, and failing to append a fix must
      // never fail the check-in or the position update it accompanies.
      this.logger.warn(
        `Could not append a location fix for assayer ${assayerId}: ${(err as Error)?.message}`,
      );
    }
  }

  /** The stored fixes for one assayer across a window, oldest first. */
  async fixesBetween(assayerId: string, from: Date, to: Date): Promise<TrackFix[]> {
    const rows = await this.pingRepository.find({
      where: { assayerId, recordedAt: Between(from, to) },
      order: { recordedAt: 'ASC' },
    });
    return rows.map((r) => ({
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      accuracyMeters: r.accuracyMeters,
      recordedAt: r.recordedAt,
      isMocked: r.isMocked,
    }));
  }

  /**
   * Assess the journey into a branch.
   *
   * The window ends at the check-in — the one moment the platform knows for certain where the
   * assayer was — and reaches back `lookbackHours` for the approach. It deliberately does not run
   * without a check-in: with no fixed end point there is no journey to speak about, only a day's
   * wandering, and inventing a window would produce a confident number about nothing.
   */
  /**
   * How far back to look, given the distance the claim was based on.
   *
   * A fixed window is the wrong shape. Too long and the question silently becomes "did this person
   * have their phone on all day?" — a 45-minute drive inside a 12-hour window scores 6% coverage
   * and returns INSUFFICIENT_COVERAGE however complete the trail of the journey itself was, making
   * the whole assessment permanently non-committal. Too short and a slow rural journey is cut off
   * halfway, and the part that was not looked at reads as distance not travelled.
   *
   * So the window is the journey's own plausible duration: distance at a deliberately pessimistic
   * 30 km/h average (Indian road conditions, stops, traffic), which errs long — a window wider than
   * the real journey costs only some coverage, while one narrower than it would clip real travel
   * out of the measurement. Floored at an hour so a short hop still has room, capped at twelve so
   * an implausible claim cannot demand a search back through days of history.
   */
  private static lookbackHoursFor(expectedDistanceKm?: number | null): number {
    if (!expectedDistanceKm || !Number.isFinite(expectedDistanceKm) || expectedDistanceKm <= 0) {
      // No claimed distance to size the window from: a working day's outward leg.
      return 4;
    }
    const ASSUMED_AVERAGE_KMH = 30;
    return Math.min(12, Math.max(1, expectedDistanceKm / ASSUMED_AVERAGE_KMH));
  }

  async assessAssignmentTravel(params: {
    assayerId: string;
    checkedInAt: Date | null | undefined;
    expectedDistanceKm?: number | null;
    /** Overrides the distance-derived window. Mostly for tests and manual investigation. */
    lookbackHours?: number;
    /** Passed through so an empty trail can say whether sharing was off or simply silent. */
    trackingEnabled?: boolean;
  }): Promise<TravelAssessment | null> {
    if (!params.checkedInAt) return null;
    const end = new Date(params.checkedInAt);
    const hours =
      params.lookbackHours ?? LocationTrailService.lookbackHoursFor(params.expectedDistanceKm);
    const start = new Date(end.getTime() - hours * 3_600_000);
    const fixes = await this.fixesBetween(params.assayerId, start, end);
    return assessTravel(fixes, start, end, params.expectedDistanceKm ?? null, {
      trackingEnabled: params.trackingEnabled,
    });
  }

  /**
   * Delete trail history older than the configured retention window.
   *
   * **Does nothing unless configured.** Set at Administration → Platform Settings → Data retention
   * (or `LOCATION_TRAIL_RETENTION_DAYS`). It has no default on purpose:
   * how long to keep continuous movement records of identifiable workers is a policy question —
   * it touches employment terms and data-protection duties — and choosing a number here would be
   * this service quietly making that decision on someone's behalf. Left unset, nothing is deleted
   * and the table grows: a visible problem with an owner, which is much better than silently
   * destroying evidence an assayer may later need to defend a claim.
   *
   * Deletes in bounded slices, so a first run across a long-neglected table cannot hold a long
   * lock. Returns the count so a caller can loop until it drains.
   */
  async purgeOlderThanRetention(batchSize = 5_000): Promise<{ configured: boolean; deleted: number }> {
    // Through settings, not the environment alone — otherwise the retention field on the
    // settings screen is a control that saves a value nothing reads, which is worse than
    // having no field at all.
    const days = Number(
      await this.settings
        .get<number>('locationTrail.retentionDays')
        .catch(() => process.env.LOCATION_TRAIL_RETENTION_DAYS),
    );
    if (!Number.isFinite(days) || days <= 0) return { configured: false, deleted: 0 };

    const cutoff = new Date(Date.now() - days * 86_400_000);
    const result = await this.pingRepository.query(
      `DELETE FROM assayer_location_pings
        WHERE id IN (
          SELECT id FROM assayer_location_pings WHERE recorded_at < $1 ORDER BY recorded_at LIMIT $2
        )`,
      [cutoff, batchSize],
    );

    // node-postgres reports the row count on the command result; TypeORM surfaces it as the
    // second element for raw DELETEs.
    const deleted = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    if (deleted > 0) {
      this.logger.log(
        `Purged ${deleted} location fix(es) older than ${days} days (before ${cutoff.toISOString()}).`,
      );
    }
    return { configured: true, deleted };
  }
}
