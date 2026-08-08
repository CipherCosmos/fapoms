import { Inject, Injectable } from '@nestjs/common';
import { ProjectQueryService } from '../project/project-query.service';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { ClusterManager, BranchCluster } from './cluster.manager';
import { PlanningBranchProvider, AssayerAvailabilityProvider, WorkloadProvider } from './planning-providers.interface';
import { FeePolicyService } from '../pricing/fee-policy.service';

export interface CoverageWarning {
  type: string;
  message: string;
}

export interface UncoveredBranchInfo {
  branchId: string;
  branchName: string;
  reason: string;
}

export interface AssayerCapacityMetrics {
  assayerId: string;
  displayName: string;
  weeklyCapacity: number;
  currentAllocation: number;
  remainingCapacity: number;
  utilizationPercentage: number;
}

export interface CoveragePlanOutput {
  projectId: string;
  projectName: string;
  coveragePercentage: number;
  estimatedDurationDays: number;
  estimatedOperationalCost: number;
  requiredWorkforceCount: number;
  availableWorkforceCount: number;
  confidenceScore: number;
  uncoveredBranches: UncoveredBranchInfo[];
  warnings: CoverageWarning[];
  workforceCapacity: AssayerCapacityMetrics[];
  clusters: Array<{ id: string; name: string; branchCount: number; assignedAssayerName: string | null }>;
}

@Injectable()
export class CoveragePlanningEngine {
  constructor(
    private readonly projectQueryService: ProjectQueryService,
    private readonly recommendationEngine: RecommendationEngine,
    private readonly constraintEvaluator: ConstraintEvaluator,
    private readonly clusterManager: ClusterManager,
    private readonly feePolicyService: FeePolicyService,
    @Inject('PlanningBranchProvider')
    private readonly branchProvider: PlanningBranchProvider,
    @Inject('AssayerAvailabilityProvider')
    private readonly assayerProvider: AssayerAvailabilityProvider,
    @Inject('WorkloadProvider')
    private readonly workloadProvider: WorkloadProvider,
  ) {}

  async generateCoveragePlan(projectId: string): Promise<CoveragePlanOutput> {
    const project = await this.projectQueryService.findOne(projectId);
    const planningBranches = await this.branchProvider.getBranchesForPlanning(projectId);

    // Group branches into domain structures for clustering
    const activeBranches = planningBranches.map((pb) => {
      return {
        id: pb.branchId.value,
        name: pb.name,
        latitude: pb.location.latitude,
        longitude: pb.location.longitude,
      } as any;
    });

    const clusters = this.clusterManager.clusterBranches(activeBranches);

    const activeAssayers = await this.assayerProvider.getAvailableAssayers(new Date());
    const assayerIds = activeAssayers.map((a) => a.assayerId.value);
    const allocationMap = await this.workloadProvider.getAssayerCurrentWorkloads(assayerIds);

    const workforceCapacity: AssayerCapacityMetrics[] = activeAssayers.map((a) => {
      const weeklyCapacity = a.maxWeeklyWorkload || 15;
      const currentAllocation = allocationMap[a.assayerId.value] || 0;
      const remainingCapacity = Math.max(0, weeklyCapacity - currentAllocation);
      const utilizationPercentage = parseFloat(((currentAllocation / weeklyCapacity) * 100).toFixed(1));

      return {
        assayerId: a.assayerId.value,
        displayName: a.displayName,
        weeklyCapacity,
        currentAllocation,
        remainingCapacity,
        utilizationPercentage,
      };
    });

    const uncoveredBranches: UncoveredBranchInfo[] = [];
    const warnings: CoverageWarning[] = [];
    let matchedCount = 0;
    let totalEstimatedCost = 0;
    const assignedAssayerIds = new Set<string>();

    const clusterAssignments: Array<{ id: string; name: string; branchCount: number; assignedAssayerName: string | null }> = [];

    // Client and assayer roster are identical for every cluster in one project, so they are
    // fetched and hydrated once here instead of inside each of the (currently 31) per-cluster
    // recommend() calls. That repeated work was the bulk of this endpoint's four-second
    // response, and it grows with branch count.
    const preloaded = await this.recommendationEngine.preloadContext(project.clientId ?? null);

    // Solve matching on clusters
    for (const cluster of clusters) {
      let assignedAssayerName: string | null = null;
      let highestScore = -1;
      let selectedAssayer: any | null = null;

      /**
       * Score candidates against a real branch standing in for the cluster, positioned at the
       * cluster centre.
       *
       * This used to pass `id: cluster.id`, which is a synthetic string of the form
       * `cluster-<uuid>` minted by ClusterManager — not a branch id and not a UUID at all. The
       * recommendation engine runs genuine id-keyed queries with it (no-repeat-auditor history,
       * client eligibility), so Postgres rejected it outright:
       * `invalid input syntax for type uuid: "cluster-..."`. The whole endpoint 500'd every
       * time it was called, which nothing in the product currently does.
       *
       * Using the cluster's own nearest-to-centre branch keeps the geography (its coordinates
       * are overridden with the centre below) while making every id-keyed lookup resolve
       * against a branch that actually exists.
       */
      const representative = cluster.branches.reduce((closest, b) => {
        if (b.latitude == null || b.longitude == null) return closest;
        if (!closest) return b;
        const d = (x: any) =>
          Math.hypot(Number(x.latitude) - cluster.centerLatitude, Number(x.longitude) - cluster.centerLongitude);
        return d(b) < d(closest) ? b : closest;
      }, null as any) ?? cluster.branches[0];

      if (!representative) {
        for (const b of cluster.branches) {
          uncoveredBranches.push({
            branchId: b.id,
            branchName: b.name,
            reason: 'Cluster contains no branch with usable coordinates, so no assayer could be scored against it.',
          });
        }
        continue;
      }

      const clusterCenterBranch = {
        ...representative,
        latitude: cluster.centerLatitude,
        longitude: cluster.centerLongitude,
        clientId: project.clientId,
      } as any;

      const candidates = await this.recommendationEngine.recommend(clusterCenterBranch, new Date(), {}, preloaded);
      
      // Filter out double-booked or capacity-short candidates
      const validCandidates = candidates.filter((c) => {
        const remaining = (allocationMap[c.assayer.id] || 0) < (c.assayer.maxWeeklyWorkload || 15);
        return remaining;
      });

      if (validCandidates.length > 0) {
        selectedAssayer = validCandidates[0].assayer;
        highestScore = validCandidates[0].score;
        assignedAssayerName = selectedAssayer.displayName;
        assignedAssayerIds.add(selectedAssayer.id);

        allocationMap[selectedAssayer.id] = (allocationMap[selectedAssayer.id] || 0) + cluster.branches.length;
        matchedCount += cluster.branches.length;

        // Priced through the one calculator the rest of the platform quotes from. This was
        // `cluster.branches.length * 1500`, commented "Mock base fee cost calculation" — a
        // sixth independent copy of a fee rate, disagreeing with the contracted rate card and
        // ignoring both the assayer's own commercial profile and travel entirely.
        const clusterQuote = await this.feePolicyService.quote({
          assayerId: selectedAssayer.id,
          clientId: project.clientId ?? null,
          distanceKm: 0, // Cluster-level estimate: per-branch travel is resolved at assign time.
          branchCount: cluster.branches.length,
        });
        totalEstimatedCost += clusterQuote.total;
      } else {
        // Explanations for uncovered clusters
        for (const b of cluster.branches) {
          uncoveredBranches.push({
            branchId: b.id,
            branchName: b.name,
            reason: 'No eligible workforce candidate with available capacity within territorial range.',
          });
        }
      }

      clusterAssignments.push({
        id: cluster.id,
        name: cluster.name,
        branchCount: cluster.branches.length,
        assignedAssayerName,
      });
    }

    const totalBranchesCount = activeBranches.length;
    const coveragePercentage = totalBranchesCount > 0 ? parseFloat(((matchedCount / totalBranchesCount) * 100).toFixed(1)) : 0;

    // Confidence model calculation
    let confidenceScore = 100;
    if (coveragePercentage < 80) confidenceScore -= 30;
    if (uncoveredBranches.length > 0) confidenceScore -= 10;
    if (activeAssayers.length === 0) confidenceScore -= 50;

    // Risk warning generation
    if (coveragePercentage < 90) {
      warnings.push({
        type: 'COVERAGE_GAP',
        message: `Project coverage is suboptimal (${coveragePercentage}%). Five or more branches cannot be matching automatically.`,
      });
    }

    // Resolve average workloads counts from the WorkloadProvider mapping values
    const currentAssignmentsCount = Object.values(allocationMap).reduce((acc, curr) => acc + curr, 0);
    const avgWorkloadRatio = activeAssayers.length > 0 ? currentAssignmentsCount / activeAssayers.length : 0;
    if (avgWorkloadRatio > 10) {
      warnings.push({
        type: 'CAPACITY_WARNING',
        message: 'High overall workforce load; tight margins could result in schedule delays.',
      });
      confidenceScore -= 15;
    }

    return {
      projectId,
      projectName: project.name,
      coveragePercentage,
      /**
       * Working days to cover the plan, derived from the workforce actually assigned.
       *
       * Was `branches / 4` — a flat assumption that every assayer audits exactly four
       * branches a day, ignoring how many assayers were matched and what capacity they have
       * left. It produced the same answer for one assayer as for thirty.
       *
       * The honest basis is the capacity already computed above: each assayer's weekly
       * allowance spread over a five-day week gives a daily rate, and only the assayers this
       * plan actually assigns count toward it. Falls back to the branch count itself when no
       * assayer could be matched — that is a plan with no throughput, not a one-day plan.
       */
      estimatedDurationDays: (() => {
        const assigned = workforceCapacity.filter((w) => assignedAssayerIds.has(w.assayerId));
        if (assigned.length === 0 || matchedCount === 0) return totalBranchesCount || 1;
        const branchesPerDay = assigned.reduce((sum, w) => sum + w.weeklyCapacity / 5, 0);
        return branchesPerDay > 0 ? Math.max(1, Math.ceil(matchedCount / branchesPerDay)) : totalBranchesCount || 1;
      })(),
      estimatedOperationalCost: totalEstimatedCost,
      requiredWorkforceCount: assignedAssayerIds.size,
      availableWorkforceCount: activeAssayers.length,
      confidenceScore: Math.max(0, confidenceScore),
      uncoveredBranches,
      warnings,
      workforceCapacity,
      clusters: clusterAssignments,
    };
  }
}
