import { DayPlannerService, DAY_PLAN_SEARCH_NODE_BUDGET, type DayPlanCandidate, type BranchCluster } from './day-planner.service';
import { AssayerEntity } from '../assayer/assayer.entity';

/**
 * The day planner items of the 2026-09-25 recommendations/planning audit.
 *
 *  F3  the exact cluster↔assayer search has a node budget and a deterministic greedy fallback
 *  F5  an assayer's existing work that day uses up the same day; no home pin is an exclusion, said
 *  F6  the day's travel is priced on the route's FIRST stop (the stop the commit books it on)
 */

const plan = (clusterIdx: number, assayerId: string, score: number): DayPlanCandidate => ({
  assayerId, assayerName: assayerId, assayerCode: assayerId, assayerCity: '', assayerPhone: null,
  overallScore: score, totalBranches: 1, totalAuditHours: 4, totalTravelKm: 10, totalTravelMinutes: 20,
  totalDayHours: 5, estimatedBaseFee: 1000, estimatedTravelFee: 100, estimatedTotalCost: 1100,
  dayStartTime: '09:00', dayEndTime: '14:00', utilizationPercent: 80, totalPackets: 0, costPerPacket: null,
  idleHours: 5, stops: [], existingSameDayJobs: { count: 0, hours: 0 }, exceedsWorkingDay: false,
  clientPreferencesMatch: { skillsMatch: true, certificationsMatch: true, distanceWithinRange: true, isPreferredAssayer: false },
  // Keeps the cluster index visible in failures.
  ...(clusterIdx >= 0 ? {} : {}),
});

const bareService = (): DayPlannerService => {
  const svc: any = Object.create(DayPlannerService.prototype);
  svc.logger = { warn: jest.fn(), log: jest.fn() };
  return svc as DayPlannerService;
};

describe('F3 — the exact search is bounded, and the fallback is deterministic', () => {
  /** 50 clusters drawing on the same five assayers: the case that never finished. */
  const sharedPool = () =>
    Array.from({ length: 50 }, (_, i) => ({
      cluster: { clusterId: `CLU-${i}` } as unknown as BranchCluster,
      bestPlan: null as DayPlanCandidate | null,
      // Scores vary a little per cluster so the bound cannot prune everything at once.
      dayPlans: ['a1', 'a2', 'a3', 'a4', 'a5']
        .map((id, j) => plan(i, id, 90 - j * 3 - ((i * 7 + j) % 5)))
        .sort((x, y) => y.overallScore - x.overallScore),
    }));

  it('50 clusters × 5 shared assayers completes in under 2 s', () => {
    const svc = bareService();
    const results = sharedPool();
    const started = Date.now();
    const outcome = svc.globalOptimizeAssignments(results);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.nodes).toBeLessThanOrEqual(DAY_PLAN_SEARCH_NODE_BUDGET);
    // Still one cluster per assayer per day (kept by owner decision): at most five staffed.
    const used = results.map((r) => r.bestPlan?.assayerId).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
    expect(used).toHaveLength(5);
  });

  it('gives the same answer every run', () => {
    const a = sharedPool(); const b = sharedPool();
    bareService().globalOptimizeAssignments(a);
    bareService().globalOptimizeAssignments(b);
    expect(a.map((r) => r.bestPlan?.assayerId ?? null)).toEqual(b.map((r) => r.bestPlan?.assayerId ?? null));
  });

  it('stays exact when the problem is small enough', () => {
    const results = [
      { cluster: {} as any, bestPlan: null as DayPlanCandidate | null, dayPlans: [plan(0, 'a1', 90), plan(0, 'a2', 80)] },
      { cluster: {} as any, bestPlan: null as DayPlanCandidate | null, dayPlans: [plan(1, 'a1', 85), plan(1, 'a3', 10)] },
    ];
    const outcome = bareService().globalOptimizeAssignments(results);
    expect(outcome.exact).toBe(true);
    // 80 + 85 beats 90 + 10: the exact optimum, not the greedy one.
    expect(results.map((r) => r.bestPlan!.assayerId)).toEqual(['a2', 'a1']);
  });

  it('greedy: highest score first, one cluster per assayer, ties by cluster order then id', () => {
    const out = DayPlannerService.greedyAssignment([
      [plan(0, 'b', 50), plan(0, 'a', 50)],
      [plan(1, 'a', 50)],
    ]);
    expect(out.map((p) => p?.assayerId ?? null)).toEqual(['a', null]);
  });

  it('beyond the budget it takes the better of best-so-far and greedy', () => {
    const results = sharedPool();
    const outcome = bareService().globalOptimizeAssignments(results, 10);
    expect(outcome.exact).toBe(false);
    const total = results.reduce((s, r) => s + (r.bestPlan?.overallScore ?? 0), 0);
    const greedy = DayPlannerService.greedyAssignment(results.map((r) => r.dayPlans));
    expect(total).toBeGreaterThanOrEqual(greedy.reduce((s, p) => s + (p?.overallScore ?? 0), 0));
  });
});

describe('F5 / F6 — the day the assayer actually has', () => {
  const cluster: BranchCluster = {
    clusterId: 'CLU-001', centerLatitude: 18.53, centerLongitude: 73.86, radiusKm: 3,
    totalPackets: 0, totalEstimatedAuditHours: 5, feasibleForOneDay: true,
    branches: [
      // The heaviest branch first (the order clustering produces) — NOT where the route starts.
      { id: 'pb-a', branchId: 'br-a', branchName: 'A', solId: 'A', latitude: 18.52, longitude: 73.85, packetCount: null, estimatedDurationHours: 3, durationFromStaticFallback: true, district: 'Pune', city: 'Pune', state: 'Maharashtra', region: 'WEST', projectId: 'p-1' },
      { id: 'pb-b', branchId: 'br-b', branchName: 'B', solId: 'B', latitude: 18.54, longitude: 73.87, packetCount: null, estimatedDurationHours: 2, durationFromStaticFallback: true, district: 'Pune', city: 'Pune', state: 'Karnataka', region: 'SOUTH', projectId: 'p-1' },
    ],
  };
  const assayer = (id: string, over: Record<string, unknown> = {}) =>
    Object.assign(new AssayerEntity(), { id, displayName: id, latitude: 18.5, longitude: 73.8, skills: [], certifications: [], ...over });

  const build = (quote = jest.fn(async (q: any) => ({ baseFee: 1000, travelFee: q.distanceKm > 0 ? 400 : 0 }))) => {
    const svc: any = bareService();
    svc.branchRepository = { find: jest.fn(async () => [{ id: 'br-a' }, { id: 'br-b' }]) };
    svc.recommendationEngine = {
      recommend: jest.fn(async () => Object.assign([
        { assayer: { id: 'as-1' }, score: 80 }, { assayer: { id: 'as-2' }, score: 70 }, { assayer: { id: 'as-nopin' }, score: 60 },
      ], { excluded: [] })),
    };
    // The route starts at B, then A.
    svc.routingService = {
      optimizeRoute: jest.fn(async () => ({
        optimizedSequence: ['br-b', 'br-a'],
        steps: [{ distanceKm: 5, durationMinutes: 15 }, { distanceKm: 3, durationMinutes: 10 }],
        totalDistanceKm: 14, totalDurationMinutes: 40,
      })),
    };
    svc.feePolicyService = { quote };
    return svc;
  };

  it('F5: hours already booked that day count in the day, and are shown', async () => {
    const svc = build();
    const { dayPlans } = await svc.generateClusterDayPlans(
      cluster, [assayer('as-1')], null, new Date(), null, false, undefined, undefined,
      new Map([['as-1', { count: 1, hours: 3.5 }]]),
    );
    expect(dayPlans[0].existingSameDayJobs).toEqual({ count: 1, hours: 3.5 });
    // 5h audit + 40 min travel + 3.5h already booked.
    expect(dayPlans[0].totalDayHours).toBeCloseTo(9.2, 1);
  });

  it('F5: a day that the existing work pushes past the limit is excluded, saying why', async () => {
    const svc = build();
    const { dayPlans, excludedAssayers } = await svc.generateClusterDayPlans(
      cluster, [assayer('as-1')], null, new Date(), null, false, undefined, undefined,
      new Map([['as-1', { count: 2, hours: 7 }]]),
    );
    expect(dayPlans).toHaveLength(0);
    expect(excludedAssayers[0].reason).toMatch(/7\.0h already booked \(2 jobs\) that day/);
  });

  it('F5: an eligible assayer with no home pin is excluded with a reason, not silently dropped', async () => {
    const svc = build();
    const { excludedAssayers } = await svc.generateClusterDayPlans(
      cluster, [assayer('as-nopin', { latitude: null, longitude: null })], null, new Date(), null,
    );
    expect(excludedAssayers).toEqual([expect.objectContaining({ assayerId: 'as-nopin', reason: expect.stringMatching(/Home address not located/) })]);
  });

  it('F6: with two clients, the day\'s travel is priced on the route\'s first stop', async () => {
    const quote = jest.fn(async (q: any) => ({ baseFee: 1000, travelFee: q.distanceKm > 0 ? 400 : 0 }));
    const svc = build(quote);
    const clientA = { id: 'c-a', configuration: null } as any;
    const clientB = { id: 'c-b', configuration: null } as any;
    await svc.generateClusterDayPlans(
      cluster, [assayer('as-1')], null, new Date(), null, false,
      new Map([['pb-a', clientA], ['pb-b', clientB]]),
    );
    const travelled = quote.mock.calls.map((c: any[]) => c[0]).filter((q: any) => q.distanceKm > 0);
    expect(travelled).toHaveLength(1);
    // B is the first stop of the route — its client and place carry the loop.
    expect(travelled[0]).toMatchObject({ clientId: 'c-b', distanceKm: 14, distanceIsRoundTrip: true, place: { state: 'Karnataka', region: 'SOUTH' } });
  });

  it('F6: with one client, the loop is priced for the first stop\'s place', async () => {
    const quote = jest.fn(async (q: any) => ({ baseFee: 1000, travelFee: q.distanceKm > 0 ? 400 : 0 }));
    const svc = build(quote);
    await svc.generateClusterDayPlans(cluster, [assayer('as-1')], null, new Date(), null);
    expect(quote.mock.calls[0][0]).toMatchObject({ distanceKm: 14, distanceIsRoundTrip: true, place: { state: 'Karnataka' } });
  });

  it('asks the engine with each branch\'s own project', async () => {
    const svc = build();
    await svc.generateClusterDayPlans(cluster, [assayer('as-1')], null, new Date(), null);
    expect(svc.recommendationEngine.recommend.mock.calls[0][4]).toEqual({ projectId: 'p-1' });
  });
});

describe('F5 — reading what each assayer already has that day', () => {
  it('sizes existing jobs like cluster branches, skips the ones this run plans, and fails open', async () => {
    const svc: any = bareService();
    svc.projectBranchRepository = {
      query: jest.fn(async (_sql: string, params: any[]) => {
        expect(params).toEqual(['2026-10-05', ['as-1']]);
        return [
          { assayer_id: 'as-1', project_branch_id: 'pb-other', packet_count: 8, estimated_duration_hours: null, client_id: 'c-1' },
          { assayer_id: 'as-1', project_branch_id: 'pb-in-run', packet_count: 40, estimated_duration_hours: null, client_id: 'c-1' },
          { assayer_id: 'as-1', project_branch_id: 'pb-nopackets', packet_count: null, estimated_duration_hours: '2.5', client_id: null },
        ];
      }),
    };
    const out = await svc.loadExistingDayWork(
      ['as-1'], '2026-10-05', new Set(['pb-in-run']),
      new Map([['c-1', { planningPreferences: { minutesPerPacket: 30 } }]]),
    );
    // 8 packets × 30 min = 4h, plus the stored 2.5h; the in-run branch is not "existing".
    expect(out.get('as-1')).toEqual({ count: 2, hours: 6.5 });

    svc.projectBranchRepository.query = jest.fn(async () => { throw new Error('db down'); });
    await expect(svc.loadExistingDayWork(['as-1'], '2026-10-05', new Set(), new Map())).resolves.toEqual(new Map());
  });

  it('asks for live work only', async () => {
    const svc: any = bareService();
    svc.projectBranchRepository = { query: jest.fn(async () => []) };
    await svc.loadExistingDayWork(['as-1'], '2026-10-05', new Set(), new Map());
    const sql = svc.projectBranchRepository.query.mock.calls[0][0];
    for (const s of ['PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']) expect(sql).toContain(`'${s}'`);
    for (const s of ['REJECTED', 'CANCELLED']) expect(sql).not.toContain(`'${s}'`);
  });
});
