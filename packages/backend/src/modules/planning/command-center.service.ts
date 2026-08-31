import { Injectable, Logger } from '@nestjs/common';
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

/**
 * How many map pins one response may carry, per layer.
 *
 * The response used to include every branch and every assayer in scope. On a 40,000-branch book
 * that is a 25 MB JSON body — which the API serialises, the tunnel carries, and the browser
 * parses before drawing 40,000 individual Leaflet markers, none of which a human can read.
 *
 * Every AGGREGATE — totals, territory rollups, coverage gaps, idle capacity — is still computed
 * over the complete set, so no number on the page changes. Only the pin arrays are bounded, and
 * the response says so (`meta.branchPoints.truncated` and the totals beside it) so the map can
 * tell the operator they are looking at part of the book rather than pretending otherwise.
 *
 * Ordered so a truncated map keeps what the page exists to show: unreachable branches first,
 * then unassigned, then the heaviest workloads.
 *
 * The bound sat at 4,000 when the map drew a DOM marker for every pin it received, so the cap was
 * really protecting the browser from rendering thousands of nodes. The map now culls to the
 * viewport and draws only what is on screen, so a whole national roster (~6,000 branches) can be
 * sent and only the visible slice is ever built — zooming in reveals the rest, which it could not
 * do when the missing branches never left the server. The bound now guards only the wire payload
 * on the pathological 40,000-branch book (that 25 MB body), so it is raised to cover a real
 * roster with headroom while still catching the extreme case; `COMMAND_CENTER_MAX_POINTS` tunes it.
 */
const DEFAULT_MAX_POINTS = 20000;

/** The contracted ceiling for the joined client, in SQL. Falls back to the platform default. */
const CLIENT_RADIUS_SQL = `COALESCE(NULLIF(c.planning_preferences->>'maxDistanceKm','')::numeric, ${DEFAULT_SERVICEABLE_RADIUS_KM})`;

/**
 * Where a branch is, in SQL, for aliased table `b`.
 *
 * `COALESCE(location, ST_MakePoint(longitude, latitude))` because the two are written together
 * by the app but nothing in the schema enforces it, and a branch whose geometry column was
 * never populated must still appear on the map. Both the nearest-assayer KNN and the in-range
 * count measure from this exact expression, so they can never disagree about where a branch is.
 */
const BRANCH_GEOG_SQL = `COALESCE(b.location, ST_SetSRID(ST_MakePoint(b.longitude, b.latitude), 4326))::geography`;

/**
 * Impose a total order on a result set, by id, in memory.
 *
 * ## Why this exists at all
 *
 * Neither population query below can be left in whatever order its plan happens to emit. The
 * arrays they produce are sorted on non-unique keys (packets, distance, isolated-then-
 * unassigned) and then cut — `coverageGaps` at 25, the pin layers at `maxPoints` — and a sort
 * on a non-unique key is only as stable as its input. Where the keys tie, arrival order alone
 * decides which branch an operator is shown as the 25th worst-covered, and which 4,000 of
 * 4,526 assayers make it onto the map. Float accumulators are summed in arrival order too.
 *
 * ## Why in TypeScript and not `ORDER BY`
 *
 * `ORDER BY s.id, s.project_branch_id` on the branch query is the obvious spelling, and it was
 * written and measured first: it makes the planner spill an external merge sort of 40,087 wide
 * rows against a 4 MB `work_mem`, and took the unfiltered Command Room load from 1.07 s to
 * 1.94 s — an 81% regression on a query that exists only because it was too slow. Sorting the
 * same rows here moves object references rather than tuples: 1.11 s, about 40 ms of cost.
 *
 * Both spellings were verified to produce byte-identical responses across six filter scopes,
 * so this is purely the cheaper way to buy the same guarantee.
 *
 * The keys are uuids rendered as lowercase hex with hyphens at fixed positions, so plain
 * code-unit comparison gives byte-for-byte the same sequence Postgres' uuid ordering would;
 * `localeCompare` is deliberately not used, because collation is locale-dependent and that is
 * the entire class of bug this function exists to close.
 */
function orderedById<T extends Record<string, any>>(rows: T[], tieBreak?: string): T[] {
  // Spelled out rather than looped over a key list: this runs ~613,000 times on the unfiltered
  // book, and the loop plus its per-key property lookup was measurable against the sort itself.
  return rows.sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (!tieBreak || a[tieBreak] === b[tieBreak]) return 0;
    return a[tieBreak] < b[tieBreak] ? -1 : 1;
  });
}

@Injectable()
export class CommandCenterService {
  private readonly logger = new Logger(CommandCenterService.name);

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

    /**
     * The scoped book of work, as a FROM/WHERE fragment.
     *
     * Shared verbatim by the population query below and by the in-range count that runs
     * afterwards for the rows actually returned. One definition, so the two can never drift
     * into measuring different sets of branches.
     */
    const SCOPED_FROM = `FROM branches b
           JOIN project_branches pb ON pb.branch_id = b.id AND pb.is_active = true
           JOIN projects p ON p.id = pb.project_id AND p.is_active = true
           JOIN clients c ON c.id = p.client_id
          WHERE ${where.join(' AND ')}`;

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

    /**
     * Per branch: its workload, its money, and how far the nearest assayer is.
     *
     * ## Why this is one CTE pipeline and not four correlated subqueries
     *
     * It used to be exactly that, and it did not finish. Per branch row it ran: a correlated
     * COUNT over every assayer using `ST_DistanceSphere(ST_MakePoint(...), ST_MakePoint(...))`,
     * a `LATERAL … ORDER BY km LIMIT 1` that sorted the whole workforce again, a correlated
     * COUNT over assignments, and a SUM over billing_entries with a nested `IN (SELECT …)`.
     * Building the points inline means no index can be used, so the cost was
     * O(branches x assayers): measured 6.19 s for 500 branches on the 200k-row copy, which
     * extrapolates to roughly eight minutes for 40,000 project-branches — the statement timeout
     * (30 s) killed it first, so the Executive Map and its Excel export both returned 500 and
     * the 20-second cache could never populate.
     *
     * The rewrite keeps every output value identical and changes only how they are reached:
     *
     *  - nearest assayer: KNN (`<->`) on the geography cast, which is what
     *    `idx_assayers_location_geography` indexes, so each branch does one index descent
     *    instead of a full sort of the workforce.
     *  - assayers in range: `ST_DWithin(…::geography, …, metres, false)` as an index-usable
     *    spatial join rather than a subquery per row — since moved out to `fillAssayersInRange`,
     *    see below.
     *  - assignment counts and realised revenue: grouped once over the scoped branches.
     *
     * ## Why the nearest-assayer lookup is keyed on the branch, not the project_branch
     *
     * One branch can sit in several projects — 40,087 project_branches over 20,087 branches on
     * the scale book — and the KNN answer depends only on where the branch is, so running the
     * lateral per project_branch did the same index descent twice for half the country. It is
     * now computed once per distinct branch and fanned back out, which halves the descents.
     *
     * ## What is deliberately NOT here: `assayers_in_range`
     *
     * The in-range count was the single most expensive thing in this query — a spatial join
     * that visited 2.8 million (branch, assayer) pairs and spent ~2.8 s of a ~6.5 s query, to
     * produce a number that no aggregate on this page reads. It is a per-pin detail: the map's
     * side panel shows it for the one branch an operator clicked, and the Excel export carries
     * it for the pins in the response. Both only ever see the bounded arrays.
     *
     * So it is computed afterwards, for the rows actually returned, by `fillAssayersInRange`.
     * Everything that IS a full-population aggregate — isolated counts, average nearest-assayer
     * distance, coverage gaps, revenue — stays computed over every scoped branch, here.
     *
     * `isolated` is unaffected by the split because it was already derived from the KNN
     * distance rather than from this count (see `isolated` below for why that matters).
     *
     * ## Why the row order this returns is load-bearing
     *
     * Three things downstream read this row order as a tie-break, none of them obviously:
     *
     *  - `territories` and `territories[].districts` are sorted by `packets` descending. Where
     *    packets tie, `Array.prototype.sort` is stable, so the winner is whichever state or
     *    district this query happened to emit first.
     *  - `coverageGaps` is sorted by distance descending and cut at 25. Six branches tie at the
     *    boundary on the scale book, so row order alone decides which one an operator is shown
     *    as the 25th worst-covered branch.
     *  - The float accumulators behind `avgNearestAssayerKm` and the per-district `auditHours`
     *    are summed in arrival order, and float addition is not associative.
     *
     * Without a total order the plan is free to emit these 40,087 rows in any order, and it
     * does: measured here, `enable_mergejoin=off` alone reorders 79,400 positions and changes
     * the coverage-gap list and the accumulators, on identical data. Postgres can make that
     * choice by itself after a routine ANALYZE.
     *
     * The order is imposed in TypeScript, immediately below, rather than with an `ORDER BY`
     * here — see `orderedById` for why. It is deliberately not both: one owner, so the two
     * cannot drift into disagreeing.
     */
    const branches = await this.dataSource.query(
      `WITH scoped AS (
         SELECT b.id, b.name, b.branch_code, b.district, b.state,
                b.latitude, b.longitude,
                pb.id AS project_branch_id, pb.status AS branch_status,
                pb.packet_count, pb.scheduled_date,
                p.id AS project_id, p.name AS project_name,
                c.id AS client_id, c.name AS client_name,
                -- Per-client audit rate lives in the planning_preferences JSON, not a column.
                COALESCE((c.planning_preferences->>'minutesPerPacket')::numeric, 15) AS minutes_per_packet,
                ${CLIENT_RADIUS_SQL} AS serviceable_radius_km,
                ${BRANCH_GEOG_SQL} AS geog
           ${SCOPED_FROM}
       ),
       asg AS (
         SELECT a.project_branch_id, COUNT(*) AS assignment_count
           FROM assignments a
           JOIN scoped s ON s.project_branch_id = a.project_branch_id
          WHERE a.is_active = true AND a.status NOT IN ('CANCELLED','REJECTED')
          GROUP BY a.project_branch_id
       ),
       rev AS (
         SELECT a.project_branch_id, COALESCE(SUM(e.taxable_amount), 0) AS realised_revenue
           FROM billing_entries e
           JOIN assignments a ON a.id = e.assignment_id
           JOIN scoped s ON s.project_branch_id = a.project_branch_id
          WHERE e.is_active = true AND e.state <> 'CANCELLED' AND e.project_id = s.project_id
          GROUP BY a.project_branch_id
       ),
       -- The distinct places, so the KNN below runs once per branch rather than once per
       -- project_branch. The geog column is a pure function of the branch row, so this is
       -- exactly one row per branch id.
       sites AS (
         SELECT DISTINCT s.id AS branch_id, s.geog FROM scoped s
       ),
       nearest AS (
         SELECT sites.branch_id, near.assayer_id, near.display_name, near.km
           FROM sites
           LEFT JOIN LATERAL (
             SELECT a.id AS assayer_id, a.display_name,
                    ST_Distance(a.location::geography, sites.geog, false) / 1000 AS km
               FROM assayers a
              WHERE a.is_active = true AND a.status = 'ACTIVE' AND a.location IS NOT NULL${nearbyAssayerScope}
              ORDER BY a.location::geography <-> sites.geog
              LIMIT 1
           ) near ON sites.geog IS NOT NULL
       )
       SELECT s.id, s.name, s.branch_code, s.district, s.state, s.latitude, s.longitude,
              s.project_branch_id, s.branch_status, s.packet_count, s.scheduled_date,
              s.project_id, s.project_name, s.client_id, s.client_name,
              s.minutes_per_packet, s.serviceable_radius_km,
              nearest.assayer_id   AS nearest_assayer_id,
              nearest.display_name AS nearest_assayer_name,
              nearest.km           AS nearest_assayer_km,
              COALESCE(asg.assignment_count, 0)       AS assignment_count,
              COALESCE(rev.realised_revenue, 0)       AS realised_revenue
         FROM scoped s
         LEFT JOIN asg     ON asg.project_branch_id = s.project_branch_id
         LEFT JOIN rev     ON rev.project_branch_id = s.project_branch_id
         LEFT JOIN nearest ON nearest.branch_id = s.id`,
      params,
    );

    /**
     * The workforce layer. `open_assignments` was a correlated COUNT per assayer — one index
     * probe per person, 5,000 of them on a national roster; grouped once instead.
     *
     * This one is ordered below too, and here row order decides content rather than just
     * sequence: `assayerPoints` is cut to `maxPoints`, and on the scale book that is 4,000 of
     * 4,526 people. Which 526 got dropped was whatever the plan emitted last —
     * `enable_hashjoin=off` picks a different set on identical data. Every assayer aggregate
     * (headcount, daily capacity, territory rollups, `idleAssayers`) is computed over the full
     * roster and is unaffected; ordering only makes the bounded pin array reproducible.
     */
    const assayers = await this.dataSource.query(
      `WITH roster AS (
         SELECT a.id, a.display_name, a.assayer_code, a.district, a.state,
                a.latitude, a.longitude, a.max_daily_workload
           FROM assayers a
          WHERE ${assayerWhere.join(' AND ')}
       ),
       open_work AS (
         SELECT asg.assayer_id, COUNT(*) AS open_assignments
           FROM assignments asg
           JOIN roster r ON r.id = asg.assayer_id
          WHERE asg.is_active = true
            AND asg.status IN (${sqlStatusList(IN_FLIGHT_ASSIGNMENT_STATUSES)})
          GROUP BY asg.assayer_id
       )
       SELECT r.*, COALESCE(cp.base_fee, 0) AS base_fee,
              COALESCE(open_work.open_assignments, 0) AS open_assignments
         FROM roster r
         LEFT JOIN open_work ON open_work.assayer_id = r.id
         -- The profile in force TODAY. This had no date filter, so the cost shown on the
         -- command centre was the newest-starting row whether or not it had begun — a rate
         -- card dated for next quarter priced today's screen. One definition, shared:
         -- see pricing/profile-in-force.ts.
         LEFT JOIN LATERAL (
           SELECT base_fee FROM assayer_commercial_profiles
            WHERE assayer_id = r.id AND is_active = true
              AND effective_start_date <= NOW()
              AND (effective_end_date IS NULL OR effective_end_date >= NOW())
            ORDER BY effective_start_date DESC LIMIT 1
         ) cp ON true`,
      assayerParams,
    );

    const n = (v: any) => Number(v ?? 0);

    // ── Per-branch derived view ────────────────────────────────────────────
    // Total order, before anything reads these rows. `project_branch_id` alone would be unique;
    // leading with the branch id keeps a branch's several project-branches adjacent.
    const branchPoints = orderedById(branches, 'project_branch_id').map((b: any) => {
      const packets = n(b.packet_count);
      const auditHours = (packets * n(b.minutes_per_packet)) / 60;
      // Exact distance for comparisons, rounded only for display. Rounding first made a branch
      // whose nearest assayer is 150.03 km away read as exactly 150.0 and therefore inside a
      // 150 km radius — six branches on the scale book disagreed with the exact in-range count
      // until this was separated.
      const exactKm = b.nearest_assayer_km === null ? null : n(b.nearest_assayer_km);
      const km = exactKm === null ? null : Math.round(exactKm * 10) / 10;
      const radiusKm = n(b.serviceable_radius_km) || DEFAULT_SERVICEABLE_RADIUS_KM;
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
        // Filled in below, for the pins this response actually carries — see
        // `fillAssayersInRange`. Declared here so the key keeps its place in the response.
        assayersInRange: 0,
        // This branch's client-contracted ceiling, so downstream filters use the same number the
        // count above was measured against rather than a platform-wide guess.
        serviceableRadiusKm: radiusKm,
        realisedRevenue: n(b.realised_revenue),
        /**
         * Nobody within serviceable range means this branch cannot be staffed locally at all —
         * a hiring/partnering signal, not a scheduling one.
         *
         * Derived from the nearest-assayer distance rather than from the in-range count. The two
         * are exactly equivalent — if the closest person is beyond the radius then nobody is
         * inside it — but this one is free (the KNN already produced it) and it stays correct if
         * the count is ever bounded, which the count is the expensive half to compute.
         */
        isolated: exactKm === null || exactKm > radiusKm,
      };
    });

    const assayerPoints = orderedById(assayers, 'id').map((a: any) => ({
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
          // Internal only — the running total and divisor behind `avgNearestAssayerKm`.
          // Deliberately destructured off before the territory is returned: a float sum is
          // worth exactly as much as its summation order, and these two were reaching the
          // wire raw (`nearestKmSum: 268848.70000000414`) while every displayed figure
          // derived from them was already rounded and stable.
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
      // Kept out of the spread below rather than overwritten by it: these are the running
      // float total and its divisor, not outputs. See where they are initialised.
      const { nearestKmSum, nearestKmCount, ...territoryFields } = t;
      return {
        ...territoryFields,
        // Rounded to the same 1 dp every other hours figure on this response already uses
        // (branch, territory and total). Unrounded, a district carried the summation order
        // out with it — `auditHours: 110.39999999999999` against a neighbouring `58.1`.
        districts: [...t.districts.values()]
          .map((d: any) => ({ ...d, auditHours: Math.round(d.auditHours * 10) / 10 }))
          .sort((a: any, b: any) => b.packets - a.packets),
        auditHours: Math.round(t.auditHours * 10) / 10,
        demandAssayerDays: Math.round(demandDays * 10) / 10,
        dailyCapacity: t.dailyCapacity,
        // >1 means more work than local people can absorb in a day's cycle.
        loadRatio: capacityDays > 0 ? Math.round((demandDays / capacityDays) * 100) / 100 : null,
        avgNearestAssayerKm: nearestKmCount ? Math.round((nearestKmSum / nearestKmCount) * 10) / 10 : null,
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

    /**
     * Pin arrays, bounded. Sorted by what the map is for — unreachable branches, then
     * unassigned ones, then the largest workloads — so a truncated view still shows every
     * decision the page is meant to drive.
     */
    const maxPoints = Number(process.env.COMMAND_CENTER_MAX_POINTS) || DEFAULT_MAX_POINTS;
    const visibleBranchPoints =
      branchPoints.length <= maxPoints
        ? branchPoints
        : [...branchPoints]
            .sort(
              (a: any, b: any) =>
                Number(b.isolated) - Number(a.isolated) ||
                Number(!b.assigned) - Number(!a.assigned) ||
                b.packets - a.packets,
            )
            .slice(0, maxPoints);
    const visibleAssayerPoints =
      assayerPoints.length <= maxPoints ? assayerPoints : assayerPoints.slice(0, maxPoints);

    if (visibleBranchPoints.length < branchPoints.length || visibleAssayerPoints.length < assayerPoints.length) {
      // Said out loud: a bounded map that reports itself as complete is worse than a slow one.
      this.logger.warn(
        `Command centre map truncated to ${maxPoints} pins per layer ` +
          `(branches ${visibleBranchPoints.length}/${branchPoints.length}, ` +
          `assayers ${visibleAssayerPoints.length}/${assayerPoints.length}). ` +
          `Totals and territory rollups still cover everything. Raise COMMAND_CENTER_MAX_POINTS or scope the view.`,
      );
    }

    // Where to actually put the next assayer: the branches nobody can reach. Computed over the
    // full population, so a gap outside the bounded pin set still shows up here — 13 of the 25
    // on the scale book are — which is why the in-range lookup below covers both arrays.
    const coverageGaps = branchPoints
      // Against the branch's own client ceiling, carried through on the row.
      .filter((b: any) => b.isolated || (b.nearestAssayerKm ?? 0) > Number(b.serviceableRadiusKm ?? DEFAULT_SERVICEABLE_RADIUS_KM))
      .sort((a: any, b: any) => (b.nearestAssayerKm ?? 0) - (a.nearestAssayerKm ?? 0))
      .slice(0, 25);

    /**
     * The per-pin in-range count, for the pins that leave this method — the bounded map array
     * and the coverage-gap list. Both hold the same object references as `branchPoints`, so
     * writing the count onto the row here lands in both.
     */
    await this.fillAssayersInRange(
      [...new Set([...visibleBranchPoints, ...coverageGaps])],
      SCOPED_FROM,
      inRangeAssayerScope,
      params,
    );

    /**
     * The live map shows the whole branch master, not only branches that already sit in a project.
     *
     * The query above inner-joins through `project_branches`, so a branch imported through the
     * Branches page — which creates a master branch but attaches it to no project — never appeared
     * on the executive map at all. Those branches are appended here as plain pins: no packets, no
     * coverage math, no revenue, because there is no scheduled work to measure. The aggregates
     * above therefore stay a picture of *work*, while the map shows *every branch*.
     *
     * Skipped when a `projectId` scopes the view: the planning workspace map is deliberately that
     * one project's branches, so it must not gain the unrelated rest of the master list.
     */
    // Kept in their own array, never pushed into `branchPoints`/`visibleBranchPoints` — under the
    // cap those two are the SAME reference, so a push would silently add these to the work
    // aggregates (totals.branches, packets) this is meant to leave alone. Concatenated only into
    // the response's map array below.
    const extraBranchPoints: any[] = [];
    if (!filters.projectId) {
      const extraParams: any[] = [];
      const extraWhere: string[] = [
        'b.is_active = true',
        'NOT EXISTS (SELECT 1 FROM project_branches pb WHERE pb.branch_id = b.id AND pb.is_active = true)',
      ];
      // Scoped by the branch's own columns, so a branch with no project is still filtered the same
      // way the joined rows were — `b.client_id` stands in for the project's client.
      if (filters.clientId) { extraParams.push(filters.clientId); extraWhere.push(`b.client_id = $${extraParams.length}`); }
      if (filters.state) { extraParams.push(filters.state); extraWhere.push(`UPPER(b.state) = UPPER($${extraParams.length})`); }
      if (filters.zoneId) { extraParams.push(filters.zoneId); extraWhere.push(`b.zone_id = $${extraParams.length}`); }
      if (filters.regions?.length) { extraParams.push(filters.regions); extraWhere.push(`b.region = ANY($${extraParams.length})`); }

      const remaining = Math.max(0, maxPoints - visibleBranchPoints.length);
      if (remaining > 0) {
        const extras = await this.dataSource.query(
          `SELECT b.id, b.name, b.branch_code, b.district, b.state, b.latitude, b.longitude,
                  b.client_id, c.name AS client_name
             FROM branches b
             LEFT JOIN clients c ON c.id = b.client_id
            WHERE ${extraWhere.join(' AND ')}
            ORDER BY b.id
            LIMIT ${remaining}`,
          extraParams,
        );
        for (const b of extras) {
          extraBranchPoints.push({
            id: b.id,
            projectBranchId: null,
            name: b.name,
            branchCode: b.branch_code,
            district: b.district,
            state: canonicalState(b.state),
            rawState: b.state,
            latitude: b.latitude === null ? null : Number(b.latitude),
            longitude: b.longitude === null ? null : Number(b.longitude),
            status: null,
            clientId: b.client_id,
            clientName: b.client_name,
            projectId: null,
            packets: 0,
            auditHours: 0,
            scheduledDate: null,
            assigned: false,
            nearestAssayerKm: null,
            nearestAssayerName: null,
            assayersInRange: 0,
            serviceableRadiusKm: DEFAULT_SERVICEABLE_RADIUS_KM,
            realisedRevenue: 0,
            isolated: false,
          });
        }
      }
    }

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
      coverageGaps,
      // Idle capacity that could absorb work from a neighbouring territory.
      idleAssayers: assayerPoints
        .filter((a: any) => a.openAssignments === 0)
        .map((a: any) => ({ ...a, territoryPosture: territoryList.find((t: any) => t.state === a.state)?.posture ?? 'UNKNOWN' })),
      // Bounded — see DEFAULT_MAX_POINTS. The aggregates above cover everything. The project-less
      // master branches are concatenated here (live map only), never folded into the aggregates.
      branchPoints: [...visibleBranchPoints, ...extraBranchPoints],
      assayerPoints: visibleAssayerPoints,
      meta: {
        branchPoints: {
          returned: visibleBranchPoints.length + extraBranchPoints.length,
          // Every branch the map can show — the scheduled-work rows plus the project-less master
          // branches appended above — so "showing X of Y" counts what a person actually sees.
          total: branchPoints.length + extraBranchPoints.length,
          truncated: visibleBranchPoints.length < branchPoints.length,
        },
        assayerPoints: {
          returned: visibleAssayerPoints.length,
          total: assayerPoints.length,
          truncated: visibleAssayerPoints.length < assayerPoints.length,
        },
        pointLimit: maxPoints,
      },
    };
  }

  /**
   * How many active assayers can serve each of these branches, written onto the rows in place.
   *
   * This is the expensive half of the coverage picture and the only part that does not feed an
   * aggregate, so it runs over the pins the response actually carries rather than the whole
   * book: on the scale fixture that is ~4,000 rows instead of 40,087, and ~185 ms instead of
   * the ~2.8 s the same spatial join cost when it ran nationally.
   *
   * The measure is `ST_DWithin(…::geography, …, metres, false)`. `use_spheroid=false` is
   * load-bearing: it is the same spherical measure `ST_DistanceSphere` used before this was
   * ever indexed, and switching to the spheroid moves the boundary and changes counts.
   *
   * Counted per distinct (branch, radius) rather than per project_branch, because one branch can
   * sit in several projects and the catchment depends only on where it is and which client
   * ceiling applies; the result is then fanned back out to every project_branch on that pair.
   */
  private async fillAssayersInRange(
    rows: any[],
    scopedFrom: string,
    inRangeAssayerScope: string,
    scopeParams: any[],
  ): Promise<void> {
    const ids = [...new Set(rows.map((r) => r.projectBranchId).filter(Boolean))];
    if (!ids.length) return;

    const params = [...scopeParams, ids];
    const counts: Array<{ project_branch_id: string; assayers_in_range: string }> =
      await this.dataSource.query(
        `WITH scoped AS (
           SELECT b.id, pb.id AS project_branch_id,
                  ${CLIENT_RADIUS_SQL} AS serviceable_radius_km,
                  ${BRANCH_GEOG_SQL} AS geog
             ${scopedFrom}
              AND pb.id = ANY($${params.length}::uuid[])
         ),
         catchment AS (
           SELECT DISTINCT s.id AS branch_id, s.geog, s.serviceable_radius_km FROM scoped s
         ),
         -- MATERIALIZED is load-bearing, not decoration. The id list makes scoped unestimable
         -- (the planner guesses 1 row for a 200-element ANY(...) against a filtered project), and
         -- on that guess it happily puts this spatial join on the inner side of a nested loop and
         -- runs it once per scoped row: measured 2.1 s for a 200-branch project, versus 83 ms when
         -- the count is computed once. Materialising removes the planner's opportunity to make
         -- that choice at all, rather than hoping better statistics steer it away.
         catchment_counts AS MATERIALIZED (
           SELECT c2.branch_id, c2.serviceable_radius_km, COUNT(*) AS assayers_in_range
             FROM catchment c2
             JOIN assayers a2
               ON a2.is_active = true AND a2.status = 'ACTIVE' AND a2.location IS NOT NULL${inRangeAssayerScope}
              AND ST_DWithin(a2.location::geography, c2.geog, c2.serviceable_radius_km * 1000, false)
            GROUP BY c2.branch_id, c2.serviceable_radius_km
         )
         SELECT s.project_branch_id, cc.assayers_in_range
           FROM scoped s
           JOIN catchment_counts cc
             ON cc.branch_id = s.id AND cc.serviceable_radius_km = s.serviceable_radius_km`,
        params,
      );

    const byProjectBranch = new Map(counts.map((c) => [c.project_branch_id, Number(c.assayers_in_range ?? 0)]));
    // Absent means nobody in range — the same thing the old LEFT JOIN … COALESCE(…, 0) said.
    for (const row of rows) row.assayersInRange = byProjectBranch.get(row.projectBranchId) ?? 0;
  }
}
