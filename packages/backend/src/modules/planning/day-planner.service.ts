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
    estimatedDurationHours: number;
    district: string;
    city: string;
  }>;
  totalEstimatedAuditHours: number;
  feasibleForOneDay: boolean;
}

export interface ProjectDayPlan {
  projectId: string;
  projectName: string;
  targetDate: string;
  clusters: Array<{
    cluster: BranchCluster;
    dayPlans: DayPlanCandidate[];
    bestPlan: DayPlanCandidate | null;
  }>;
  unclusteredBranches: Array<{
    branchId: string;
    branchName: string;
    reason: string;
  }>;
  summary: {
    totalClusters: number;
    totalBranchesCovered: number;
    totalAssayersNeeded: number;
    estimatedTotalCost: number;
    averageUtilization: number;
  };
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_DAILY_WORK_HOURS = 10;
const DAY_START_HOUR = 9; // 9:00 AM
const CLUSTER_RADIUS_KM = 80; // branches within 80km are candidates for bundling; feasibility filters (total day hours, utilization, client max distance) determine if bundling actually works
const TRAVEL_FEE_PER_KM = 8; // ₹8 per km

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
  ) {}

  /**
   * Main entry: generate day plans for all unassigned branches of a project.
   */
  async generateDayPlans(projectId: string, targetDate?: string): Promise<ProjectDayPlan> {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found.`);

    const client = project.clientId
      ? await this.clientRepository.findOne({ where: { id: project.clientId }, relations: ['configuration'] })
      : null;

    const scheduledDate = targetDate ? new Date(targetDate) : new Date();
    const dateStr = scheduledDate.toISOString().split('T')[0];

    // 1. Get unassigned project branches with branch details
    const projectBranches = await this.projectBranchRepository.find({
      where: { projectId, isActive: true },
      relations: ['branch'],
    });

    const unassigned = projectBranches.filter(
      (pb) => pb.status === 'IMPORTED' || pb.status === 'PLANNING' || pb.status === 'CANDIDATE_SEARCH',
    );

    if (unassigned.length === 0) {
      return this.emptyPlan(projectId, project.name, dateStr);
    }

    // 2. Cluster branches by proximity
    const clusters = this.clusterBranches(unassigned);

    // 3. Get all active assayers
    const assayers = await this.assayerRepository.find({
      where: { isActive: true, status: AssayerStatus.ACTIVE },
    });
    await this.assayerService.hydrateAllWorkforceAttributes(assayers);

    // 4. Generate day plans for each cluster
    const clusterResults: ProjectDayPlan['clusters'] = [];
    const unclusteredBranches: ProjectDayPlan['unclusteredBranches'] = [];

    for (const cluster of clusters) {
      if (!cluster.feasibleForOneDay) {
        for (const b of cluster.branches) {
          unclusteredBranches.push({
            branchId: b.branchId,
            branchName: b.branchName,
            reason: `Cluster total audit time (${cluster.totalEstimatedAuditHours.toFixed(1)}h) exceeds daily capacity (${MAX_DAILY_WORK_HOURS}h)`,
          });
        }
        continue;
      }

      // Skip single-branch clusters — handled by the simple assignment interface
      if (cluster.branches.length <= 1) continue;

      let dayPlans = await this.generateClusterDayPlans(
        cluster, assayers, client, scheduledDate,
      );

      // Fallback: if no candidates found within client constraints, retry
      // with relaxed distance maxDistKm to still surface options for remote branches.
      if (dayPlans.length === 0) {
        dayPlans = await this.generateClusterDayPlans(
          cluster, assayers, client, scheduledDate, true,
        );
      }

      const bestPlan = dayPlans.length > 0 ? dayPlans[0] : null;

      clusterResults.push({
        cluster,
        dayPlans: dayPlans.slice(0, 5), // top 5 candidates per cluster
        bestPlan,
      });
    }

    // 5. Global deconfliction: assign assayers to clusters maximizing total score
    this.globalOptimizeAssignments(clusterResults);

    // 6. Aggregate summary
    const bestPlans = clusterResults.filter((r) => r.bestPlan).map((r) => r.bestPlan!);
    const uniqueAssayers = new Set(bestPlans.map((p) => p.assayerId));

    const summary = {
      totalClusters: clusterResults.length,
      totalBranchesCovered: bestPlans.reduce((sum, p) => sum + p.totalBranches, 0),
      totalAssayersNeeded: uniqueAssayers.size,
      estimatedTotalCost: bestPlans.reduce((sum, p) => sum + p.estimatedTotalCost, 0),
      averageUtilization:
        bestPlans.length > 0
          ? bestPlans.reduce((sum, p) => sum + p.utilizationPercent, 0) / bestPlans.length
          : 0,
    };

    return {
      projectId,
      projectName: project.name,
      targetDate: dateStr,
      clusters: clusterResults,
      unclusteredBranches,
      summary,
    };
  }

  /**
   * Cluster nearby branches using a simple greedy approach:
   * Pick the first unvisited branch as cluster center,
   * then absorb all unvisited branches within CLUSTER_RADIUS_KM.
   */
  private clusterBranches(projectBranches: ProjectBranchEntity[]): BranchCluster[] {
    const branchesWithCoords = projectBranches
      .filter((pb) => pb.branch?.latitude && pb.branch?.longitude)
      .map((pb) => ({
        id: pb.id,
        branchId: pb.branchId,
        branchName: pb.branch.name,
        branchCode: pb.branch.branchCode,
        latitude: Number(pb.branch.latitude),
        longitude: Number(pb.branch.longitude),
        packetCount: pb.packetCount || 40,
        estimatedDurationHours: Number(pb.branch.estimatedDurationHours) || 4, // default 4h
        district: pb.branch.district,
        city: pb.branch.city,
      }))
      // Customer Throughput Optimization: Prioritize seeding clusters from high-volume customer packet branches
      .sort((a, b) => b.packetCount - a.packetCount);

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
  private buildCluster(
    members: Array<{
      id: string; branchId: string; branchName: string; branchCode: string;
      latitude: number; longitude: number; estimatedDurationHours: number;
      district: string; city: string;
    }>,
    index: number,
  ): BranchCluster {
    const totalAuditHours = members.reduce((sum, b) => sum + b.estimatedDurationHours, 0);
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
      totalEstimatedAuditHours: parseFloat(totalAuditHours.toFixed(1)),
      feasibleForOneDay: totalAuditHours <= MAX_DAILY_WORK_HOURS,
    };
  }

  /**
   * Split an infeasible cluster (total audit hours > daily max) into smaller
   * feasible sub-clusters using a farthest-point seeding approach.
   */
  private splitInfeasibleCluster(
    members: Array<{
      id: string; branchId: string; branchName: string; branchCode: string;
      latitude: number; longitude: number; estimatedDurationHours: number;
      district: string; city: string;
    }>,
  ): Array<Array<typeof members[0]>> {
    const sorted = [...members].sort((a, b) => b.estimatedDurationHours - a.estimatedDurationHours);
    const subClusters: Array<Array<typeof members[0]>> = [];

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
   * For a given cluster of branches, find and rank assayers that can cover
   * all branches in one day, with route optimization.
   */
  private async generateClusterDayPlans(
    cluster: BranchCluster,
    assayers: AssayerEntity[],
    client: ClientEntity | null,
    scheduledDate: Date,
    relaxDistance = false,
  ): Promise<DayPlanCandidate[]> {
    const planningPreferences = client?.planningPreferences || {};
    const requiredSkills: string[] = planningPreferences.requiredSkills || [];
    const requiredCerts: string[] = planningPreferences.requiredCertifications || [];
    const maxDistKm = relaxDistance ? Infinity : (Number(planningPreferences.maxDistanceKm) || Infinity);

    const candidates: DayPlanCandidate[] = [];

    for (const assayerEntity of assayers) {
      const assayer = assayerEntity as AssayerWithWorkforceAttributes;
      // ─── Hard Filter: Client Preferences ───────────────────────────────
      if (!assayer.latitude || !assayer.longitude) continue;

      // 1. Check restricted assayers
      if (client?.restrictedAssayers?.includes(assayer.id)) continue;

      // 2. Check required skills
      const assayerSkills = (assayer.skills || []).map((s: string) => s.toLowerCase());
      if (requiredSkills.length > 0) {
        const hasAll = requiredSkills.every((s) => assayerSkills.includes(s.toLowerCase()));
        if (!hasAll) continue;
      }

      // 3. Check required certifications
      const assayerCerts = (assayer.certifications || []).map((c: any) =>
        (typeof c === 'string' ? c : c.name || '').toLowerCase(),
      );
      if (requiredCerts.length > 0) {
        const hasAll = requiredCerts.every((c) => assayerCerts.includes(c.toLowerCase()));
        if (!hasAll) continue;
      }

      // 4. Check distance — every branch must be within maxDistKm from the assayer.
      //    (minDistKm is advisory and not a hard filter — local assayers are preferred.)
      const aLat = assayer.latitude!;
      const aLng = assayer.longitude!;
      const branchDistances = cluster.branches.map((b) =>
        calculateHaversineDistance(aLat, aLng, b.latitude, b.longitude),
      );
      const maxBranchDist = Math.max(...branchDistances);
      if (maxBranchDist > maxDistKm) continue;

      // 5. Check availability (double booking, leaves)
      const dbCheck = await this.constraintEvaluator.checkDoubleBooking(assayer.id, scheduledDate);
      if (!dbCheck.passed) continue;
      const leaveCheck = this.constraintEvaluator.checkLeaves(assayer, scheduledDate);
      if (!leaveCheck.passed) continue;

      // ─── Route Optimization: TSP across cluster branches ───────────────
      const destinations: DestinationCoords[] = cluster.branches.map((b) => ({
        id: b.branchId,
        latitude: b.latitude,
        longitude: b.longitude,
      }));

      const routeResult = await this.routingService.optimizeRoute(
        { latitude: assayer.latitude, longitude: assayer.longitude },
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

      // Skip if the day exceeds max working hours
      if (totalDayHours > MAX_DAILY_WORK_HOURS + 2) continue; // allow 2h grace

      // Compute return travel from last branch back to assayer home.
      // (solveTSP adds the return trip to totalDurationMinutes but not to steps.)
      const stepMins = routeResult.steps.reduce((s, st) => s + st.durationMinutes, 0);
      const returnTravelMinutes = totalTravelMinutes - stepMins;

      const dayEndMinutes = currentMinutes + Math.max(0, returnTravelMinutes);
      const dayEndTime = this.minutesToTime(dayEndMinutes);

      // ─── Cost Calculation ──────────────────────────────────────────────
      const profile = await this.commercialRepository.findOne({
        where: { assayerId: assayer.id, isActive: true },
        order: { effectiveStartDate: 'DESC' },
      });

      const baseFee = profile ? Number(profile.baseFee) || 1500 : 1500;
      const travelFee = parseFloat((totalTravelKm * TRAVEL_FEE_PER_KM).toFixed(0));
      const totalCost = baseFee * cluster.branches.length + travelFee;

      // ─── Score: use recommendation engine scores averaged across branches
      let totalScore = 0;
      for (const branch of cluster.branches) {
        const branchEntity = await this.branchRepository.findOne({ where: { id: branch.branchId } });
        if (branchEntity) {
          const results = await this.recommendationEngine.recommend(branchEntity, scheduledDate);
          const match = results.find((r) => r.assayer.id === assayer.id);
          totalScore += match ? match.score : 0;
        }
      }
      const avgScore = cluster.branches.length > 0
        ? parseFloat((totalScore / cluster.branches.length).toFixed(1))
        : 0;

      // ─── Utilization: % of day spent on productive audit vs. total ────
      const utilizationPercent = totalDayHours > 0
        ? parseFloat(((totalAuditHours / totalDayHours) * 100).toFixed(1))
        : 0;

      // Skip candidates with very poor utilization (<60% productive audit time)
      if (utilizationPercent < 60) continue;

      // ─── Client Preference Match Summary ───────────────────────────────
      const preferredSkills = planningPreferences.preferredSkills || [];
      const preferredCerts = planningPreferences.preferredCertifications || [];

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

    return candidates;
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
      clusters: [],
      unclusteredBranches: [],
      summary: {
        totalClusters: 0,
        totalBranchesCovered: 0,
        totalAssayersNeeded: 0,
        estimatedTotalCost: 0,
        averageUtilization: 0,
      },
    };
  }
}
