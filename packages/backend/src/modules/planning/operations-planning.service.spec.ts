import { Test, TestingModule } from '@nestjs/testing';
import { OperationsPlanningService } from './operations-planning.service';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { AssignmentService } from '../assignment/assignment.service';
import { ProjectQueryService } from '../project/project-query.service';
import { CoveragePlanEntity, CoveragePlanStatus } from './coverage-plan.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { PlanningService } from './planning.service';

describe('OperationsPlanningService', () => {
  let service: OperationsPlanningService;

  const mockPlanRepository = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn((arg) => Promise.resolve({ id: 'cp-1', ...arg })),
  };

  const mockVersionRepository = {
    create: jest.fn(),
    save: jest.fn((arg) => Promise.resolve({ id: 'v-1', ...arg })),
  };

  const mockPlanningEngine = {
    generateCoveragePlan: jest.fn().mockResolvedValue({
      clusters: [{ id: 'b-1', assignedAssayerName: 'Vijay Shankar', branchCount: 1 }],
    }),
  };

  const mockAssignmentService = {
    create: jest.fn(),
  };

  // Deployment reuses the single-branch date suggester; by default every branch's first
  // workable date is the same, so tests exercise the capacity spreading rather than holidays.
  const mockPlanningService = {
    suggestAuditDate: jest.fn().mockResolvedValue({ date: '2026-01-05', skipped: [] }),
  };

  const mockProjectQueryService = {
    findProjectBranches: jest.fn().mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
    ]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: AuditService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }) } },
        OperationsPlanningService,
        { provide: getRepositoryToken(CoveragePlanEntity), useValue: mockPlanRepository },
        { provide: getRepositoryToken(CoveragePlanVersionEntity), useValue: mockVersionRepository },
        { provide: CoveragePlanningEngine, useValue: mockPlanningEngine },
        { provide: AssignmentService, useValue: mockAssignmentService },
        { provide: ProjectQueryService, useValue: mockProjectQueryService },
        { provide: PlanningService, useValue: mockPlanningService },
      ],
    }).compile();

    service = module.get<OperationsPlanningService>(OperationsPlanningService);
    jest.clearAllMocks();
    mockPlanningService.suggestAuditDate.mockResolvedValue({ date: '2026-01-05', skipped: [] });
  });

  it('should create a coverage plan version and allow review status transitions', async () => {
    let callCount = 0;
    mockPlanRepository.findOne.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return null;
      return {
        id: 'cp-1',
        projectId: 'p-1',
        status: CoveragePlanStatus.GENERATED,
        currentVersion: 1,
        versions: [],
      };
    });
    mockPlanRepository.create.mockImplementation((arg) => arg);
    mockVersionRepository.create.mockImplementation((arg) => arg);

    const plan = await service.createOrRegeneratePlan('p-1', [], 'u-1', 'Initial Setup');
    expect(plan.status).toBe(CoveragePlanStatus.GENERATED);
    expect(plan.currentVersion).toBe(1);
  });

  it('should refuse execution of unapproved plans', async () => {
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      status: CoveragePlanStatus.GENERATED,
      currentVersion: 1,
      versions: [],
    });

    await expect(
      service.executeApprovedPlan('cp-1', 'u-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('deploys the assayer, branch and fee that were actually approved', async () => {
    const activeVersion = {
      versionNumber: 1,
      planData: {
        clusters: [{
          id: 'cluster-b-1',
          assignedAssayerName: 'Vijay Shankar',
          assignedAssayerId: 'as-real-1',
          branchIds: ['b-1'],
          estimatedTotalFee: 1800,
          branchCount: 1,
        }],
      },
    };
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [activeVersion],
    });
    mockAssignmentService.create.mockResolvedValue({ id: 'asg-1' });

    await service.executeApprovedPlan('cp-1', 'u-1');

    // Previously this asserted only that create() was called — which it was, with a hardcoded
    // 'as-1' and a flat 1500 fee against whichever project branch happened to be first.
    expect(mockAssignmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectBranchId: 'pb-1', assayerId: 'as-real-1', proposedFee: 1800 }),
      'u-1',
    );
  });

  it('refuses to mark a plan DEPLOYED when it produced no assignments', async () => {
    // The old implementation set DEPLOYED unconditionally, so a plan whose every create()
    // threw was still reported to ops and the client as successfully deployed.
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1'], estimatedTotalFee: 1800, branchCount: 1 }] },
      }],
    });
    mockAssignmentService.create.mockRejectedValue(new Error('Assayer is already booked that day'));

    // No longer a thrown error: a fully-skipped deploy is an explained outcome, so the modal
    // can render grouped reasons instead of a red box with the first five.
    const result = await service.executeApprovedPlan('cp-1', 'u-1');
    expect(result.fullySkipped).toBe(true);
    expect(result.deployed).toHaveLength(0);
    expect(result.skippedReasons).toEqual([{ reason: 'Assayer is already booked that day', count: 1 }]);
    expect(mockPlanRepository.save).not.toHaveBeenCalled();
  });

  it('splits a cluster fee across its branches rather than charging each the full amount', async () => {
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1', 'b-2'], estimatedTotalFee: 1800, branchCount: 2 }] },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
      { id: 'pb-2', branchId: 'b-2' },
    ]);
    mockAssignmentService.create.mockResolvedValue({ id: 'asg-1' });

    await service.executeApprovedPlan('cp-1', 'u-1');

    const fees = mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].proposedFee);
    expect(fees).toEqual([900, 900]);
  });

  it('gives each branch its own workable date instead of stacking them all on one day', async () => {
    // The defect that made the bulk path unusable: 155 branches all booked for the same date.
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: {
          clusters: [{
            id: 'c-1',
            assignedAssayerId: 'as-real-1',
            branchIds: ['b-1', 'b-2', 'b-3'],
            estimatedTotalFee: 900,
            branchCount: 3,
          }],
        },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
      { id: 'pb-2', branchId: 'b-2' },
      { id: 'pb-3', branchId: 'b-3' },
    ]);
    mockAssignmentService.create.mockImplementation(async () => ({ id: `asg-${Math.random()}` }));

    const result = await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

    const dates = mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].scheduledDate);
    expect(new Set(dates).size).toBe(3);
    expect(dates[0]).toBe('2026-01-05');
    expect(dates.every((d: string) => new Date(`${d}T00:00:00`).getDay() !== 0)).toBe(true);
    expect(result.dateRange).toEqual({ start: dates[0], end: dates[2] });
    // One lookup per branch, batched — not one per placement attempt.
    expect(mockPlanningService.suggestAuditDate).toHaveBeenCalledTimes(3);
  });

  it('never lands a spread branch on a date that branch\'s calendar rules out', async () => {
    mockPlanningService.suggestAuditDate.mockResolvedValue({
      date: '2026-01-05',
      skipped: [{ date: '2026-01-06', reason: 'Republic Day' }],
    });
    mockPlanRepository.findOne.mockResolvedValue({
      id: 'cp-1',
      projectId: 'p-1',
      status: CoveragePlanStatus.APPROVED,
      currentVersion: 1,
      versions: [{
        versionNumber: 1,
        planData: { clusters: [{ id: 'c-1', assignedAssayerId: 'as-real-1', branchIds: ['b-1', 'b-2'], estimatedTotalFee: 900, branchCount: 2 }] },
      }],
    });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1' },
      { id: 'pb-2', branchId: 'b-2' },
    ]);
    mockAssignmentService.create.mockImplementation(async () => ({ id: 'asg-x' }));

    await service.executeApprovedPlan('cp-1', 'u-1', '2026-01-05');

    const dates = mockAssignmentService.create.mock.calls.map((c: any[]) => c[0].scheduledDate);
    expect(dates).toEqual(['2026-01-05', '2026-01-07']);
  });
});
