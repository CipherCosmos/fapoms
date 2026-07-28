import { Test, TestingModule } from '@nestjs/testing';
import { OperationsExecutionService } from './operations-execution.service';
import { OperationsExecutionGroupEntity, ExecutionGroupStatus } from './operations-execution-group.entity';
import { OperationsExecutionConversationEntity, NegotiationParticipant } from './operations-execution-conversation.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('OperationsExecutionService', () => {
  let service: OperationsExecutionService;

  const mockGroupRepository = {
    create: jest.fn().mockImplementation((arg) => arg),
    save: jest.fn((arg) => Promise.resolve({ id: 'eg-1', ...arg })),
    findOne: jest.fn(),
  };

  const mockConversationRepository = {
    create: jest.fn().mockImplementation((arg) => arg),
    save: jest.fn((arg) => Promise.resolve({ id: 'ec-1', ...arg })),
  };

  const mockAssignmentRepository = {
    update: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperationsExecutionService,
        { provide: getRepositoryToken(OperationsExecutionGroupEntity), useValue: mockGroupRepository },
        { provide: getRepositoryToken(OperationsExecutionConversationEntity), useValue: mockConversationRepository },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepository },
      ],
    }).compile();

    service = module.get<OperationsExecutionService>(OperationsExecutionService);
    jest.clearAllMocks();
  });

  it('should package multiple assignments into a single route package', async () => {
    const mockAssignment = { id: 'a-1', executionGroupId: null };
    mockAssignmentRepository.findOne.mockResolvedValue(mockAssignment);
    mockGroupRepository.findOne.mockResolvedValue({ id: 'eg-1', status: ExecutionGroupStatus.DRAFT, assignments: [mockAssignment] });

    const pkg = await service.packageAssignments({
      assayerId: 'as-1',
      name: 'Mumbai Route Package',
      assignmentIds: ['a-1'],
    });

    expect(pkg.id).toBe('eg-1');
    expect(pkg.assignments).toHaveLength(1);
  });

  it('should post conversation history messages and transition status flags', async () => {
    const mockGroup = { id: 'eg-1', status: ExecutionGroupStatus.DRAFT };
    mockGroupRepository.findOne.mockResolvedValue(mockGroup);

    const msg = await service.postConversationMessage('eg-1', NegotiationParticipant.ASSAYER, 'Need higher allowance', 1800);
    expect(msg.proposedFeeOverride).toBe(1800);
  });

  it('should check audit operational readiness metrics', async () => {
    const mockGroup = { id: 'eg-1', status: ExecutionGroupStatus.CONFIRMED, totalFee: 1500, assignments: [{ id: 'a-1' }] };
    mockGroupRepository.findOne.mockResolvedValue(mockGroup);

    const readiness = await service.evaluateOperationalReadiness('eg-1');
    expect(readiness.isReady).toBe(true);
  });
});
