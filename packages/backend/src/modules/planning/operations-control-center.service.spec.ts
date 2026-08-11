import { Test, TestingModule } from '@nestjs/testing';
import { OperationsControlCenterService } from './operations-control-center.service';
import { OperationsTaskEntity, OperationsTaskStatus, OperationsTaskPriority } from './operations-task.entity';
import { OperationsExceptionEntity, OperationsExceptionCategory, OperationsExceptionStatus } from './operations-exception.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';

describe('OperationsControlCenterService', () => {
  let service: OperationsControlCenterService;

  const mockTaskRepository = {
    create: jest.fn().mockImplementation((arg) => arg),
    save: jest.fn((arg) => Promise.resolve({ id: 't-1', ...arg })),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
  };

  const mockExceptionRepository = {
    create: jest.fn().mockImplementation((arg) => arg),
    save: jest.fn((arg) => Promise.resolve({ id: 'e-1', ...arg })),
    findOne: jest.fn(),
  };

  const mockAssignmentRepo = {
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    })),
  };

  const mockProjectMetricsProvider = {
    getTotalProjectsCount: jest.fn().mockResolvedValue(0),
    getActiveProjectsCount: jest.fn().mockResolvedValue(0),
    getProjectsAtRiskCount: jest.fn().mockResolvedValue(0),
    getProjectBranchCounts: jest.fn().mockResolvedValue({ total: 0, deployed: 0 }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: AuditService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }) } },
        OperationsControlCenterService,
        { provide: getRepositoryToken(OperationsTaskEntity), useValue: mockTaskRepository },
        { provide: getRepositoryToken(OperationsExceptionEntity), useValue: mockExceptionRepository },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: 'ProjectMetricsProvider', useValue: mockProjectMetricsProvider },
      ],
    }).compile();

    service = module.get<OperationsControlCenterService>(OperationsControlCenterService);
    jest.clearAllMocks();
  });

  it('should compile operational dashboard KPI parameters successfully', async () => {
    const summary = await service.getDashboardSummary();
    expect(summary.totalProjects).toBe(0);
    expect(summary.overallCoveragePercentage).toBe(0);
  });

  it('should create and resolve tasks in the queue', async () => {
    const task = await service.createOperationsTask('p-1', 'No Response', 'Assayer call pending', OperationsTaskPriority.HIGH);
    expect(task.title).toBe('No Response');

    mockTaskRepository.findOne.mockResolvedValue(task);
    const resolved = await service.resolveOperationsTask('t-1', 'Assayer responded');
    expect(resolved.status).toBe(OperationsTaskStatus.RESOLVED);
  });

  it('should manage custom exceptions and allow bypass resolution', async () => {
    const exc = await service.flagException('p-1', OperationsExceptionCategory.CAPACITY_EXCEEDED, 'Workload limit reached');
    expect(exc.category).toBe(OperationsExceptionCategory.CAPACITY_EXCEEDED);

    mockExceptionRepository.findOne.mockResolvedValue(exc);
    const resolved = await service.resolveException('e-1', 'Approved temporary capacity waiver');
    expect(resolved.status).toBe(OperationsExceptionStatus.RESOLVED);
  });
});
