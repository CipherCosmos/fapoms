import { Inject, Injectable } from '@nestjs/common';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { ProjectQueryService } from '../project/project-query.service';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { ClusterManager, BranchCluster } from './cluster.manager';
import { PlanningBranchProvider, AssayerAvailabilityProvider, WorkloadProvider } from './planning-providers.interface';
import { FeePolicyService } from '../pricing/fee-policy.service';
import { DEFAULT_WEEKLY_CAPACITY } from '../assignment/assignment-workload';
import { calculateHaversineDistance } from '@fapoms/shared';
// Type-only, so nothing about queues is linked into this engine at runtime. The engine reports
// "branch N of M" and stays ignorant of what, if anything, is watching.
import type { ProgressCallback } from './queued-job';

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
  clusters: Array<{
    id: string;
    name: string;
    branchCount: number;
    assignedAssayerName: string | null;
    /**
     * Identifiers, not just labels. The approved plan is the authority for what gets deployed,
     * so execution must be able to create exactly the assignments that were approved. Storing
     * only `assignedAssayerName` made that impossible, and `executeApprovedPlan` compensated
     * with a hardcoded assayer, the first project branch, and a flat fee.
     */
    assignedAssayerId: string | null;
    branchIds: string[];
    /** Quoted at plan time through FeePolicyService, so deployment prices what was approved. */
    estimatedTotalFee: number | null;
    /**
     * Per-branch assignment: each branch's OWN top-recommended assayer and quoted fee. The cluster
     * groups branches for routing, but the assignment decision is made per branch (a branch on the
     * cluster edge can have a different best assayer than the cluster centre), and deployment
     * honours these rather than stamping one cluster-wide assayer onto every branch.
     */
    branchAssignments: Array<{ branchId: string; branchName: string; assayerId: string | null; assayerName: string | null; fee: number | null; rank: number | null; selectionNote: string | null }>;
  }>;
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

  /**
   * @param onProgress Optional "branch N of M" hook. Present when this runs as a queued job, so
   *   the poll endpoint can show something truer than a spinner: the per-branch loop below is
   *   where essentially all of the measured 6.8 s (200-branch project, scale database) is spent,
   *   and it is the only phase whose remaining work is knowable in advance. Omitted by the
   *   synchronous route, which has nobody to report to.
   */
  async generateCoveragePlan(
    projectId: string,
    scope?: Partial<GlobalScope>,
    onProgress?: ProgressCallback,
  ): Promise<CoveragePlanOutput> {
    const project = await this.projectQueryService.findOne(projectId);
    const planningBranches = await this.branchProvider.getBranchesForPlanning(projectId, scope);

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

    const activeAssayers = await this.assayerProvider.getAvailableAssayers(new Date(), scope);
    const assayerIds = activeAssayers.map((a) => a.assayerId.value);
    const allocationMap = await this.workloadProvider.getAssayerCurrentWorkloads(assayerIds);

    const workforceCapacity: AssayerCapacityMetrics[] = activeAssayers.map((a) => {
      const weeklyCapacity = a.maxWeeklyWorkload || DEFAULT_WEEKLY_CAPACITY;
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

    const clusterAssignments: Array<{
    id: string;
    name: string;
    branchCount: number;
    assignedAssayerName: string | null;
    /**
     * Identifiers, not just labels. The approved plan is the authority for what gets deployed,
     * so execution must be able to create exactly the assignments that were approved. Storing
     * only `assignedAssayerName` made that impossible, and `executeApprovedPlan` compensated
     * with a hardcoded assayer, the first project branch, and a flat fee.
     */
    assignedAssayerId: string | null;
    branchIds: string[];
    /** Quoted at plan time through FeePolicyService, so deployment prices what was approved. */
    estimatedTotalFee: number | null;
    branchAssignments: Array<{ branchId: string; branchName: string; assayerId: string | null; assayerName: string | null; fee: number | null; rank: number | null; selectionNote: string | null }>;
  }> = [];

    // Client and assayer roster are identical for every cluster in one project, so they are
    // fetched and hydrated once here instead of inside each of the (currently 31) per-cluster
    // recommend() calls. That repeated work was the bulk of this endpoint's four-second
    // response, and it grows with branch count.
    const preloaded = await this.recommendationEngine.preloadContext(project.clientId ?? null);

    // The client's hard serviceability ceiling. The recommendation engine only *penalises* distance
    // beyond this in scoring (it's a soft preference there), but assignment creation enforces it as
    // a hard rule — so without this the plan would propose an assayer 600km away and deployment
    // would reject it as "out of range". Applied as a hard filter here so the plan only proposes
    // assayers that can actually be assigned, and honestly marks the rest uncovered.
    const clientMaxDistanceKm = Number((preloaded.client as any)?.planningPreferences?.maxDistanceKm) || Infinity;

    // Solve matching PER BRANCH. The cluster still groups branches for routing/display, but the
    // assignment decision is made for each branch against its OWN coordinates and recommendation —
    // a branch on the cluster edge, or with different familiarity/risk, can have a genuinely
    // different top assayer than the cluster centre, and the plan must honour that. The old code
    // scored once against the centroid and stamped that single assayer onto every branch.
    // Progress is counted over branches rather than clusters, because clusters vary from one
    // branch to dozens: a bar that jumps a tenth when a one-branch cluster finishes and then sits
    // still through a forty-branch one is worse than no bar.
    const branchesToScore = clusters.reduce((sum, c) => sum + c.branches.length, 0);
    let branchesScored = 0;

    for (const cluster of clusters) {
      const branchAssignments: Array<{ branchId: string; branchName: string; assayerId: string | null; assayerName: string | null; fee: number | null; rank: number | null; selectionNote: string | null }> = [];
      const assayerCountInCluster = new Map<string, number>();
      let clusterFeeSum = 0;

      for (const branch of cluster.branches) {
        let assayerId: string | null = null;
        let assayerName: string | null = null;
        let fee: number | null = null;
        // Which rank in this branch's own recommendation list the chosen assayer held (1 = the
        // engine's top pick), and why any higher-ranked candidates were passed over. This is what
        // lets ops distinguish "#2 because #1 was already at capacity in this very plan" from a
        // wrong pick — without it the two are indistinguishable.
        let rank: number | null = null;
        let selectionNote: string | null = null;

        if (branch.latitude == null || branch.longitude == null) {
          uncoveredBranches.push({ branchId: branch.id, branchName: branch.name, reason: 'Branch has no usable coordinates, so no assayer could be scored against it.' });
        } else {
          // Score this specific branch. `clientId` is threaded so id-keyed eligibility queries
          // resolve; `preloaded` keeps the client + assayer roster loaded once across all branches.
          const branchForScoring = { ...branch, clientId: project.clientId } as any;
          const candidates = await this.recommendationEngine.recommend(branchForScoring, new Date(), {}, preloaded);

          // Walk the ranked list in order, recording why each higher-ranked candidate is skipped,
          // and stop at the first one that can actually take the work.
          const passedOver: string[] = [];
          for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            const hasCapacity = (allocationMap[c.assayer.id] || 0) < (c.assayer.maxWeeklyWorkload || DEFAULT_WEEKLY_CAPACITY);
            if (!hasCapacity) {
              passedOver.push(`#${i + 1} ${c.assayer.displayName} — at weekly capacity`);
              continue;
            }
            // Enforce the client's hard distance ceiling, matching what assignment creation checks —
            // so we never propose an assayer the deploy step will then reject as out of range.
            if (Number.isFinite(clientMaxDistanceKm)) {
              // HOME coordinates, matching `assignment.create` — not `effectiveLatitude`, which
              // returns the live GPS fix for any assayer who opted into sharing. The two measured
              // different things, so for a live-enabled assayer whose phone happened to be near
              // the branch this gate passed and the deploy step then refused with "out of range",
              // landing the branch in `skipped`. Ranking may use where someone is now; a
              // contractual ceiling has to use the same point the commit does.
              const aLat = (c.assayer as any).homeLatitude ?? (c.assayer as any).latitude;
              const aLng = (c.assayer as any).homeLongitude ?? (c.assayer as any).longitude;
              if (aLat != null && aLng != null && branch.latitude != null && branch.longitude != null) {
                const d = calculateHaversineDistance(Number(branch.latitude), Number(branch.longitude), Number(aLat), Number(aLng));
                if (d > clientMaxDistanceKm) {
                  passedOver.push(`#${i + 1} ${c.assayer.displayName} — ${d.toFixed(0)}km exceeds the ${clientMaxDistanceKm}km limit`);
                  continue;
                }
              }
            }

            // This candidate takes the branch.
            assayerId = c.assayer.id;
            assayerName = c.assayer.displayName;
            rank = i + 1;
            selectionNote = passedOver.length > 0 ? `Passed over: ${passedOver.join('; ')}` : null;
            break;
          }

          if (assayerId) {
            allocationMap[assayerId] = (allocationMap[assayerId] || 0) + 1;
            assignedAssayerIds.add(assayerId);
            matchedCount += 1;
            assayerCountInCluster.set(assayerId, (assayerCountInCluster.get(assayerId) || 0) + 1);

            const quote = await this.feePolicyService.quote({
              assayerId,
              clientId: project.clientId ?? null,
              distanceKm: 0, // per-branch travel resolved at assign time
              branchCount: 1,
            });
            fee = quote.total;
            clusterFeeSum += quote.total;
            totalEstimatedCost += quote.total;
          } else {
            uncoveredBranches.push({
              branchId: branch.id,
              branchName: branch.name,
              reason: passedOver.length > 0
                ? `All ${candidates.length} recommended candidate(s) unavailable: ${passedOver.slice(0, 3).join('; ')}${passedOver.length > 3 ? '…' : ''}`
                : 'No eligible assayer with available capacity for this branch.',
            });
          }
        }

        branchAssignments.push({ branchId: branch.id, branchName: branch.name, assayerId, assayerName, fee, rank, selectionNote });

        branchesScored += 1;
        await onProgress?.(branchesScored, branchesToScore, 'Scoring branches');
      }

      // Cluster-level display fields summarise the per-branch decisions: the assayer covering the
      // most branches in the cluster represents it, and the fee is the sum of the branch quotes.
      let dominantId: string | null = null;
      let dominantCount = 0;
      for (const [id, count] of assayerCountInCluster) {
        if (count > dominantCount) { dominantCount = count; dominantId = id; }
      }
      const dominantName = branchAssignments.find((b) => b.assayerId === dominantId)?.assayerName ?? null;

      clusterAssignments.push({
        id: cluster.id,
        name: cluster.name,
        branchCount: cluster.branches.length,
        assignedAssayerName: dominantName,
        assignedAssayerId: dominantId,
        branchIds: cluster.branches.map((b: any) => b.id),
        estimatedTotalFee: clusterFeeSum > 0 ? clusterFeeSum : null,
        branchAssignments,
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
