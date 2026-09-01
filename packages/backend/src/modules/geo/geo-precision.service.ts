/**
 * FAPOMS — bringing existing coordinates up to precision.
 *
 * The resolver improves what gets written from now on. It does nothing for the rows already in
 * the table, and on this database that is most of them: 40 of 82 branches share a coordinate
 * with another branch because they all fell back to the same city or state centroid, and every
 * assayer sits on a city centroid. Those are the rows the planner is actually using today.
 *
 * Two operations, deliberately separate:
 *
 *   - `backfill` re-resolves the coarse rows through the free chain. Rate-limited by the
 *     providers' usage policies to roughly one row per second, so it runs in the background
 *     with a bound rather than inside a request.
 *   - `pinManually` is how a coordinate ever becomes genuinely 5–10 m accurate. No free
 *     geocoder can promise that; a person who knows where the branch is can. A manual pin is
 *     final — nothing automated overwrites it.
 */

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Repository, IsNull, Not } from 'typeorm';
import { GEO_PRECISION_QUEUE, GEO_PRECISION_TARGETED_JOB, GeoPrecisionTargetedJobData } from './geo-precision.constants';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NOT_A_RECORD_ENTITY_ID } from '../../core/audit/audit-event';
import { EventCategory } from '@fapoms/shared';
import { resolveCoordinates, needsBetterFix, isPlausibleIndianCoord, GeoFields } from './coordinate-resolution';
import { reverseFreely, PRECISION_METERS, GeoPrecision } from './osm-geocoder';
import { calculateHaversineDistance } from '@fapoms/shared';

export type GeoTarget = 'branch' | 'assayer';

export interface PrecisionSummary {
  total: number;
  /** Rows whose coordinate is a district/state centroid, or missing entirely. */
  imprecise: number;
  /** Rows a person has pinned. */
  manual: number;
  byTier: Record<string, number>;
}

export interface BackfillReport {
  examined: number;
  improved: number;
  unchanged: number;
  /** Rows skipped because someone had pinned them by hand. */
  protectedManual: number;
  /** How far each improved row moved — large values are the point, not a warning. */
  movedKm: { name: string; km: number; from: string; to: string }[];
}

@Injectable()
export class GeoPrecisionService {
  private readonly logger = new Logger(GeoPrecisionService.name);

  constructor(
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    private readonly auditService: AuditService,
    @InjectQueue(GEO_PRECISION_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Hand a set of rows to the background precision worker.
   *
   * Fire-and-forget by design: this is called at the end of an import, and a Redis hiccup must
   * not turn a completed import into a failed request. The rows are not lost if the enqueue
   * fails — the nightly sweep selects by precision, not by who asked, so it picks them up.
   * Chunked so one 2,000-branch import does not become one job that holds the worker for hours
   * with nothing to show for it in the meantime.
   */
  async enqueueBackfill(target: GeoTarget, ids: string[], reason?: string): Promise<void> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    const CHUNK = 50;
    try {
      for (let i = 0; i < unique.length; i += CHUNK) {
        const data: GeoPrecisionTargetedJobData = { target, ids: unique.slice(i, i + CHUNK), reason };
        await this.queue.add(GEO_PRECISION_TARGETED_JOB, data, {
          attempts: 1,
          removeOnComplete: { age: 24 * 60 * 60, count: 500 },
          removeOnFail: { age: 7 * 24 * 60 * 60, count: 200 },
        });
      }
      this.logger.log(`Queued precision backfill for ${unique.length} ${target} row(s)${reason ? ` (${reason})` : ''}.`);
    } catch (err: any) {
      this.logger.warn(
        `Could not queue precision backfill for ${unique.length} ${target} row(s): ${err?.message ?? err}. ` +
          `The nightly sweep will pick them up.`,
      );
    }
  }

  /** What precision the current data actually has — the number that justifies a backfill. */
  async summary(target: GeoTarget): Promise<PrecisionSummary> {
    const rows: Array<{ geoSource: string | null; geoAccuracyMeters: number | null }> =
      target === 'branch'
        ? await this.branchRepository.find({ where: { isActive: true }, select: ['geoSource', 'geoAccuracyMeters'] })
        : await this.assayerRepository.find({ where: { isActive: true }, select: ['geoSource', 'geoAccuracyMeters'] });

    const byTier: Record<string, number> = {};
    let imprecise = 0;
    let manual = 0;
    for (const row of rows) {
      const tier = row.geoSource ?? 'unknown';
      byTier[tier] = (byTier[tier] ?? 0) + 1;
      if (row.geoSource === 'manual') manual++;
      if (needsBetterFix(row.geoSource, row.geoAccuracyMeters)) imprecise++;
    }
    return { total: rows.length, imprecise, manual, byTier };
  }

  /**
   * Re-resolve the rows whose coordinate is too coarse to plan against.
   *
   * `limit` is a real bound, not a page size: the free providers allow about one request per
   * second (and a row costs several lookups — around nine seconds each, measured), so a
   * thousand-row estate is hours of work and the caller should be able to take it in bites.
   * Every row is independent — one failure never stops the run, for the same reason the import
   * does not.
   *
   * `ids` narrows the sweep to specific records — how an import hands over exactly the rows it
   * just placed coarsely, so they are upgraded minutes later instead of whenever the nightly
   * sweep gets round to them.
   *
   * ## Why the selection is a query and not a filter
   *
   * This used to `find({ isActive: true, take: limit * 4 })` and skip rows in memory. No filter,
   * no order: on a table where the first few hundred rows happen to be precise already, a
   * `limit=50` run examined none of them, found nothing to do, and returned — without ever
   * reaching the coarse rows further down. The backfill looked healthy and was a no-op. Now the
   * database hands back only rows that need work, worst placed first, then the ones that have
   * waited longest, and the bound applies to rows actually worked.
   */
  async backfill(target: GeoTarget, limit = 50, ids?: string[]): Promise<BackfillReport> {
    const report: BackfillReport = { examined: 0, improved: 0, unchanged: 0, protectedManual: 0, movedKm: [] };

    const repo: Repository<any> = target === 'branch' ? this.branchRepository : this.assayerRepository;
    const qb = repo
      .createQueryBuilder('r')
      .where('r.is_active = true')
      // Manual pins are never re-resolved; excluded in the query rather than counted and skipped.
      .andWhere("(r.geo_source IS NULL OR r.geo_source <> 'manual')")
      // The same predicate as `needsBetterFix`, expressed in SQL: never resolved, or coarser
      // than the pincode tier.
      .andWhere('(r.geo_source IS NULL OR r.geo_accuracy_meters IS NULL OR r.geo_accuracy_meters > :pin)', {
        pin: PRECISION_METERS.pincode,
      })
      // Worst first — a state centroid is a bigger lie than a district one — then oldest first,
      // so a row that failed last night is not starved by rows that arrived today.
      .orderBy('r.geoAccuracyMeters', 'DESC', 'NULLS FIRST')
      .addOrderBy('r.geoResolvedAt', 'ASC', 'NULLS FIRST')
      .take(limit);
    if (ids && ids.length > 0) qb.andWhere('r.id IN (:...ids)', { ids });

    const rows: any[] = await qb.getMany();

    for (const row of rows) {
      // Belt and braces against a stale row: the query already excluded these.
      if (row.geoSource === 'manual') {
        report.protectedManual++;
        continue;
      }
      if (!needsBetterFix(row.geoSource, row.geoAccuracyMeters)) continue;

      report.examined++;
      const before = { lat: Number(row.latitude), lng: Number(row.longitude), tier: row.geoSource ?? 'unknown' };

      let geo: GeoFields | null = null;
      try {
        geo = await resolveCoordinates(
          {
            address: row.address,
            city: row.city,
            district: row.district,
            state: row.state,
            pincode: row.pincode,
            name: target === 'branch' ? row.name : row.displayName,
            // The client's name is how the branch is tagged in OSM, if it is tagged at all.
            brand: target === 'branch' ? await this.clientNameFor(row.clientId) : null,
          },
          row,
        );
      } catch (err: any) {
        this.logger.warn(`Backfill failed for ${target} ${row.id}: ${err?.message ?? err}`);
        continue;
      }

      // No improvement is a perfectly good outcome — many rows genuinely cannot be placed more
      // precisely from free data, and rewriting them to an equally coarse point would only
      // churn coordinates that other things have already been planned against.
      if (!geo || (geo.geoAccuracyMeters ?? Infinity) >= (row.geoAccuracyMeters ?? Infinity)) {
        report.unchanged++;
        continue;
      }

      const km = isPlausibleIndianCoord(before.lat, before.lng)
        ? calculateHaversineDistance(before.lat, before.lng, geo.latitude!, geo.longitude!)
        : 0;

      Object.assign(row, geo);
      if (target === 'branch') await this.branchRepository.save(row);
      else await this.assayerRepository.save(row);

      report.improved++;
      report.movedKm.push({
        name: target === 'branch' ? `${row.name} (${row.solId})` : row.displayName,
        km: Math.round(km * 10) / 10,
        from: before.tier,
        to: geo.geoSource!,
      });
    }

    if (report.improved > 0) {
      await this.auditService.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'GEO_PRECISION_BACKFILL',
        entityType: target === 'branch' ? 'BRANCH' : 'ASSAYER',
        // A backfill sweeps many rows, so there is no one record to point at — and `null`,
        // which this used to pass, is not a value a `uuid NOT NULL` column accepts. The
        // sweep's subjects are in `metadata.moved`.
        entityId: NOT_A_RECORD_ENTITY_ID,
        userId: 'system',
        remarks:
          `Re-resolved ${report.improved} of ${report.examined} imprecise ${target} coordinate(s); ` +
          `${report.protectedManual} manual pin(s) left untouched.`,
        metadata: { moved: report.movedKm.slice(0, 50) },
      });
    }

    return report;
  }

  /**
   * Pin a record by hand — the only route to genuine 5–10 m accuracy.
   *
   * Sanity-checked rather than trusted blindly. A transposed pair (73.85, 18.52 instead of
   * 18.52, 73.85) is the classic mistake and puts an Indian branch in the Indian Ocean; a
   * mis-drop on the wrong side of a map puts it in the next state. Both are caught here, at the
   * moment they are made, instead of by whoever reads the map three weeks later — and both
   * report what is actually at the coordinate so the person can see their own error.
   */
  async pinManually(
    target: GeoTarget,
    id: string,
    lat: number,
    lng: number,
    userId: string,
    note?: string,
  ): Promise<GeoFields> {
    if (!isPlausibleIndianCoord(lat, lng)) {
      throw new BadRequestException(
        `${lat}, ${lng} is not a coordinate in India. Latitude comes first — check they are not swapped.`,
      );
    }

    const repo: Repository<any> = target === 'branch' ? this.branchRepository : this.assayerRepository;
    const row = await repo.findOne({ where: { id, isActive: true } });
    if (!row) throw new NotFoundException(`${target} ${id} was not found.`);

    // Best-effort: a reverse lookup that fails must not block someone fixing a bad pin.
    const actual = await reverseFreely({ lat, lng }).catch(() => null);
    if (actual?.state && row.state) {
      const norm = (v: string) => v.toLowerCase().replace(/[^a-z]/g, '');
      if (norm(actual.state) !== norm(row.state)) {
        throw new BadRequestException(
          `That point is in ${actual.state}, but this ${target} is recorded in ${row.state}. ` +
            `Move the pin, or correct the address first.`,
        );
      }
    }

    const geo: GeoFields = {
      latitude: lat,
      longitude: lng,
      location: { type: 'Point', coordinates: [lng, lat] },
      geoSource: 'manual' satisfies GeoPrecision,
      geoAccuracyMeters: PRECISION_METERS.manual,
      geoMatchedName: note?.trim() || actual?.display || 'Placed by hand',
      geoResolvedAt: new Date(),
    };

    const previous = { lat: Number(row.latitude), lng: Number(row.longitude), tier: row.geoSource };
    Object.assign(row, geo);
    row.updatedBy = userId;
    await repo.save(row);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: target === 'branch' ? 'BRANCH_PINNED_MANUALLY' : 'ASSAYER_PINNED_MANUALLY',
      entityType: target === 'branch' ? 'BRANCH' : 'ASSAYER',
      entityId: id,
      userId,
      remarks:
        `Coordinate pinned by hand to ${lat}, ${lng}` +
        (isPlausibleIndianCoord(previous.lat, previous.lng)
          ? `, ${calculateHaversineDistance(previous.lat, previous.lng, lat, lng).toFixed(1)} km from the previous ${previous.tier ?? 'unknown'} position.`
          : '.'),
      metadata: { previous, note: note ?? null },
    });

    return geo;
  }

  /** Rows still too coarse to plan against — the worklist for manual pinning. */
  async imprecise(target: GeoTarget, limit = 100): Promise<any[]> {
    const repo: Repository<any> = target === 'branch' ? this.branchRepository : this.assayerRepository;
    const rows = await repo.find({
      where: [
        { isActive: true, geoSource: IsNull() },
        { isActive: true, geoAccuracyMeters: Not(IsNull()) },
      ],
      take: limit * 4,
    });
    return rows
      .filter((r) => needsBetterFix(r.geoSource, r.geoAccuracyMeters))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        name: target === 'branch' ? r.name : r.displayName,
        code: target === 'branch' ? r.solId : r.assayerCode,
        address: r.address,
        city: r.city,
        district: r.district,
        state: r.state,
        pincode: r.pincode,
        latitude: r.latitude,
        longitude: r.longitude,
        geoSource: r.geoSource,
        geoAccuracyMeters: r.geoAccuracyMeters,
        geoMatchedName: r.geoMatchedName,
      }));
  }

  private clientNames = new Map<string, string | null>();
  private async clientNameFor(clientId: string | null): Promise<string | null> {
    if (!clientId) return null;
    if (this.clientNames.has(clientId)) return this.clientNames.get(clientId)!;
    const row = await this.branchRepository.manager
      .query('SELECT name FROM clients WHERE id = $1 LIMIT 1', [clientId])
      .catch(() => null);
    const name = row?.[0]?.name ?? null;
    this.clientNames.set(clientId, name);
    return name;
  }
}
