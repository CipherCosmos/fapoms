import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { GlobalScope } from '../../infrastructure/scope/global-scope';

/**
 * Branch and assayer state names come from different sources — client branch
 * lists and internal rosters — and do not agree: a branch is in `MAHARASHTRA`
 * while an assayer living there is recorded under `Maharashtra` or `maharashtra`,
 * and `ANDRAPRADESH` faces `A.P`. Grouping on the raw value reports zero assayers
 * in every state, which would make the whole coverage picture confidently wrong.
 *
 * Canonicalising for comparison only; the display label stays human-readable.
 */
// Moved to @fapoms/shared so HolidayService (a different module) can use the
// exact same canonicalisation when matching a state-scoped holiday against a
// branch's state — re-exported here so existing imports keep working.
import { canonicalState } from '@fapoms/shared';
import { IN_FLIGHT_ASSIGNMENT_STATUSES, sqlStatusList } from '../assignment/assignment-workload';
export { canonicalState };

/** A working day an assayer can actually sell, in hours. */
const WORKING_HOURS_PER_DAY = 10;
/**
 * Fallback serviceable radius, for a client that has not contracted one.
 *
 * This used to be applied flat to every client, and no client is configured at 150: the seeded
 * contracts are 200 and 150, and the candidate pre-filter runs at 50. So for a client whose
 * ceiling is 200km, branches between 150 and 200 were reported as `isolated` and listed under
 * `coverageGaps` — described in this file as "a hiring/partnering signal" — while that client's
 * own rules permitted assigning them today. Headcount decisions were being driven off a number
 * nobody had agreed to.
 *
 * The client's `planning_preferences.maxDistanceKm` is the contracted figure and now governs;
 * this is only what applies when there isn't one.
 */
const DEFAULT_SERVICEABLE_RADIUS_KM = 150;

/** The contracted ceiling for the joined client, in SQL. Falls back to the platform default. */
const CLIENT_RADIUS_SQL = `COALESCE(NULLIF(c.planning_preferences->>'maxDistanceKm','')::numeric, ${DEFAULT_SERVICEABLE_RADIUS_KM})`;

@Injectable()
export class CommandCenterService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cache: CacheService,
  ) {}

  /**
   * Cached wrapper. The map loads every active branch and assayer and aggregates them in memory, so
   * it is expensive; the coverage picture changes slowly, so a short cluster-wide cache keyed by the
   * filters keeps repeated Command Room loads off the database. Fault-tolerant via CacheService.
   */
  async overview(filters: Partial<GlobalScope> = {}): Promise<any> {
    const TTL = Number(process.env.COMMAND_CENTER_CACHE_TTL_S) || 20;
    // Every dimension must be in the key. It previously keyed on clientId and state only; once
    // the global scope feeds this, a key that ignores region would serve one operator's region
    // to the next operator who loaded the map within the TTL.
    const key = [
      'planning:command-center',
      filters.clientId ?? 'all',
      filters.state ?? 'all',
      filters.zoneId ?? 'all',
      filters.projectId ?? 'all',
      filters.regions?.join('+') ?? 'all',
    ].join(':');
    return this.cache.wrap(key, TTL, () => this.computeOverview(filters));
  }

  /**
   * Geographic intelligence for the executive view.
   *
   * Answers the questions an executive actually asks about a field-audit book:
   * where is the work, where are the people, where do those two not line up, and
   * what is that worth. Coverage is computed from real coordinates rather than
   * matching state names, because the names disagree across sources and distance
   * is what actually determines whether an assayer can service a branch.
   */
  private async computeOverview(filters: Partial<GlobalScope> = {}): Promise<any> {
    const params: any[] = [];
    const where: string[] = ['b.is_active = true'];
    if (filters.clientId) { params.push(filters.clientId); where.push(`p.client_id = $${params.length}`); }
    // `state` was accepted by the controller and folded into the cache key, but never actually
    // applied to the query — the filter silently did nothing. It does now.
    if (filters.state) { params.push(filters.state); where.push(`UPPER(b.state) = UPPER($${params.length})`); }
    if (filters.zoneId) { params.push(filters.zoneId); where.push(`b.zone_id = $${params.length}`); }
    if (filters.projectId) { params.push(filters.projectId); where.push(`p.id = $${params.length}`); }
    // Held so the assayer sub-selects inside this same query can reuse the placeholder.
    let regionParam = '';
    if (filters.regions?.length) {
      params.push(filters.regions);
      regionParam = `$${params.length}`;
      where.push(`b.region = ANY(${regionParam})`);
    }
    // Applied to the nearest-assayer lateral join and the in-range count below. Without it the
    // map would report a branch as covered by an assayer the scoped operator cannot see or
    // dispatch — a coverage figure that looks reassuring and is not actionable.
    const nearbyAssayerScope = regionParam ? ` AND a.region = ANY(${regionParam})` : '';
    const inRangeAssayerScope = regionParam ? ` AND a2.region = ANY(${regionParam})` : '';

    // The assayer layer is scoped too, and only by region: an assayer has a home region but no
    // client or zone of their own. Scoping the *pins* without scoping the *people* would draw
    // one region's branches against the whole country's workforce, and every coverage number
    // derived from that pairing — nearest-assayer distance, capacity, the gap list — would be
    // quietly wrong rather than merely unfiltered.
    const assayerParams: any[] = [];
    const assayerWhere: string[] = ['a.is_active = true', `a.status = 'ACTIVE'`];
    if (filters.regions?.length) {
      assayerParams.push(filters.regions);
      assayerWhere.push(`a.region = ANY($${assayerParams.length})`);
    }

    // Per branch: its workload, its money, and how far the nearest assayer is.
    // The lateral join computes true nearest-assayer distance per branch — the
    // single most useful coverage signal, and impossible to get from state names.
    const branches = await this.dataSource.query(
      `SELECT b.id, b.name, b.branch_code, b.district, b.state,
              b.latitude, b.longitude,
              pb.id AS project_branch_id, pb.status AS branch_status,
              pb.packet_count, pb.scheduled_date,
              p.id AS project_id, p.name AS project_name,
              c.id AS client_id, c.name AS client_name,
              -- Per-client audit rate lives in the planning_preferences JSON, not a column.
              COALESCE((c.planning_preferences->>'minutesPerPacket')::numeric, 15) AS minutes_per_packet,
              near.assayer_id  AS nearest_assayer_id,
              near.display_name AS nearest_assayer_name,
              near.km          AS nearest_assayer_km,
              (SELECT COUNT(*) FROM assayers a2
                WHERE a2.is_active = true AND a2.status = 'ACTIVE'${inRangeAssayerScope}
                  AND a2.latitude IS NOT NULL
                  AND ST_DistanceSphere(
                        ST_SetSRID(ST_MakePoint(b.longitude, b.latitude), 4326),
                        ST_SetSRID(ST_MakePoint(a2.longitude, a2.latitude), 4326)
                      ) / 1000 <= ${CLIENT_RADIUS_SQL}
              ) AS assayers_in_range,
              ${CLIENT_RADIUS_SQL} AS serviceable_radius_km,
              (SELECT COUNT(*) FROM assignments asg
                WHERE asg.project_branch_id = pb.id AND asg.is_active = true
                  AND asg.status NOT IN ('CANCELLED','REJECTED')) AS assignment_count,
              (SELECT COALESCE(SUM(e.taxable_amount),0) FROM billing_entries e
                WHERE e.project_id = p.id AND e.is_active = true
                  AND e.assignment_id IN (SELECT id FROM assignments WHERE project_branch_id = pb.id)
              ) AS realised_revenue
         FROM branches b
         JOIN project_branches pb ON pb.branch_id = b.id AND pb.is_active = true
         JOIN projects p ON p.id = pb.project_id AND p.is_active = true
         JOIN clients c ON c.id = p.client_id
         LEFT JOIN LATERAL (
           SELECT a.id AS assayer_id, a.display_name,
                  ST_DistanceSphere(
                    ST_SetSRID(ST_MakePoint(b.longitude, b.latitude), 4326),
                    ST_SetSRID(ST_MakePoint(a.longitude, a.latitude), 4326)
                  ) / 1000 AS km
             FROM assayers a
            WHERE a.is_active = true AND a.status = 'ACTIVE' AND a.latitude IS NOT NULL${nearbyAssayerScope}
            ORDER BY km ASC
            LIMIT 1
         ) near ON b.latitude IS NOT NULL
        WHERE ${where.join(' AND ')}`,
      params,
    );

    const assayers = await this.dataSource.query(
      `SELECT a.id, a.display_name, a.assayer_code, a.district, a.state,
              a.latitude, a.longitude, a.max_daily_workload,
              COALESCE(cp.base_fee, 0) AS base_fee,
              (SELECT COUNT(*) FROM assignments asg
                WHERE asg.assayer_id = a.id AND asg.is_active = true
                  AND asg.status IN (${sqlStatusList(IN_FLIGHT_ASSIGNMENT_STATUSES)})) AS open_assignments
         FROM assayers a
         LEFT JOIN LATERAL (
           SELECT base_fee FROM assayer_commercial_profiles
            WHERE assayer_id = a.id AND is_active = true
            ORDER BY effective_start_date DESC LIMIT 1
         ) cp ON true
        WHERE ${assayerWhere.join(' AND ')}`,
      assayerParams,
    );

    const n = (v: any) => Number(v ?? 0);

    // ── Per-branch derived view ────────────────────────────────────────────
    const branchPoints = branches.map((b: any) => {
      const packets = n(b.packet_count);
      const auditHours = (packets * n(b.minutes_per_packet)) / 60;
      const km = b.nearest_assayer_km === null ? null : Math.round(n(b.nearest_assayer_km) * 10) / 10;
      return {
        id: b.id,
        projectBranchId: b.project_branch_id,
        name: b.name,
        branchCode: b.branch_code,
        district: b.district,
        state: canonicalState(b.state),
        rawState: b.state,
        latitude: b.latitude === null ? null : Number(b.latitude),
        longitude: b.longitude === null ? null : Number(b.longitude),
        status: b.branch_status,
        clientId: b.client_id,
        clientName: b.client_name,
        projectId: b.project_id,
        packets,
        auditHours: Math.round(auditHours * 10) / 10,
        scheduledDate: b.scheduled_date,
        assigned: n(b.assignment_count) > 0,
        nearestAssayerKm: km,
        nearestAssayerName: b.nearest_assayer_name,
        assayersInRange: n(b.assayers_in_range),
        // This branch's client-contracted ceiling, so downstream filters use the same number the
        // count above was measured against rather than a platform-wide guess.
        serviceableRadiusKm: n(b.serviceable_radius_km) || DEFAULT_SERVICEABLE_RADIUS_KM,
        realisedRevenue: n(b.realised_revenue),
        // Nobody within serviceable range means this branch cannot be staffed
        // locally at all — a hiring/partnering signal, not a scheduling one.
        isolated: n(b.assayers_in_range) === 0,
      };
    });

    const assayerPoints = assayers.map((a: any) => ({
      id: a.id,
      name: a.display_name,
      assayerCode: a.assayer_code,
      district: a.district,
      state: canonicalState(a.state),
      latitude: a.latitude === null ? null : Number(a.latitude),
      longitude: a.longitude === null ? null : Number(a.longitude),
      maxDailyWorkload: n(a.max_daily_workload) || 3,
      baseFee: n(a.base_fee),
      openAssignments: n(a.open_assignments),
    }));

    // ── Territory rollup ───────────────────────────────────────────────────
    // Demand is expressed in assayer-days, which is the unit capacity is also in.
    // Comparing branch counts to headcount would be meaningless: one 160-packet
    // branch is four days of work, one 16-packet branch is under an hour.
    const territories = new Map<string, any>();
    const territory = (state: string) => {
      if (!territories.has(state)) {
        territories.set(state, {
          state, branches: 0, packets: 0, auditHours: 0,
          assayers: 0, dailyCapacity: 0,
          assignedBranches: 0, unassignedBranches: 0, isolatedBranches: 0,
          realisedRevenue: 0, pipelineValue: 0,
          nearestKmSum: 0, nearestKmCount: 0,
          districts: new Map<string, any>(),
        });
      }
      return territories.get(state);
    };

    for (const b of branchPoints) {
      const t = territory(b.state);
      t.branches += 1;
      t.packets += b.packets;
      t.auditHours += b.auditHours;
      if (b.assigned) t.assignedBranches += 1; else t.unassignedBranches += 1;
      if (b.isolated) t.isolatedBranches += 1;
      t.realisedRevenue += b.realisedRevenue;
      if (b.nearestAssayerKm !== null) { t.nearestKmSum += b.nearestAssayerKm; t.nearestKmCount += 1; }

      const dKey = b.district || 'UNKNOWN';
      if (!t.districts.has(dKey)) {
        t.districts.set(dKey, { district: dKey, branches: 0, packets: 0, auditHours: 0, unassigned: 0, isolated: 0, assayers: 0 });
      }
      const d = t.districts.get(dKey);
      d.branches += 1; d.packets += b.packets; d.auditHours += b.auditHours;
      if (!b.assigned) d.unassigned += 1;
      if (b.isolated) d.isolated += 1;
    }

    for (const a of assayerPoints) {
      const t = territory(a.state);
      t.assayers += 1;
      t.dailyCapacity += a.maxDailyWorkload;
      const dKey = a.district || 'UNKNOWN';
      if (t.districts.has(dKey)) t.districts.get(dKey).assayers += 1;
    }

    // Pipeline value: what the outstanding work is worth at the average local
    // assayer fee. Realised revenue alone reads as zero on a book that has not
    // been audited yet, which says nothing about where the opportunity is.
    const avgFee = assayerPoints.length
      ? assayerPoints.reduce((sum: number, a: any) => sum + a.baseFee, 0) / (assayerPoints.filter((a: any) => a.baseFee > 0).length || 1)
      : 0;

    const territoryList = [...territories.values()].map((t) => {
      const demandDays = t.auditHours / WORKING_HOURS_PER_DAY;
      const capacityDays = t.dailyCapacity; // branch-slots per day ≈ days of capacity per day
      const unassignedShare = t.branches ? t.unassignedBranches / t.branches : 0;
      t.districts = [...t.districts.values()].sort((a: any, b: any) => b.packets - a.packets);
      return {
        ...t,
        auditHours: Math.round(t.auditHours * 10) / 10,
        demandAssayerDays: Math.round(demandDays * 10) / 10,
        dailyCapacity: t.dailyCapacity,
        // >1 means more work than local people can absorb in a day's cycle.
        loadRatio: capacityDays > 0 ? Math.round((demandDays / capacityDays) * 100) / 100 : null,
        avgNearestAssayerKm: t.nearestKmCount ? Math.round((t.nearestKmSum / t.nearestKmCount) * 10) / 10 : null,
        pipelineValue: Math.round(t.branches * avgFee),
        unassignedShare: Math.round(unassignedShare * 100),
        // The headline judgement for this territory.
        posture:
          t.assayers === 0 ? 'NO_COVERAGE'
          : capacityDays > 0 && demandDays / capacityDays > 1.5 ? 'UNDER_RESOURCED'
          : capacityDays > 0 && demandDays / capacityDays < 0.35 ? 'UNDER_UTILISED'
          : 'BALANCED',
      };
    }).sort((a: any, b: any) => b.packets - a.packets);

    const totalPackets = branchPoints.reduce((sum: number, b: any) => sum + b.packets, 0);
    const totalHours = branchPoints.reduce((sum: number, b: any) => sum + b.auditHours, 0);
    const totalCapacity = assayerPoints.reduce((sum: number, a: any) => sum + a.maxDailyWorkload, 0);

    return {
      generatedAt: new Date().toISOString(),
      // Reported as the default; each branch was measured against its own client's ceiling.
      serviceableRadiusKm: DEFAULT_SERVICEABLE_RADIUS_KM,
      totals: {
        branches: branchPoints.length,
        assayers: assayerPoints.length,
        packets: totalPackets,
        auditHours: Math.round(totalHours * 10) / 10,
        demandAssayerDays: Math.round((totalHours / WORKING_HOURS_PER_DAY) * 10) / 10,
        dailyCapacity: totalCapacity,
        unassignedBranches: branchPoints.filter((b: any) => !b.assigned).length,
        isolatedBranches: branchPoints.filter((b: any) => b.isolated).length,
        realisedRevenue: Math.round(branchPoints.reduce((sum: number, b: any) => sum + b.realisedRevenue, 0)),
        pipelineValue: Math.round(branchPoints.length * avgFee),
        statesCovered: territoryList.length,
      },
      territories: territoryList,
      // Where to actually put the next assayer: the branches nobody can reach.
      coverageGaps: branchPoints
        // Against the branch's own client ceiling, carried through on the row.
        .filter((b: any) => b.isolated || (b.nearestAssayerKm ?? 0) > Number(b.serviceableRadiusKm ?? DEFAULT_SERVICEABLE_RADIUS_KM))
        .sort((a: any, b: any) => (b.nearestAssayerKm ?? 0) - (a.nearestAssayerKm ?? 0))
        .slice(0, 25),
      // Idle capacity that could absorb work from a neighbouring territory.
      idleAssayers: assayerPoints
        .filter((a: any) => a.openAssignments === 0)
        .map((a: any) => ({ ...a, territoryPosture: territoryList.find((t: any) => t.state === a.state)?.posture ?? 'UNKNOWN' })),
      branchPoints,
      assayerPoints,
    };
  }
}
