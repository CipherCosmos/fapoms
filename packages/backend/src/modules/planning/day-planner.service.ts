/**
 * FAPOMS — Day Planner Service
 *
 * Generates multi-branch day plans for assayers. Given a project and a target date,
 * this service:
 *   1. Clusters unassigned branches by geographic proximity (within a configurable radius).
 *   2. Validates cluster feasibility (total audit hours must fit an 8-10 hour workday).
 *   3. For each cluster, runs the recommendation engine per branch, then intersects
 *      to find assayers eligible for ALL branches in the cluster.
 *   4. Calculates the optimized route (TSP) for each candidate across the cluster.
 *   5. Enforces client preferences (skills, certifications, min/max distance) as hard filters.
 *   6. Returns ranked day plans with full cost, time, and route breakdowns.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity, AssayerWithWorkforceAttributes } from '../assayer/assayer.entity';
import { AssayerService } from '../assayer/assayer.service';
import { ClientEntity } from '../client/client.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { RoutingService, DestinationCoords } from '../geo/routing.provider';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { FeePolicyService } from '../pricing/fee-policy.service';
import { calculateHaversineDistance, AssayerStatus } from '@fapoms/shared';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface DayPlanStop {
  order: number;
  branchId: string;
  branchName: string;
  branchCode: string;
  address: string;
  latitude: number;
  longitude: number;
  estimatedAuditHours: number;
  travelFromPreviousKm: number;
  travelFromPreviousMinutes: number;
  estimatedArrival: string;   // HH:mm format
  estimatedDeparture: string; // HH:mm format
}

export interface DayPlanCandidate {
  assayerId: string;
  assayerName: string;
  assayerCode: string;
  assayerCity: string;
  assayerPhone: string;
  overallScore: number;
  totalBranches: number;
  totalAuditHours: number;
  totalTravelKm: number;
  totalTravelMinutes: number;
  totalDayHours: number;       // audit + travel converted to hours
  estimatedBaseFee: number;
  estimatedTravelFee: number;
  estimatedTotalCost: number;
  dayStartTime: string;        // e.g., "09:00"
  dayEndTime: string;          // e.g., "17:30"
  utilizationPercent: number;  // how much of the workday is productive audit vs. travel
  /**
   * Throughput economics. An assayer is engaged (and paid) for the whole day, so the number
   * that actually matters commercially is packets audited per paid day — not whether the
   * branches merely "fit". A 2-hour single-branch day and a 9-hour four-branch day can cost
   * the same; these fields make that difference visible instead of hiding it behind a
   * utilization percentage.
   */
  totalPackets: number;
  costPerPacket: number | null;   // null when packet counts are unknown for the cluster
  idleHours: number;              // paid-but-unproductive hours left in the working day
  stops: DayPlanStop[];
  clientPreferencesMatch: {
    skillsMatch: boolean;
    certificationsMatch: boolean;
    distanceWithinRange: boolean;
    isPreferredAssayer: boolean;
  };
}

export interface BranchCluster {
  clusterId: string;
  centerLatitude: number;
  centerLongitude: number;
  radiusKm: number;
  branches: Array<{
    id: string;
    branchId: string;
    branchName: string;
    branchCode: string;
    latitude: number;
    longitude: number;
    /** Packets to audit in THIS project cycle — the real driver of how long the branch takes. */
    packetCount: number | null;
    estimatedDurationHours: number;
    /** True when the hours above came from a stale static branch value rather than this cycle's packets. */
    durationFromStaticFallback: boolean;
    district: string;
    city: string;
  }>;
  /** Total packets across the cluster — the throughput this day actually buys. */
  totalPackets: number;
  totalEstimatedAuditHours: number;
  feasibleForOneDay: boolean;
}

/** One branch as it participates in clustering — sized by this cycle's workload. */
type ClusterMember = BranchCluster['branches'][number];

/** An assayer who could not be offered this cluster, and why. */
export interface ExcludedDayPlanCandidate {
  assayerId: string;
  displayName: string;
  reason: string;
  detail?: string;
}

export interface ProjectDayPlan {
  projectId: string;
  projectName: string;
  targetDate: string;
  /** Hard minimum km actually enforced (manual override, client floor, or both — the stricter wins). Null when neither applies. */
  effectiveMinDistanceKm: number | null;
  /**
   * Set when the requested date could not be worked (public holiday or weekend) and the
   * planner moved to the next working day instead. Previously the planner would happily plan
   * a national holiday and only fail later, at assign time, with "Holiday Conflict".
   */
  dateAdjustment: {
    requestedDate: string;
    reason: string;
  } | null;
  clusters: Array<{
    cluster: BranchCluster;
    dayPlans: DayPlanCandidate[];
    bestPlan: DayPlanCandidate | null;
    /** Previously silently dropped — this is what "no eligible assayers" actually meant. */
    excludedAssayers: ExcludedDayPlanCandidate[];
  }>;
  unclusteredBranches: Array<{
    branchId: string;
    branchName: string;
    reason: string;
  }>;
  /**
   * Branches that will consume a full paid day on their own while needing only a few hours.
   * These are the exact cases this whole mechanism exists to catch, and they were previously
   * skipped in silence (`if (cluster.branches.length <= 1) continue`), so the one thing ops
   * most needed to see never appeared anywhere.
   */
  underutilizedBranches: Array<{
    branchId: string;
    branchName: string;
    packetCount: number | null;
    auditHours: number;
    idleHours: number;
    note: string;
  }>;
  /**
   * Branches whose own workload exceeds a single working day.
   *
   * The planner assumed every branch fits in one day, so anything larger fell into
   * `unclusteredBranches` as "cluster exceeds daily capacity" and could never be planned — on
   * this engagement that was 43 of 64 branches, the largest needing 40 hours. "This branch
   * needs 4 assayer-days" is actionable coverage advice; "unclusterable" is a dead end that
   * repeats every time ops opens the screen.
   */
  multiDayBranches: Array<{
    branchId: string;
    branchName: string;
    packetCount: number | null;
    auditHours: number;
    daysRequired: number;
    note: string;
  }>;
  summary: {
    totalClusters: number;
    totalBranchesCovered: number;
    totalAssayersNeeded: number;
    estimatedTotalCost: number;
    averageUtilization: number;
    /** Packets bought by the assayer-days this plan commits to. */
    totalPackets: number;
    averagePacketsPerDay: number;
    averageCostPerPacket: number | null;
  };
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_DAILY_WORK_HOURS = 10;
const DAY_START_HOUR = 9; // 9:00 AM
const CLUSTER_RADIUS_KM = 80; // branches within 80km are candidates for bundling; feasibility filters (total day hours, utilization, client max distance) determine if bundling actually works
// Travel and base-fee rates resolve per client contract via FeePolicyService.
/** Matches the import-time default in project.service.ts so estimates stay consistent. */
const DEFAULT_MINUTES_PER_PACKET = 15;
/** Used only when a branch has neither a packet count for this cycle nor a stored estimate. */
const DEFAULT_AUDIT_HOURS = 4;
/** Idle hours on a paid day beyond which a lone branch is worth flagging to ops. */
const UNDERUTILIZED_IDLE_HOURS_THRESHOLD = 3;
/** How far forward to search for a workable date before giving up. */
const MAX_DATE_LOOKAHEAD_DAYS = 30;

// ─── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class DayPlannerService {
  private readonly logger = new Logger(DayPlannerService.name);

  constructor(
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    @InjectRepository(ClientEntity)
    private readonly clientRepository: Repository<ClientEntity>,
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepository: Repository<AssayerCommercialProfileEntity>,
    private readonly routingService: RoutingService,
    private readonly recommendationEngine: RecommendationEngine,
    private readonly constraintEvaluator: ConstraintEvaluator,
    private readonly assayerService: AssayerService,
    private readonly feePolicyService: FeePolicyService,
  ) {}

  /**
   * Main entry: generate day plans for all unassigned branches of a project.
   *
   * @param manualMinDistanceKm The operator's own "Min Radius Filter" value (same control used
   *   on the single-branch Planning view — pass undefined when that toggle is off). This is
   *   combined with the client's own configured `planningPreferences.minDistanceKm` and the
   *   stricter of the two is enforced as a hard exclusion — see `resolveMinDistanceKm`. The
   *   client's floor is never bypassable by turning the operator's toggle off; it's a
   *   configured business/conflict-of-interest rule, not a UI convenience.
   */
  /**
   * Accepts one project id or several.
   *
   * Planning a day used to be locked to a single project, which does not match how the work
   * actually happens: an assayer standing in a city with three branches nearby should audit
   * all three, and whether those branches belong to one engagement or three is an accounting
   * detail, not a routing one. Restricting to a project produced artificially short days and
   * left neighbouring branches for a second trip.
   *
   * Everything client-specific therefore becomes per-branch rather than per-run. A cluster can
   * legitimately span two banks, and each branch keeps its own client's audit-duration
   * agreement and rate card. The conflict-of-interest floor is taken as the strictest across
   * the clients in scope, so a branch is never offered to someone its own client excludes.
   */
  async generateDayPlans(
    projectIdOrIds: string | string[],
    targetDate?: string,
    manualMinDistanceKm?: number,
  ): Promise<ProjectDayPlan> {
    const projectIds = Array.isArray(projectIdOrIds) ? [...new Set(projectIdOrIds)] : [projectIdOrIds];
    if (projectIds.length === 0) {
      throw new NotFoundException('At least one project must be given to plan a day.');
    }

    const projects = await this.projectRepository.find({ where: { id: In(projectIds) } });
    if (projects.length === 0) {
      throw new NotFoundException(`No project found for ${projectIds.join(', ')}.`);
    }
    const project = projects[0];

    const clientIds = [...new Set(projects.map((p) => p.clientId).filter(Boolean))] as string[];
    const clients = clientIds.length
      ? await this.clientRepository.find({ where: { id: In(clientIds) }, relations: ['configuration'] })
      : [];

    const clientById = new Map(clients.map((c) => [c.id, c]));
    const projectById = new Map(projects.map((p) => [p.id, p]));
    /** The client that owns a given project, for per-branch configuration lookups. */
    const clientForProject = (pid: string) => {
      const cid = projectById.get(pid)?.clientId;
      return cid ? clientById.get(cid) ?? null : null;
    };
    const client = clients[0] ?? null;

    /**
     * The conflict-of-interest floor is the strictest across every client in scope.
     *
     * Taking the loosest — or only the first client's — would let a branch be offered to an
     * assayer that its own client's rule excludes, which is the entire point of the control.
     */
    const effectiveMinDistanceKm = clients.reduce<number | null>((strictest, c) => {
      const resolved = this.resolveMinDistanceKm(c, manualMinDistanceKm);
      if (resolved === null) return strictest;
      return strictest === null ? resolved : Math.max(strictest, resolved);
    }, this.resolveMinDistanceKm(null, manualMinDistanceKm));

    // Audit duration is contractual, so it follows the branch's own client rather than being
    // averaged or taken from whichever project happened to be listed first.
    const minutesPerPacketForProject = (pid: string) =>
      Number(clientForProject(pid)?.planningPreferences?.minutesPerPacket) || DEFAULT_MINUTES_PER_PACKET;
    const minutesPerPacket = minutesPerPacketForProject(project.id);

    // 1. Get unassigned project branches with branch details, across every project in scope
    const projectBranches = await this.projectBranchRepository.find({
      where: { projectId: In(projectIds), isActive: true },
      relations: ['branch'],
    });

    const unassigned = projectBranches.filter(
      (pb) => pb.status === 'IMPORTED' || pb.status === 'PLANNING' || pb.status === 'CANDIDATE_SEARCH',
    );

    // 2. Resolve a date the audit can actually be worked. Holidays are state-specific, so this
    //    needs the branches in scope — hence it runs after loading them.
    const { scheduledDate, dateStr, dateAdjustment } = await this.resolveWorkingDate(
      targetDate ? new Date(targetDate) : new Date(),
      unassigned,
      // Strictest calendar across the engagements in scope: a day only works if it works for
      // every client whose branches the plan covers.
      clients.map((c) => c.id),
    );

    // A plan spanning several engagements is labelled with all of them, so an operator is
    // never shown one project's name over a day that also covers another's branches.
    const planProjectId = projectIds.join(',');
    const planProjectName = projects.length === 1
      ? project.name
      : projects.map((p) => p.name).join(' + ');

    if (unassigned.length === 0) {
      return this.emptyPlan(planProjectId, planProjectName, dateStr);
    }

    // 3. Cluster branches by proximity, sizing each branch by THIS cycle's packet count
    // Per branch, not per run: audit duration is a contractual term of the branch's own
    // client, and a cluster may legitimately span two of them.
    const clusters = this.clusterBranches(unassigned, (pb) => minutesPerPacketForProject(pb.projectId));

    // Which client owns each branch in scope, so a cluster spanning two engagements prices
    // each branch against its own contract rather than whichever client came first.
    const clientByProjectBranchId = new Map(
      unassigned.map((pb) => [pb.id, clientForProject(pb.projectId)] as const),
    );

    // 4. Get all active assayers
    const assayers = await this.assayerRepository.find({
      where: { isActive: true, status: AssayerStatus.ACTIVE },
    });
    await this.assayerService.hydrateAllWorkforceAttributes(assayers);

    // 5. Generate day plans for each cluster
    const clusterResults: ProjectDayPlan['clusters'] = [];
    const unclusteredBranches: ProjectDayPlan['unclusteredBranches'] = [];
    const underutilizedBranches: ProjectDayPlan['underutilizedBranches'] = [];
    const multiDayBranches: ProjectDayPlan['multiDayBranches'] = [];

    for (const cluster of clusters) {
      if (!cluster.feasibleForOneDay) {
        // A lone branch that is itself larger than a working day is not a clustering failure —
        // it is a branch that needs several assayer-days. Say so, with the number.
        if (cluster.branches.length === 1) {
          const only = cluster.branches[0];
          const daysRequired = Math.ceil(cluster.totalEstimatedAuditHours / MAX_DAILY_WORK_HOURS);
          multiDayBranches.push({
            branchId: only.branchId,
            branchName: only.branchName,
            packetCount: only.packetCount,
            auditHours: parseFloat(cluster.totalEstimatedAuditHours.toFixed(1)),
            daysRequired,
            note: only.durationFromStaticFallback
              ? `~${cluster.totalEstimatedAuditHours.toFixed(1)}h of work needs about ${daysRequired} assayer-days. No packet count was recorded for this cycle, so this estimate comes from the branch default and may be inaccurate.`
              : `${only.packetCount} packet(s) ≈ ${cluster.totalEstimatedAuditHours.toFixed(1)}h, about ${daysRequired} assayer-days. Split it across consecutive days or assign more than one assayer.`,
          });
          continue;
        }

        for (const b of cluster.branches) {
          unclusteredBranches.push({
            branchId: b.branchId,
            branchName: b.branchName,
            reason: `Cluster total audit time (${cluster.totalEstimatedAuditHours.toFixed(1)}h) exceeds daily capacity (${MAX_DAILY_WORK_HOURS}h)`,
          });
        }
        continue;
      }

      // A branch with no neighbour close enough to bundle still consumes a whole paid day.
      // This used to `continue` silently, which hid the single most important signal this
      // mechanism exists to produce: "you are about to buy a full day for 2 hours of work."
      // Reported instead, with the idle time quantified, so ops can decide to defer it into a
      // later cycle where it can be bundled.
      if (cluster.branches.length <= 1) {
        const only = cluster.branches[0];
        if (only) {
          const idle = Math.max(0, MAX_DAILY_WORK_HOURS - cluster.totalEstimatedAuditHours);
          if (idle >= UNDERUTILIZED_IDLE_HOURS_THRESHOLD) {
            underutilizedBranches.push({
              branchId: only.branchId,
              branchName: only.branchName,
              packetCount: only.packetCount,
              auditHours: cluster.totalEstimatedAuditHours,
              idleHours: parseFloat(idle.toFixed(1)),
              note: only.durationFromStaticFallback
                ? `Needs ~${cluster.totalEstimatedAuditHours.toFixed(1)}h but occupies a full paid day (~${idle.toFixed(1)}h idle). No packet count recorded for this cycle — estimate is from the branch default, so this may be inaccurate.`
                : `${only.packetCount} packet(s) ≈ ${cluster.totalEstimatedAuditHours.toFixed(1)}h, leaving ~${idle.toFixed(1)}h of the paid day idle. No nearby branch was close enough to bundle.`,
            });
          }
        }
        continue;
      }

      let { dayPlans, excludedAssayers } = await this.generateClusterDayPlans(
        cluster, assayers, client, scheduledDate, effectiveMinDistanceKm, false, clientByProjectBranchId,
      );

      // Fallback: if no candidates found within client constraints, retry with relaxed
      // *maximum* distance to still surface options for remote branches. minDistanceKm is
      // never relaxed here — unlike maxDistanceKm (an optimization preference), it's a
      // conflict-of-interest/compliance floor and staying empty is the correct outcome if
      // every candidate is too close.
      if (dayPlans.length === 0) {
        ({ dayPlans, excludedAssayers } = await this.generateClusterDayPlans(
          cluster, assayers, client, scheduledDate, effectiveMinDistanceKm, true, clientByProjectBranchId,
        ));
      }

      const bestPlan = dayPlans.length > 0 ? dayPlans[0] : null;

      clusterResults.push({
        cluster,
        dayPlans: dayPlans.slice(0, 5), // top 5 candidates per cluster
        bestPlan,
        excludedAssayers,
      });
    }

    // 5. Global deconfliction: assign assayers to clusters maximizing total score
    this.globalOptimizeAssignments(clusterResults);

    // 6. Aggregate summary
    const bestPlans = clusterResults.filter((r) => r.bestPlan).map((r) => r.bestPlan!);
    const uniqueAssayers = new Set(bestPlans.map((p) => p.assayerId));

    const totalCost = bestPlans.reduce((sum, p) => sum + p.estimatedTotalCost, 0);
    const totalPackets = bestPlans.reduce((sum, p) => sum + p.totalPackets, 0);

    const summary = {
      totalClusters: clusterResults.length,
      totalBranchesCovered: bestPlans.reduce((sum, p) => sum + p.totalBranches, 0),
      totalAssayersNeeded: uniqueAssayers.size,
      estimatedTotalCost: totalCost,
      averageUtilization:
        bestPlans.length > 0
          ? bestPlans.reduce((sum, p) => sum + p.utilizationPercent, 0) / bestPlans.length
          : 0,
      totalPackets,
      // Each best plan is one assayer-day, so this is packets bought per paid day — the
      // headline number for whether the day is worth buying.
      averagePacketsPerDay: bestPlans.length > 0 ? parseFloat((totalPackets / bestPlans.length).toFixed(1)) : 0,
      averageCostPerPacket: totalPackets > 0 ? parseFloat((totalCost / totalPackets).toFixed(2)) : null,
    };

    return {
      projectId: planProjectId,
      projectName: planProjectName,
      targetDate: dateStr,
      effectiveMinDistanceKm,
      dateAdjustment,
      clusters: clusterResults,
      unclusteredBranches,
      underutilizedBranches,
      multiDayBranches,
      summary,
    };
  }

  /**
   * Finds a date the audit can actually be worked, moving forward from the requested one.
   *
   * Skips weekends and any date that is a public holiday in a state where one of these
   * branches sits (holidays are state-scoped, so a Maharashtra holiday shouldn't block a
   * Karnataka branch). Previously no holiday check existed here at all: the planner would
   * produce a full plan for, say, Independence Day, and the failure only surfaced later when
   * assignment creation rejected it with "Holiday Conflict" — after the operator had already
   * chosen an assayer.
   */
  private async resolveWorkingDate(
    requested: Date,
    branches: ProjectBranchEntity[],
    clientIds: string[] = [],
  ): Promise<{ scheduledDate: Date; dateStr: string; dateAdjustment: ProjectDayPlan['dateAdjustment'] }> {
    const states = [...new Set(branches.map((pb) => pb.branch?.state).filter(Boolean))] as string[];
    const requestedStr = requested.toISOString().split('T')[0];

    const candidate = new Date(requested);
    for (let attempt = 0; attempt <= MAX_DATE_LOOKAHEAD_DAYS; attempt++) {
      const blocker = await this.describeDateBlocker(candidate, states, clientIds);
      if (!blocker) {
        const dateStr = candidate.toISOString().split('T')[0];
        return {
          scheduledDate: candidate,
          dateStr,
          dateAdjustment: dateStr === requestedStr
            ? null
            : { requestedDate: requestedStr, reason: (await this.describeDateBlocker(requested, states, clientIds)) || 'Not a working day' },
        };
      }
      candidate.setDate(candidate.getDate() + 1);
    }

    // Nothing workable in range — return the original rather than silently inventing a date.
    return {
      scheduledDate: requested,
      dateStr: requestedStr,
      dateAdjustment: {
        requestedDate: requestedStr,
        reason: `No working day found within ${MAX_DATE_LOOKAHEAD_DAYS} days — check the holiday calendar.`,
      },
    };
  }

  /** Returns why a date can't be worked, or null when it can. */
  private async describeDateBlocker(date: Date, states: string[], clientIds: string[] = []): Promise<string | null> {
    /**
     * Weekends are decided by the holiday calendar, not here.
     *
     * This used to reject every Saturday outright, while HolidayService — the rule assignment
     * creation actually enforces — closes only the 2nd and 4th, because Indian banks trade on
     * the 1st, 3rd and 5th. The planner was therefore discarding working days that the rest of
     * the platform accepts, pushing plans forward for no reason, and the two components
     * disagreed about what a working day is.
     */
    const day = date.getDay();
    if (day === 0) return 'Falls on a Sunday';

    // Every client in scope must be able to work the day, and with no branch state to scope by
    // the national rule still applies.
    for (const clientId of clientIds.length > 0 ? clientIds : [undefined]) {
      for (const state of states.length > 0 ? states : ['']) {
        const result = await this.constraintEvaluator.checkHoliday(state, date, clientId);
        if (!result.passed) {
          if (day === 6) return 'Not a working Saturday for this client';
          return result.reason || `Public holiday in ${state}`;
        }
      }
    }
    return null;
  }

  /**
   * How many hours this branch's audit will take in THIS project cycle.
   *
   * Derived from the packet count on the project-branch, because that is what actually varies
   * between cycles — the same branch can be a 2-hour job one month and a full day the next.
   * `branches.estimated_duration_hours` is only a fallback: it is written once when the branch
   * is first imported and never refreshed, so by the second cycle it reflects some earlier
   * month's workload rather than the work now in front of the assayer.
   */
  private resolveAuditHours(
    pb: ProjectBranchEntity,
    minutesPerPacket: number,
  ): { hours: number; packetCount: number | null; fromStaticFallback: boolean } {
    const packetCount = pb.packetCount ?? null;
    if (packetCount !== null && packetCount > 0) {
      return {
        hours: parseFloat(((packetCount * minutesPerPacket) / 60).toFixed(2)),
        packetCount,
        fromStaticFallback: false,
      };
    }
    return {
      hours: Number(pb.branch?.estimatedDurationHours) || DEFAULT_AUDIT_HOURS,
      packetCount,
      fromStaticFallback: true,
    };
  }

  /**
   * Cluster nearby branches using a simple greedy approach:
   * Pick the first unvisited branch as cluster center,
   * then absorb all unvisited branches within CLUSTER_RADIUS_KM.
   */
  private clusterBranches(
    projectBranches: ProjectBranchEntity[],
    /**
     * Resolves the packet-minutes agreement for one branch. A function rather than a number
     * because a day plan can now span several projects, and each client's audit-duration term
     * follows its own branches.
     */
    minutesPerPacketFor: (pb: ProjectBranchEntity) => number,
  ): BranchCluster[] {
    const branchesWithCoords = projectBranches
      .filter((pb) => pb.branch?.latitude && pb.branch?.longitude)
      .map((pb) => {
        // Sized by this cycle's packets. Previously this read the static
        // branches.estimated_duration_hours, so a branch with only a handful of packets this
        // month was still budgeted its historical full-day estimate — which is precisely how
        // an assayer ends up paid for a day they finish in two hours.
        const { hours, packetCount, fromStaticFallback } = this.resolveAuditHours(pb, minutesPerPacketFor(pb));
        return {
          id: pb.id,
          branchId: pb.branchId,
          branchName: pb.branch.name,
          branchCode: pb.branch.branchCode,
          latitude: Number(pb.branch.latitude),
          longitude: Number(pb.branch.longitude),
          packetCount,
          estimatedDurationHours: hours,
          durationFromStaticFallback: fromStaticFallback,
          district: pb.branch.district,
          city: pb.branch.city,
        };
      })
      // Seed clusters from the heaviest branches so the biggest workloads anchor a day and
      // smaller neighbours fill the remaining capacity around them.
      .sort((a, b) => b.estimatedDurationHours - a.estimatedDurationHours);

    const visited = new Set<string>();
    const clusters: BranchCluster[] = [];
    let clusterIdx = 0;

    for (const branch of branchesWithCoords) {
      if (visited.has(branch.id)) continue;

      const clusterMembers = [branch];
      visited.add(branch.id);

      // Chain: keep expanding the cluster by checking distance from ANY member,
      // not just the seed. This groups branches that are connected via intermediate
      // branches within CLUSTER_RADIUS_KM.
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const other of branchesWithCoords) {
          if (visited.has(other.id)) continue;
          const nearAny = clusterMembers.some((m) =>
            calculateHaversineDistance(m.latitude, m.longitude, other.latitude, other.longitude) <= CLUSTER_RADIUS_KM
          );
          if (nearAny) {
            clusterMembers.push(other);
            visited.add(other.id);
            expanded = true;
          }
        }
      }

      // Check feasibility: total audit hours should fit a workday
      const totalAuditHours = clusterMembers.reduce((sum, b) => sum + b.estimatedDurationHours, 0);

      if (totalAuditHours <= MAX_DAILY_WORK_HOURS) {
        clusters.push(this.buildCluster(clusterMembers, clusterIdx));
        clusterIdx++;
      } else {
        // Split infeasible clusters into smaller sub-clusters using farthest-point seeding
        const subClusters = this.splitInfeasibleCluster(clusterMembers);
        for (const sub of subClusters) {
          clusters.push(this.buildCluster(sub, clusterIdx));
          clusterIdx++;
        }
      }
    }

    return clusters;
  }

  /**
   * Build a BranchCluster from a list of branch members.
   */
  private buildCluster(members: ClusterMember[], index: number): BranchCluster {
    const totalAuditHours = members.reduce((sum, b) => sum + b.estimatedDurationHours, 0);
    const totalPackets = members.reduce((sum, b) => sum + (b.packetCount ?? 0), 0);
    const centerLat = members.reduce((s, b) => s + b.latitude, 0) / members.length;
    const centerLng = members.reduce((s, b) => s + b.longitude, 0) / members.length;
    const maxDist = Math.max(
      ...members.map((b) => calculateHaversineDistance(centerLat, centerLng, b.latitude, b.longitude)),
    );

    return {
      clusterId: `CLU-${String(index + 1).padStart(3, '0')}`,
      centerLatitude: parseFloat(centerLat.toFixed(4)),
      centerLongitude: parseFloat(centerLng.toFixed(4)),
      radiusKm: parseFloat(maxDist.toFixed(1)),
      branches: members,
      totalPackets,
      totalEstimatedAuditHours: parseFloat(totalAuditHours.toFixed(1)),
      feasibleForOneDay: totalAuditHours <= MAX_DAILY_WORK_HOURS,
    };
  }

  /**
   * Split an infeasible cluster (total audit hours > daily max) into smaller feasible
   * sub-clusters using first-fit-decreasing bin packing: place the largest workloads first,
   * then fill each partially-used day with the largest remaining branch that still fits.
   * This packs each assayer-day as full as possible, which is the whole point — a day that
   * ends at 60% capacity still costs a full day.
   */
  private splitInfeasibleCluster(members: ClusterMember[]): ClusterMember[][] {
    const sorted = [...members].sort((a, b) => b.estimatedDurationHours - a.estimatedDurationHours);
    const subClusters: ClusterMember[][] = [];

    for (const branch of sorted) {
      let placed = false;
      for (const sub of subClusters) {
        const currentLoad = sub.reduce((s, b) => s + b.estimatedDurationHours, 0);
        if (currentLoad + branch.estimatedDurationHours <= MAX_DAILY_WORK_HOURS) {
          sub.push(branch);
          placed = true;
          break;
        }
      }
      if (!placed) {
        subClusters.push([branch]);
      }
    }

    return subClusters;
  }

  /**
   * The stricter of the operator's manual "Min Radius Filter" and the client's own configured
   * `planningPreferences.minDistanceKm`. The client's value is a real business/conflict-of-
   * interest floor (verified against seeded clients: SBI 5km, HDFC 10km) — it must not be
   * bypassable by an operator simply leaving their own toggle off. Returns null when neither
   * applies, meaning no minimum-distance exclusion is enforced.
   */
  private resolveMinDistanceKm(client: ClientEntity | null, manualMinDistanceKm?: number): number | null {
    const clientFloor = Number(client?.planningPreferences?.minDistanceKm);
    const values = [
      typeof manualMinDistanceKm === 'number' && manualMinDistanceKm > 0 ? manualMinDistanceKm : undefined,
      Number.isFinite(clientFloor) && clientFloor > 0 ? clientFloor : undefined,
    ].filter((v): v is number => v !== undefined);
    return values.length > 0 ? Math.max(...values) : null;
  }

  /**
   * For a given cluster of branches, find and rank assayers that can cover
   * all branches in one day, with route optimization.
   */
  private async generateClusterDayPlans(
    cluster: BranchCluster,
    assayers: AssayerEntity[],
    client: ClientEntity | null,
    scheduledDate: Date,
    effectiveMinDistanceKm: number | null,
    relaxDistance = false,
    /**
     * Owning client per branch. A day plan may now span several projects, so the base fee is
     * quoted per branch against its own client's rate card while travel — a single physical
     * route — is charged once for the day.
     */
    clientByProjectBranchId?: Map<string, ClientEntity | null>,
  ): Promise<{ dayPlans: DayPlanCandidate[]; excludedAssayers: ExcludedDayPlanCandidate[] }> {
    const planningPreferences = client?.planningPreferences || {};
    const requiredSkills: string[] = planningPreferences.requiredSkills || [];
    const requiredCerts: string[] = planningPreferences.requiredCertifications || [];
    const maxDistKm = relaxDistance ? Infinity : (Number(planningPreferences.maxDistanceKm) || Infinity);

    // One recommend() call per branch, not per (branch × assayer). This used to re-run the
    // full recommendation engine — its own DB queries, 6 eligibility filters, 15 scorers,
    // across every active assayer — inside a per-assayer loop: a 3-branch cluster with 8
    // candidate assayers issued 24 full engine runs instead of 3.
    //
    // Caching per branch also fixes a correctness gap, not just performance: eligibility here
    // now comes entirely from the same engine the single-branch Planning view uses
    // (availability, no-repeat-auditor rotation, client eligibility/restriction, required
    // skills/certifications, and every active business rule), replacing a hand-rolled
    // skill/cert-only check that had silently drifted from it. An assayer blocked by, say, the
    // "Certified Gold Assayer" business rule could previously still receive a day-plan card —
    // the rule engine was never consulted here at all.
    const branchRecommendations = new Map<
      string,
      { ranked: Awaited<ReturnType<RecommendationEngine['recommend']>>; excluded: ExcludedDayPlanCandidate[] }
    >();
    for (const branch of cluster.branches) {
      const branchEntity = await this.branchRepository.findOne({ where: { id: branch.branchId } });
      if (!branchEntity) continue;
      const ranked = await this.recommendationEngine.recommend(branchEntity, scheduledDate);
      branchRecommendations.set(branch.branchId, {
        ranked,
        excluded: ((ranked as any).excluded as ExcludedDayPlanCandidate[]) || [],
      });
    }

    const candidates: DayPlanCandidate[] = [];
    // Previously dropped silently — "No eligible assayers found" was the only signal, with no
    // way to tell a genuine dead end from one blocked assayer and a misconfigured rule.
    const excludedAssayers: ExcludedDayPlanCandidate[] = [];

    for (const assayerEntity of assayers) {
      const assayer = assayerEntity as AssayerWithWorkforceAttributes;
      if (!assayer.homeLatitude || !assayer.homeLongitude) continue;

      // ─── Eligibility: must be eligible for EVERY branch in the cluster ──
      let exclusion: ExcludedDayPlanCandidate | null = null;
      for (const branch of cluster.branches) {
        const rec = branchRecommendations.get(branch.branchId);
        if (!rec) continue;
        if (rec.ranked.some((r) => r.assayer.id === assayer.id)) continue;
        const entry = rec.excluded.find((e) => e.assayerId === assayer.id);
        exclusion = {
          assayerId: assayer.id,
          displayName: assayer.displayName,
          reason: entry?.reason ?? `Not eligible for ${branch.branchName}`,
          detail: entry?.detail,
        };
        break;
      }
      if (exclusion) {
        excludedAssayers.push(exclusion);
        continue;
      }

      /**
       * ─── Distance ────────────────────────────────────────────────────
       *
       * Home, deliberately — see AssayerEntity.homeLatitude. These distances decide two things
       * that must not move with a GPS reading: whether the assayer clears the client's
       * conflict-of-interest floor, and what travel allowance the day is quoted at. The
       * candidate list elsewhere ranks by live position instead, because "who is nearest right
       * now" is a different question from "what may we bill and who is eligible".
       */
      const aLat = assayer.homeLatitude!;
      const aLng = assayer.homeLongitude!;
      const branchDistances = cluster.branches.map((b) =>
        calculateHaversineDistance(aLat, aLng, b.latitude, b.longitude),
      );
      const maxBranchDist = Math.max(...branchDistances);
      const minBranchDist = Math.min(...branchDistances);

      if (maxBranchDist > maxDistKm) {
        excludedAssayers.push({
          assayerId: assayer.id,
          displayName: assayer.displayName,
          reason: `Too far — ${maxBranchDist.toFixed(0)}km exceeds the ${maxDistKm}km limit`,
        });
        continue;
      }

      // Hard exclusion. Unlike maxDistKm above, this is never relaxed by the "no candidates
      // found" retry in generateDayPlans() — it's a compliance floor, not an optimization
      // preference, so staying empty is the correct outcome when every candidate is too close.
      if (effectiveMinDistanceKm !== null && minBranchDist < effectiveMinDistanceKm) {
        excludedAssayers.push({
          assayerId: assayer.id,
          displayName: assayer.displayName,
          reason: `Too close — ${minBranchDist.toFixed(1)}km is within the ${effectiveMinDistanceKm}km minimum-distance rule`,
        });
        continue;
      }

      // ─── Route Optimization: TSP across cluster branches ───────────────
      const destinations: DestinationCoords[] = cluster.branches.map((b) => ({
        id: b.branchId,
        latitude: b.latitude,
        longitude: b.longitude,
      }));

      const routeResult = await this.routingService.optimizeRoute(
        // Same origin as the distances above, so the quoted travel matches the route quoted for.
        { latitude: assayer.homeLatitude!, longitude: assayer.homeLongitude! },
        destinations,
        true, // round trip back to assayer location
      );

      // ─── Build Time Schedule ───────────────────────────────────────────
      let currentMinutes = DAY_START_HOUR * 60; // 9:00 AM in minutes
      const stops: DayPlanStop[] = [];

      for (let i = 0; i < routeResult.optimizedSequence.length; i++) {
        const destId = routeResult.optimizedSequence[i];
        const step = routeResult.steps[i];
        const branchData = cluster.branches.find((b) => b.branchId === destId);
        if (!branchData) continue;

        const travelMinutes = step.durationMinutes;
        currentMinutes += travelMinutes; // arrive after travel

        const arrivalTime = this.minutesToTime(currentMinutes);
        const auditMinutes = branchData.estimatedDurationHours * 60;
        const departureTime = this.minutesToTime(currentMinutes + auditMinutes);

        stops.push({
          order: i + 1,
          branchId: branchData.branchId,
          branchName: branchData.branchName,
          branchCode: branchData.branchCode,
          address: `${branchData.city}, ${branchData.district}`,
          latitude: branchData.latitude,
          longitude: branchData.longitude,
          estimatedAuditHours: branchData.estimatedDurationHours,
          travelFromPreviousKm: parseFloat(step.distanceKm.toFixed(1)),
          travelFromPreviousMinutes: parseFloat(step.durationMinutes.toFixed(0)),
          estimatedArrival: arrivalTime,
          estimatedDeparture: departureTime,
        });

        currentMinutes += auditMinutes; // depart after audit
      }

      const totalTravelMinutes = routeResult.totalDurationMinutes;
      const totalTravelKm = routeResult.totalDistanceKm;
      const totalAuditHours = cluster.totalEstimatedAuditHours;
      const totalDayHours = totalAuditHours + totalTravelMinutes / 60;

      // Skip if the day exceeds max working hours (allow 2h grace)
      if (totalDayHours > MAX_DAILY_WORK_HOURS + 2) {
        excludedAssayers.push({
          assayerId: assayer.id,
          displayName: assayer.displayName,
          reason: `Day too long — ${totalDayHours.toFixed(1)}h exceeds the ${MAX_DAILY_WORK_HOURS + 2}h working-day limit`,
        });
        continue;
      }

      // Compute return travel from last branch back to assayer home.
      // (solveTSP adds the return trip to totalDurationMinutes but not to steps.)
      const stepMins = routeResult.steps.reduce((s, st) => s + st.durationMinutes, 0);
      const returnTravelMinutes = totalTravelMinutes - stepMins;

      const dayEndMinutes = currentMinutes + Math.max(0, returnTravelMinutes);
      const dayEndTime = this.minutesToTime(dayEndMinutes);

      // ─── Cost Calculation ──────────────────────────────────────────────
      // Quoted through the same calculator the assign path prices with, so the figure ops
      // sees on this screen is the figure that reaches the database. This previously used a
      // local `TRAVEL_FEE_PER_KM`, a 1500 base-fee default, and charged travel from the first
      // kilometre — none of which matched assignment.service.ts, so the day plan advertised
      // a price the server then declined to store.
      /**
       * Priced per branch against the contract that governs it.
       *
       * A cluster can now span projects, and therefore clients, so one rate card no longer
       * covers the day. Each branch's base fee comes from its own client; travel is a single
       * physical route and is charged once, against the client of the first stop, rather than
       * once per branch.
       */
      const distinctClients = new Set(
        cluster.branches.map((b) => clientByProjectBranchId?.get(b.id)?.id ?? client?.id ?? null),
      );

      let baseFee = 0;
      let travelFee = 0;

      if (distinctClients.size <= 1) {
        // Single client — one quote covers the whole cluster, as before.
        const quote = await this.feePolicyService.quote({
          assayerId: assayer.id,
          clientId: client?.id ?? null,
          configuration: client?.configuration ?? undefined,
          distanceKm: totalTravelKm,
          branchCount: cluster.branches.length,
          onDate: scheduledDate,
        });
        baseFee = quote.baseFee;
        travelFee = quote.travelFee;
      } else {
        const perBranchQuotes = await Promise.all(
          cluster.branches.map(async (b, index) => {
            const owner = clientByProjectBranchId?.get(b.id) ?? client;
            return this.feePolicyService.quote({
              assayerId: assayer.id,
              clientId: owner?.id ?? null,
              configuration: owner?.configuration ?? undefined,
              // Travel is attributed to the first stop only, so a shared journey is not
              // billed once per branch.
              distanceKm: index === 0 ? totalTravelKm : 0,
              branchCount: 1,
              onDate: scheduledDate,
            });
          }),
        );
        // Reported as the average per-branch rate, since the field is a single figure and the
        // branches may genuinely sit on different rate cards.
        baseFee = Math.round(
          perBranchQuotes.reduce((sum, q) => sum + q.baseFee, 0) / Math.max(1, perBranchQuotes.length),
        );
        travelFee = perBranchQuotes.reduce((sum, q) => sum + q.travelFee, 0);
      }

      // Same arithmetic either way: base fee applies per branch audited, travel once for the
      // route. (This matches what FeePolicyService.quote returns as `total` for one client.)
      const totalCost = baseFee * cluster.branches.length + travelFee;

      // ─── Score: recommendation engine scores averaged across branches, from the
      // per-branch cache built above — no longer re-invoking the engine here. ───
      let totalScore = 0;
      for (const branch of cluster.branches) {
        const match = branchRecommendations.get(branch.branchId)?.ranked.find((r) => r.assayer.id === assayer.id);
        totalScore += match ? match.score : 0;
      }
      const avgScore = cluster.branches.length > 0
        ? parseFloat((totalScore / cluster.branches.length).toFixed(1))
        : 0;

      // ─── Utilization: % of day spent on productive audit vs. total ────
      const utilizationPercent = totalDayHours > 0
        ? parseFloat(((totalAuditHours / totalDayHours) * 100).toFixed(1))
        : 0;

      // Skip candidates with very poor utilization (<60% productive audit time)
      if (utilizationPercent < 60) {
        excludedAssayers.push({
          assayerId: assayer.id,
          displayName: assayer.displayName,
          reason: `Low utilization — only ${utilizationPercent.toFixed(0)}% of the day would be productive audit time (need 60%+)`,
        });
        continue;
      }

      // ─── Client Preference Match Summary ───────────────────────────────
      // Informational only now — required skills/certifications are already enforced by the
      // engine's own filters above, so every surviving candidate matches by construction.
      // Kept here purely to render the confirmation badges the UI already shows.
      const assayerSkills = (assayer.skills || []).map((s: string) => s.toLowerCase());
      const assayerCerts = (assayer.certifications || []).map((c: any) =>
        (typeof c === 'string' ? c : c.name || '').toLowerCase(),
      );

      candidates.push({
        assayerId: assayer.id,
        assayerName: assayer.displayName,
        assayerCode: assayer.assayerCode,
        assayerCity: assayer.city,
        assayerPhone: assayer.phone,
        overallScore: avgScore,
        totalBranches: cluster.branches.length,
        totalAuditHours: parseFloat(totalAuditHours.toFixed(1)),
        totalTravelKm: parseFloat(totalTravelKm.toFixed(1)),
        totalTravelMinutes: parseFloat(totalTravelMinutes.toFixed(0)),
        totalDayHours: parseFloat(totalDayHours.toFixed(1)),
        estimatedBaseFee: baseFee * cluster.branches.length,
        estimatedTravelFee: travelFee,
        estimatedTotalCost: totalCost,
        dayStartTime: this.minutesToTime(DAY_START_HOUR * 60),
        dayEndTime,
        utilizationPercent,
        totalPackets: cluster.totalPackets,
        // Null rather than a misleading number when no packet counts are recorded for this
        // cycle — a fabricated cost-per-packet would be worse than none.
        costPerPacket: cluster.totalPackets > 0
          ? parseFloat((totalCost / cluster.totalPackets).toFixed(2))
          : null,
        // Paid-but-unproductive time: what's left of the working day once audit and travel
        // are done. This is the number that quantifies "we paid for a day and got two hours".
        idleHours: parseFloat(Math.max(0, MAX_DAILY_WORK_HOURS - totalDayHours).toFixed(1)),
        stops,
        clientPreferencesMatch: {
          skillsMatch: requiredSkills.length === 0 || requiredSkills.every((s) => assayerSkills.includes(s.toLowerCase())),
          certificationsMatch: requiredCerts.length === 0 || requiredCerts.every((c) => assayerCerts.includes(c.toLowerCase())),
          distanceWithinRange: maxBranchDist >= 0 && maxBranchDist <= maxDistKm,
          isPreferredAssayer: client?.preferredAssayers?.includes(assayer.id) || false,
        },
      });
    }

    // Sort by: highest score first, then lowest cost as tiebreaker
    candidates.sort((a, b) => {
      if (b.overallScore !== a.overallScore) return b.overallScore - a.overallScore;
      return a.estimatedTotalCost - b.estimatedTotalCost;
    });

    return { dayPlans: candidates, excludedAssayers };
  }

  /**
   * Global optimal assignment of assayers to clusters using branch-and-bound.
   * Each assayer can cover at most one cluster per day. This maximizes the
   * sum of overallScores across all clusters, avoiding the greedy order bias.
   */
  private globalOptimizeAssignments(
    clusterResults: Array<{
      cluster: BranchCluster;
      dayPlans: DayPlanCandidate[];
      bestPlan: DayPlanCandidate | null;
    }>,
  ): void {
    const n = clusterResults.length;

    // For each cluster, keep candidates with score > 0 (already sorted by score desc)
    const candidates = clusterResults.map((c) => c.dayPlans.filter((p) => p.overallScore > 0));

    // Upper bound: for cluster i..end, the best possible total if every cluster
    // gets its top-scoring candidate (optimistic bound for pruning).
    const maxRemaining = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      const topScore = candidates[i].length > 0 ? candidates[i][0].overallScore : 0;
      maxRemaining[i] = maxRemaining[i + 1] + topScore;
    }

    let bestScore = -1;
    let bestAssignment: (DayPlanCandidate | null)[] = new Array(n).fill(null);

    const dfs = (
      idx: number,
      assigned: Set<string>,
      currentScore: number,
      assignment: (DayPlanCandidate | null)[],
    ): void => {
      if (currentScore + maxRemaining[idx] <= bestScore) return; // prune

      if (idx === n) {
        bestScore = currentScore;
        bestAssignment = [...assignment];
        return;
      }

      // Try each eligible candidate for this cluster
      for (const plan of candidates[idx]) {
        if (assigned.has(plan.assayerId)) continue;
        assigned.add(plan.assayerId);
        assignment.push(plan);
        dfs(idx + 1, assigned, currentScore + plan.overallScore, assignment);
        assignment.pop();
        assigned.delete(plan.assayerId);
      }

      // Also valid: no assayer assigned to this cluster (e.g. Nagpur)
      assignment.push(null);
      dfs(idx + 1, assigned, currentScore, assignment);
      assignment.pop();
    };

    dfs(0, new Set(), 0, []);

    for (let i = 0; i < n; i++) {
      clusterResults[i].bestPlan = bestAssignment[i];
    }
  }

  private minutesToTime(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private emptyPlan(projectId: string, projectName: string, dateStr: string): ProjectDayPlan {
    return {
      projectId,
      projectName,
      targetDate: dateStr,
      effectiveMinDistanceKm: null,
      dateAdjustment: null,
      clusters: [],
      unclusteredBranches: [],
      underutilizedBranches: [],
      multiDayBranches: [],
      summary: {
        totalClusters: 0,
        totalBranchesCovered: 0,
        totalAssayersNeeded: 0,
        estimatedTotalCost: 0,
        averageUtilization: 0,
        totalPackets: 0,
        averagePacketsPerDay: 0,
        averageCostPerPacket: null,
      },
    };
  }
}
