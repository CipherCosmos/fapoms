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

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DayPlannerService,
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: mockProjectBranchRepo },
        { provide: getRepositoryToken(ProjectEntity), useValue: { findOne: jest.fn().mockResolvedValue(PROJECT) } },
        { provide: getRepositoryToken(BranchEntity), useValue: { findOne: jest.fn().mockResolvedValue(null) } },
        // No assayers: these tests assert clustering/date logic, which runs before candidate
        // scoring and is unaffected by it.
        { provide: getRepositoryToken(AssayerEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        {
          provide: getRepositoryToken(ClientEntity),
          useValue: { findOne: jest.fn().mockResolvedValue({ id: 'client-1', planningPreferences: { minutesPerPacket: 15 } }) },
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

    it('skips weekends', async () => {
      const plan = await service.generateDayPlans(PROJECT.id, '2026-08-22'); // Saturday
      expect(plan.targetDate).toBe('2026-08-24'); // Monday
      expect(plan.dateAdjustment?.reason).toMatch(/Saturday/);
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
});
