import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DayPlannerService } from './day-planner.service';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ClientEntity } from '../client/client.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { RoutingService } from '../geo/routing.provider';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { AssayerService } from '../assayer/assayer.service';
import { FeePolicyService } from '../pricing/fee-policy.service';

/**
 * Covers the rules that decide whether a day is worth buying: how a branch's workload is
 * sized, and which dates can actually be worked.
 */
describe('DayPlannerService', () => {
  let service: DayPlannerService;

  const PROJECT = { id: 'proj-1', name: 'Cycle 1', clientId: 'client-1' };

  // Two branches ~5km apart so they always cluster together, in different states so the
  // state-scoped holiday logic has something to discriminate on.
  const branchA = { id: 'br-a', name: 'Branch A', branchCode: 'A1', latitude: 18.52, longitude: 73.85, state: 'Maharashtra', district: 'Pune', city: 'Pune', estimatedDurationHours: 8 };
  const branchB = { id: 'br-b', name: 'Branch B', branchCode: 'B1', latitude: 18.56, longitude: 73.89, state: 'Karnataka', district: 'Pune', city: 'Pune', estimatedDurationHours: 6 };
  /** Light enough that A+C still fit one day on their stale estimates (8h + 2h). */
  const branchC = { id: 'br-c', name: 'Branch C', branchCode: 'C1', latitude: 18.54, longitude: 73.87, state: 'Maharashtra', district: 'Pune', city: 'Pune', estimatedDurationHours: 2 };

  const projectBranch = (branch: any, packetCount: number | null) => ({
    id: `pb-${branch.id}`,
    projectId: PROJECT.id,
    branchId: branch.id,
    branch,
    packetCount,
    status: 'PLANNING',
    isActive: true,
  });

  const mockConstraintEvaluator = { checkHoliday: jest.fn() };
  const mockProjectBranchRepo = { find: jest.fn() };

  const build = async (overrides: { projectRepo?: any; clientRepo?: any } = {}) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DayPlannerService,
        {
          provide: FeePolicyService,
          useValue: {
            quote: jest.fn().mockResolvedValue({
              baseFee: 1200, branchCount: 1, baseComponent: 1200,
              distanceKm: 0, chargeableKm: 0, travelFee: 0, total: 1200,
              usedFallbackBaseFee: false,
              rates: { travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true },
            }),
            getRates: jest.fn().mockResolvedValue({ travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true }),
            ratesFromConfiguration: jest.fn().mockReturnValue({ travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true }),
            resolveBaseFee: jest.fn().mockResolvedValue({ baseFee: 1200, usedFallback: false }),
            calculateTravelFee: jest.fn().mockReturnValue({ chargeableKm: 0, travelFee: 0 }),
            resolveClientIdForProject: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: mockProjectBranchRepo },
        {
          provide: getRepositoryToken(ProjectEntity),
          // find() as well as findOne(): a day plan can now span several projects, so the
          // service loads them as a set.
          useValue: overrides.projectRepo ?? {
            findOne: jest.fn().mockResolvedValue(PROJECT),
            find: jest.fn().mockResolvedValue([PROJECT]),
          },
        },
        { provide: getRepositoryToken(BranchEntity), useValue: { findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]) } },
        // No assayers: these tests assert clustering/date logic, which runs before candidate
        // scoring and is unaffected by it.
        { provide: getRepositoryToken(AssayerEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        {
          provide: getRepositoryToken(ClientEntity),
          useValue: overrides.clientRepo ?? {
            findOne: jest.fn().mockResolvedValue({ id: 'client-1', planningPreferences: { minutesPerPacket: 15 } }),
            find: jest.fn().mockResolvedValue([{ id: 'client-1', planningPreferences: { minutesPerPacket: 15 } }]),
          },
        },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: { findOne: jest.fn() } },
        { provide: RoutingService, useValue: { optimizeRoute: jest.fn() } },
        { provide: RecommendationEngine, useValue: { recommend: jest.fn().mockResolvedValue([]) } },
        { provide: ConstraintEvaluator, useValue: mockConstraintEvaluator },
        { provide: AssayerService, useValue: { hydrateAllWorkforceAttributes: jest.fn() } },
      ],
    }).compile();
    return module.get<DayPlannerService>(DayPlannerService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConstraintEvaluator.checkHoliday.mockResolvedValue({ passed: true });
    service = await build();
  });

  describe('workload sizing', () => {
    it("sizes a branch from this cycle's packet count rather than the stale branch estimate", async () => {
      // Branch A's stored estimate claims 8h, but this cycle only has 12 packets = 3h. Using
      // the stale value is what causes a full day to be bought for a few hours of work.
      mockProjectBranchRepo.find.mockResolvedValue([projectBranch(branchA, 12), projectBranch(branchB, 8)]);

      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-20');
      const branches = plan.clusters[0].cluster.branches;
      const a = branches.find((b) => b.branchId === 'br-a')!;

      expect(a.estimatedDurationHours).toBe(3); // 12 × 15min, NOT the stored 8h
      expect(a.packetCount).toBe(12);
      expect(a.durationFromStaticFallback).toBe(false);
      expect(plan.clusters[0].cluster.totalPackets).toBe(20);
    });

    it('falls back to the stored branch estimate when no packets are recorded, and says so', async () => {
      mockProjectBranchRepo.find.mockResolvedValue([projectBranch(branchA, null), projectBranch(branchC, null)]);

      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-20');
      const a = plan.clusters[0].cluster.branches.find((b) => b.branchId === 'br-a')!;

      expect(a.estimatedDurationHours).toBe(8);
      expect(a.packetCount).toBeNull();
      // The flag is what lets the UI mark the estimate as unreliable instead of presenting a
      // stale number as fact.
      expect(a.durationFromStaticFallback).toBe(true);
      // No packets recorded anywhere means cost-per-packet is genuinely unknowable, so the
      // cluster reports zero rather than a fabricated throughput figure.
      expect(plan.clusters[0].cluster.totalPackets).toBe(0);
    });

    it('splits a cluster that cannot fit one working day', async () => {
      // Stale estimates: 8h + 6h = 14h against a 10h day, so these cannot share an assayer-day
      // and must be planned separately rather than silently over-committed.
      mockProjectBranchRepo.find.mockResolvedValue([projectBranch(branchA, null), projectBranch(branchB, null)]);

      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-20');

      // Each ends up alone, so neither forms a multi-branch cluster.
      expect(plan.clusters).toHaveLength(0);
      // Only Branch B is worth flagging: at 6h it wastes 4h of the paid day, while Branch A's
      // 8h leaves just 2h idle — below the threshold. Flagging well-filled days too would bury
      // the genuinely wasteful ones in noise.
      expect(plan.underutilizedBranches.map((b) => b.branchName)).toEqual(['Branch B']);
      expect(plan.underutilizedBranches[0].idleHours).toBe(4);
    });

    it('flags a lone branch that would burn a full paid day for a few hours of work', async () => {
      // 8 packets = 2h against a 10h day.
      mockProjectBranchRepo.find.mockResolvedValue([projectBranch(branchA, 8)]);

      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-20');

      expect(plan.underutilizedBranches).toHaveLength(1);
      expect(plan.underutilizedBranches[0]).toMatchObject({ branchName: 'Branch A', packetCount: 8, auditHours: 2, idleHours: 8 });
    });
  });

  describe('working-date resolution', () => {
    beforeEach(() => {
      mockProjectBranchRepo.find.mockResolvedValue([projectBranch(branchA, 12), projectBranch(branchB, 8)]);
    });

    it('plans the requested date when it is an ordinary working day', async () => {
      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-20'); // a Thursday
      expect(plan.targetDate).toBe('2026-08-20');
      expect(plan.dateAdjustment).toBeNull();
    });

    it('moves off a public holiday to the next working day', async () => {
      // Holiday only on the requested date — the planner should step forward, not give up.
      mockConstraintEvaluator.checkHoliday.mockImplementation(async (_state: string, date: Date) =>
        date.toISOString().split('T')[0] === '2026-08-20'
          ? { passed: false, reason: 'Holiday Conflict: Target date is a holiday in Maharashtra.' }
          : { passed: true },
      );

      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-20');

      expect(plan.targetDate).toBe('2026-08-21');
      expect(plan.dateAdjustment?.requestedDate).toBe('2026-08-20');
      expect(plan.dateAdjustment?.reason).toMatch(/holiday/i);
    });

    /**
     * Indian banks close on Sundays and on the 2nd and 4th Saturday, and trade on the 1st, 3rd
     * and 5th. The planner used to reject every Saturday itself, which disagreed with the rule
     * assignment creation enforces and threw away working days. It now defers to the holiday
     * calendar, so this mock mirrors HolidayService.isHoliday rather than passing everything.
     */
    const bankCalendar = async (_state: string, date: Date) => {
      const day = date.getDay();
      const weekIndex = Math.ceil(date.getDate() / 7);
      const closed = day === 0 || (day === 6 && (weekIndex === 2 || weekIndex === 4));
      return closed ? { passed: false, reason: 'Holiday Conflict: Target date is a holiday.' } : { passed: true };
    };

    it('moves off a Saturday the banks are closed on', async () => {
      mockConstraintEvaluator.checkHoliday.mockImplementation(bankCalendar);

      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-22'); // 4th Saturday
      expect(plan.targetDate).toBe('2026-08-24'); // Monday
      expect(plan.dateAdjustment?.reason).toMatch(/Saturday/);
    });

    it('plans a Saturday the banks are open on, instead of discarding it', async () => {
      mockConstraintEvaluator.checkHoliday.mockImplementation(bankCalendar);

      // 29 Aug 2026 is a 5th Saturday — a normal trading day for the branch being audited.
      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-29');
      expect(plan.targetDate).toBe('2026-08-29');
      expect(plan.dateAdjustment).toBeNull();
    });

    it('still refuses Sundays', async () => {
      mockConstraintEvaluator.checkHoliday.mockImplementation(bankCalendar);

      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-23'); // Sunday
      expect(plan.targetDate).toBe('2026-08-24');
      expect(plan.dateAdjustment?.reason).toMatch(/Sunday/);
    });

    it('checks holidays per branch state, so one state\'s holiday still blocks the shared day', async () => {
      mockConstraintEvaluator.checkHoliday.mockImplementation(async (state: string, date: Date) =>
        state === 'Karnataka' && date.toISOString().split('T')[0] === '2026-08-20'
          ? { passed: false, reason: 'Holiday Conflict: Target date is a holiday in Karnataka.' }
          : { passed: true },
      );

      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-20');

      expect(plan.targetDate).toBe('2026-08-21');
      expect(plan.dateAdjustment?.reason).toMatch(/Karnataka/);
    });
  });

  /**
   * A cluster can now span engagements — two banks can have branches on the same street. The
   * risk that creates is silently applying one client's commercial terms to another client's
   * branch, which would misprice the day and weaken the conflict-of-interest control. These
   * assert each branch keeps its own client's terms, and that the strictest floor wins.
   */
  describe('planning several projects together', () => {
    const PROJECT_2 = { id: 'proj-2', name: 'Other Bank Cycle', clientId: 'client-2' };
    // 20 minutes per packet vs client-1's 15 — a real contractual difference, not a default.
    const CLIENT_1 = { id: 'client-1', planningPreferences: { minutesPerPacket: 15, minDistanceKm: 5 } };
    const CLIENT_2 = { id: 'client-2', planningPreferences: { minutesPerPacket: 20, minDistanceKm: 25 } };

    const buildCrossClient = () => build({
      projectRepo: {
        findOne: jest.fn().mockResolvedValue(PROJECT),
        find: jest.fn().mockResolvedValue([PROJECT, PROJECT_2]),
      },
      clientRepo: {
        findOne: jest.fn().mockResolvedValue(CLIENT_1),
        find: jest.fn().mockResolvedValue([CLIENT_1, CLIENT_2]),
      },
    });

    it("sizes each branch with its own client's packet agreement, not the first project's", async () => {
      const svc = await buildCrossClient();
      // Same packet count on both branches; only the governing client differs.
      mockProjectBranchRepo.find.mockResolvedValue([
        { ...projectBranch(branchA, 12), projectId: PROJECT.id },
        { ...projectBranch(branchC, 12), projectId: PROJECT_2.id },
      ]);

      const plan = await svc.generateDayPlans([PROJECT.id, PROJECT_2.id], '2026-08-20');

      const sized: Array<{ branchId: string; hours: number }> = [
        ...plan.clusters.flatMap((c) => c.cluster.branches.map((b) => ({ branchId: b.branchId, hours: b.estimatedDurationHours }))),
        ...plan.underutilizedBranches.map((b) => ({ branchId: b.branchId, hours: b.auditHours })),
        ...plan.multiDayBranches.map((b) => ({ branchId: b.branchId, hours: b.auditHours })),
      ];
      // 12 x 15min = 3h under client-1; 12 x 20min = 4h under client-2. If the planner applied
      // one client's agreement to both branches, these would be equal.
      expect(sized.find((b) => b.branchId === branchA.id)?.hours).toBeCloseTo(3, 5);
      expect(sized.find((b) => b.branchId === branchC.id)?.hours).toBeCloseTo(4, 5);
    });

    it('enforces the strictest conflict-of-interest floor across the clients in scope', async () => {
      const svc = await buildCrossClient();
      mockProjectBranchRepo.find.mockResolvedValue([
        { ...projectBranch(branchA, 4), projectId: PROJECT.id },
        { ...projectBranch(branchC, 4), projectId: PROJECT_2.id },
      ]);

      const plan = await svc.generateDayPlans([PROJECT.id, PROJECT_2.id], '2026-08-20');

      // client-2's 25km floor governs the whole plan; client-1's 5km must not relax it for a
      // shared day, or an assayer excluded by one bank gets in through the other's branch.
      expect(plan.effectiveMinDistanceKm).toBe(25);
    });

    it("lets the operator's manual filter tighten, but never loosen, the client floors", async () => {
      const svc = await buildCrossClient();
      mockProjectBranchRepo.find.mockResolvedValue([
        { ...projectBranch(branchA, 4), projectId: PROJECT.id },
        { ...projectBranch(branchC, 4), projectId: PROJECT_2.id },
      ]);

      const tighter = await svc.generateDayPlans([PROJECT.id, PROJECT_2.id], '2026-08-20', 40);
      expect(tighter.effectiveMinDistanceKm).toBe(40);

      const looser = await svc.generateDayPlans([PROJECT.id, PROJECT_2.id], '2026-08-20', 2);
      expect(looser.effectiveMinDistanceKm).toBe(25);
    });
  });

});
