import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { WorkflowEngine } from './workflow.engine';
import { AuditService } from '../../core/audit/audit.service';

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  const mockAuditService = {
    recordEvent: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowEngine,
        {
          provide: AuditService,
          useValue: mockAuditService,
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

  it('should fail transition if guards return false', async () => {
    engine.registerWorkflow('assignment', [
      {
        from: ['CREATED'],
        to: 'ACCEPTED',
        guards: [async () => false],
      },
    ]);

    const can = await engine.canTransition('assignment', 'CREATED', 'ACCEPTED', { userId: 'u-1' });
    expect(can).toBe(false);

    await expect(
      engine.executeTransition('assignment', 'ent-1', 'CREATED', 'ACCEPTED', { userId: 'u-1' }),
    ).rejects.toThrow(BadRequestException);
  });
});
