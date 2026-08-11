import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkflowEngine } from './workflow.engine';
import { WorkflowHistoryEntity } from './workflow-history.entity';
import { AuditService } from '../../../core/audit/audit.service';
import { SystemRole } from '@fapoms/shared';

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  const mockAuditService = {
    recordEvent: jest.fn().mockResolvedValue(undefined), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
  };

  const mockHistoryRepository = {
    create: jest.fn().mockImplementation((dto) => dto),
    save: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowEngine,
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide: getRepositoryToken(WorkflowHistoryEntity),
          useValue: mockHistoryRepository,
        },
      ],
    }).compile();

    engine = module.get<WorkflowEngine>(WorkflowEngine);
    jest.clearAllMocks();
  });

  it('should register and execute a workflow transition successfully', async () => {
    const hook = jest.fn();
    engine.registerWorkflow('assignment', [
      {
        from: ['CREATED'],
        to: 'ACCEPTED',
        guards: [async () => true],
        afterTransition: async () => {
          hook();
        },
      },
    ]);

    const can = await engine.canTransition('assignment', 'CREATED', 'ACCEPTED', { userId: 'u-1' });
    expect(can).toBe(true);

    await engine.executeTransition('assignment', 'ent-1', 'CREATED', 'ACCEPTED', { userId: 'u-1' });
    expect(hook).toHaveBeenCalled();
    expect(mockAuditService.recordEvent).toHaveBeenCalled();
  });

  it('should execute command and verify role authorization', async () => {
    engine.registerWorkflow('assignment', [
      {
        from: ['CREATED'],
        to: 'ACCEPTED',
        guards: [async () => true],
      },
    ]);

    const action = jest.fn().mockResolvedValue('success');
    const res = await engine.executeCommand(
      'assignment',
      'ent-1',
      'AcceptCommand',
      'CREATED',
      'ACCEPTED',
      'u-1',
      SystemRole.SUPER_ADMINISTRATOR,
      [SystemRole.SUPER_ADMINISTRATOR],
      action
    );

    expect(res).toBe('success');
    expect(action).toHaveBeenCalled();
    expect(mockHistoryRepository.save).toHaveBeenCalled();
  });

  it('should throw BadRequestException if user role is not authorized', async () => {
    engine.registerWorkflow('assignment', [
      {
        from: ['CREATED'],
        to: 'ACCEPTED',
        guards: [async () => true],
      },
    ]);

    const action = jest.fn();
    await expect(
      engine.executeCommand(
        'assignment',
        'ent-1',
        'AcceptCommand',
        'CREATED',
        'ACCEPTED',
        'u-1',
        'PLANNER',
        [SystemRole.SUPER_ADMINISTRATOR],
        action
      )
    ).rejects.toThrow(BadRequestException);
  });
});
