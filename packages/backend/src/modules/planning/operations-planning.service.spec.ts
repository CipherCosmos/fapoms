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
      ],
    }).compile();

    service = module.get<OperationsPlanningService>(OperationsPlanningService);
    jest.clearAllMocks();
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

    await expect(service.executeApprovedPlan('cp-1', 'u-1')).rejects.toThrow(/created no assignments/);
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
});
