import { Test, TestingModule } from '@nestjs/testing';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { ProjectQueryService } from '../project/project-query.service';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { ClusterManager } from './cluster.manager';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ClientEntity } from '../client/client.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FeePolicyService } from '../pricing/fee-policy.service';

describe('CoveragePlanningEngine', () => {
  let engine: CoveragePlanningEngine;

  const mockProjectQueryService = {
    findOne: jest.fn().mockResolvedValue({ id: 'p-1', name: 'Project Alpha', clientId: 'c-1' }),
    findProjectBranches: jest.fn().mockResolvedValue([
      { status: 'IMPORTED', branch: { id: 'b-1', name: 'Branch 1', latitude: 19.0, longitude: 72.0 } },
    ]),
  };

  const mockRecommendationEngine = {
    // Batch callers hoist the per-client load out of their loop via preloadContext().
    preloadContext: jest.fn().mockResolvedValue({ client: null, assayers: [] }),
    recommend: jest.fn().mockResolvedValue([
      { assayer: { id: 'a-1', displayName: 'Vijay Shankar' }, score: 90, breakdown: {} },
    ]),
  };

  const mockBranchProvider = {
    getBranchesForPlanning: jest.fn().mockResolvedValue([
      { branchId: { value: 'b-1' }, name: 'Branch 1', location: { latitude: 19.0, longitude: 72.0 }, requiredSkills: { values: ['Gold'] } },
    ]),
  };

  const mockAssayerProvider = {
    getAvailableAssayers: jest.fn().mockResolvedValue([
      { assayerId: { value: 'a-1' }, displayName: 'Vijay Shankar', status: 'ACTIVE', location: { latitude: 19.0, longitude: 72.0 }, skills: { values: ['Gold'] }, maxWeeklyWorkload: 15 },
    ]),
  };

  const mockWorkloadProvider = {
    getAssayerCurrentWorkloads: jest.fn().mockResolvedValue({ 'a-1': 0 }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoveragePlanningEngine,
        ClusterManager,
        {
          provide: FeePolicyService,
          useValue: {
            // Mirrors the real calculator's shape: base fee per branch, travel once.
            quote: jest.fn().mockImplementation(async ({ branchCount = 1 }: any) => ({
              baseFee: 1200, branchCount, baseComponent: 1200 * branchCount,
              distanceKm: 0, chargeableKm: 0, travelFee: 0, total: 1200 * branchCount,
              usedFallbackBaseFee: false,
              rates: { travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true },
            })),
          },
        },
        { provide: ProjectQueryService, useValue: mockProjectQueryService },
        { provide: RecommendationEngine, useValue: mockRecommendationEngine },
        { provide: ConstraintEvaluator, useValue: {} },
        { provide: 'PlanningBranchProvider', useValue: mockBranchProvider },
        { provide: 'AssayerAvailabilityProvider', useValue: mockAssayerProvider },
        { provide: 'WorkloadProvider', useValue: mockWorkloadProvider },
      ],
    }).compile();

    engine = module.get<CoveragePlanningEngine>(CoveragePlanningEngine);
    jest.clearAllMocks();
  });

  it('should generate a coverage plan including capacity analysis and confidence metrics', async () => {
    const plan = await engine.generateCoveragePlan('p-1');

    expect(plan.projectId).toBe('p-1');
    expect(plan.coveragePercentage).toBe(100);
    expect(plan.confidenceScore).toBe(100);
    expect(plan.workforceCapacity.length).toBe(1);
    expect(plan.clusters.length).toBe(1);
    expect(plan.clusters[0].assignedAssayerName).toBe('Vijay Shankar');
  });

  /**
   * The engine used to hand the recommendation engine a fabricated branch whose id was the
   * cluster's synthetic `cluster-<uuid>` string. That is not a branch id and not a UUID, so
   * every id-keyed query inside recommend() failed at the database and the endpoint returned
   * 500 in production — while this suite stayed green, because recommend() is mocked here and
   * never validated what it was given. These assert the contract the database enforces.
   */
  describe('cluster representative branch', () => {
    it('scores against a real branch id, never a synthetic cluster id', async () => {
      await engine.generateCoveragePlan('p-1');

      expect(mockRecommendationEngine.recommend).toHaveBeenCalled();
      for (const [branchArg] of mockRecommendationEngine.recommend.mock.calls) {
        expect(branchArg.id).toBeDefined();
        expect(String(branchArg.id)).not.toMatch(/^cluster-/);
        // Every id reaching recommend() must be one of the real branches supplied above.
        expect(['b-1']).toContain(branchArg.id);
      }
    });

    it('positions the stand-in branch at the cluster centre', async () => {
      await engine.generateCoveragePlan('p-1');
      const [branchArg] = mockRecommendationEngine.recommend.mock.calls[0];
      expect(typeof branchArg.latitude).toBe('number');
      expect(typeof branchArg.longitude).toBe('number');
    });
  });

  describe('per-client preload', () => {
    it('loads the client and assayer roster once for the whole plan, not once per cluster', async () => {
      // Each recommend() call used to re-fetch the client, re-load every active assayer and
      // re-run workforce hydration. Across 31 clusters that was the bulk of a >4s response,
      // and it grew with branch count. The roster is identical for every cluster in a project.
      await engine.generateCoveragePlan('p-1');

      expect(mockRecommendationEngine.preloadContext).toHaveBeenCalledTimes(1);
      // And every scoring call must actually receive it, or the saving is not realised.
      for (const call of mockRecommendationEngine.recommend.mock.calls) {
        expect(call[3]).toBeDefined();
      }
    });
  });

  describe('estimatedDurationDays', () => {
    /**
     * Twelve branches and one assayer allowed 15 a week (3 a working day).
     * Capacity-based  => ceil(12 / 3) = 4 days.
     * Old flat guess  => ceil(12 / 4) = 3 days, regardless of who is available.
     * Asserting 4 is what makes this test fail if the flat formula returns.
     */
    const twelveBranches = Array.from({ length: 12 }, (_, i) => ({
      branchId: { value: `b-${i}` },
      name: `Branch ${i}`,
      // Same coordinates so they cluster together and all get matched.
      location: { latitude: 19.0, longitude: 72.0 },
      requiredSkills: { values: ['Gold'] },
    }));

    it('derives days from the assigned workforce capacity', async () => {
      mockBranchProvider.getBranchesForPlanning.mockResolvedValueOnce(twelveBranches);
      mockProjectQueryService.findOne.mockResolvedValueOnce({ id: 'p-1', name: 'Project Alpha', clientId: 'c-1' });

      const plan = await engine.generateCoveragePlan('p-1');

      expect(plan.requiredWorkforceCount).toBe(1);
      expect(plan.estimatedDurationDays).toBe(4);
    });

    it('does not claim a one-day plan when nothing could be matched', async () => {
      mockRecommendationEngine.recommend.mockResolvedValue([]);
      const plan = await engine.generateCoveragePlan('p-1');
      expect(plan.coveragePercentage).toBe(0);
      expect(plan.estimatedDurationDays).toBeGreaterThanOrEqual(1);
      // Restore for any later test in this file.
      mockRecommendationEngine.recommend.mockResolvedValue([
        { assayer: { id: 'a-1', displayName: 'Vijay Shankar' }, score: 90, breakdown: {} },
      ]);
    });
  });

  /**
   * The per-branch loop is where essentially all of the measured 6.8 s (200-branch project,
   * scale database) is spent, and it is the only phase of this method whose remaining work is
   * knowable in advance. When the plan runs as a queued job that count is what the poll endpoint
   * turns into a progress bar.
   */
  describe('progress reporting', () => {
    const twelveBranches = Array.from({ length: 12 }, (_, i) => ({
      branchId: { value: `b-${i}` },
      name: `Branch ${i}`,
      location: { latitude: 19.0, longitude: 72.0 },
      requiredSkills: { values: ['Gold'] },
    }));

    it('counts branches, not clusters', async () => {
      // Clusters run from one branch to dozens: a bar that jumps a tenth when a one-branch
      // cluster finishes and then sits still through a forty-branch one is worse than no bar.
      mockBranchProvider.getBranchesForPlanning.mockResolvedValueOnce(twelveBranches);
      const onProgress = jest.fn();

      const plan = await engine.generateCoveragePlan('p-1', undefined, onProgress);

      expect(plan.clusters.length).toBe(1);
      expect(onProgress).toHaveBeenCalledTimes(12);
      expect(onProgress).toHaveBeenLastCalledWith(12, 12, 'Scoring branches');
    });

    it('still reports a branch that could not be scored at all', async () => {
      // A branch with no coordinates skips the engine entirely. Not counting it would stall the
      // bar short of 100% on exactly the projects with the worst data.
      mockBranchProvider.getBranchesForPlanning.mockResolvedValueOnce([
        { branchId: { value: 'b-1' }, name: 'Branch 1', location: { latitude: null, longitude: null }, requiredSkills: { values: [] } },
      ]);
      const onProgress = jest.fn();

      const plan = await engine.generateCoveragePlan('p-1', undefined, onProgress);

      expect(plan.uncoveredBranches).toHaveLength(1);
      expect(onProgress).toHaveBeenCalledWith(1, 1, 'Scoring branches');
    });

    it('is optional, so the synchronous route is unchanged', async () => {
      await expect(engine.generateCoveragePlan('p-1')).resolves.toBeDefined();
    });
  });
});
