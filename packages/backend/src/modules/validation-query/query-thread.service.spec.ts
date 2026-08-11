import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { QueryThreadService } from './query-thread.service';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationQueryMessageEntity, QueryMessageAuthor } from './validation-query-message.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { ValidationQueryStatus } from '@fapoms/shared';

/**
 * The message path both clients actually use — the mobile assayer and the web desk both post
 * here. It used to save the message and tell no one, so an assayer's answer reached the
 * database and the desk never learned of it: the "chat with the assayer" loop was one-way.
 * These tests pin that a message now notifies the other side.
 */
describe('QueryThreadService.postMessage', () => {
  let service: QueryThreadService;
  const dispatch = { emitSafe: jest.fn() };
  const publisher = { publish: jest.fn() };

  const query: any = {
    id: 'q-1', validationCaseId: 'vc-1', assayerId: 'as-1', status: ValidationQueryStatus.OPEN, attachments: null,
  };

  const queryRepo = { findOne: jest.fn(), save: jest.fn(async (q: any) => q) };
  const messageRepo = { create: jest.fn((d: any) => d), save: jest.fn(async (d: any) => ({ id: 'm-1', createdAt: new Date('2026-08-20T00:00:00Z'), ...d })) };
  const caseRepo = { findOne: jest.fn(async () => ({ id: 'vc-1', projectBranchId: 'pb-1' })) };
  const assignmentRepo = { findOne: jest.fn(async () => ({ id: 'asn-1', assayer: { displayName: 'Belekar' }, projectBranch: { branch: { name: 'Shivananda Colony' } } })) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueryThreadService,
        { provide: getRepositoryToken(ValidationQueryEntity), useValue: queryRepo },
        { provide: getRepositoryToken(ValidationQueryMessageEntity), useValue: messageRepo },
        { provide: getRepositoryToken(ValidationCaseEntity), useValue: caseRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: NotificationDispatchService, useValue: dispatch },
        { provide: DomainEventPublisher, useValue: publisher },
      ],
    }).compile();
    service = module.get(QueryThreadService);
    jest.clearAllMocks();
    queryRepo.findOne.mockResolvedValue({ ...query });
  });

  it("notifies the desk when the assayer answers, and marks the query RESPONDED", async () => {
    let savedQuery: any;
    queryRepo.save.mockImplementation(async (q: any) => { savedQuery = q; return q; });

    await service.postMessage('q-1', QueryMessageAuthor.ASSAYER, 'as-1', 'Belekar', { body: 'Corrected the weight.' });

    expect(savedQuery.status).toBe(ValidationQueryStatus.RESPONDED);
    const call = dispatch.emitSafe.mock.calls.find((c) => c[0].type === 'VALIDATION_QUERY_ANSWERED');
    expect(call).toBeDefined();
    // The desk template reads assayerName / branchName — they must be real, not "—".
    expect(call[0].payload).toMatchObject({ assayerName: 'Belekar', branchName: 'Shivananda Colony', validationCaseId: 'vc-1' });
  });

  it("notifies the assayer when the desk adds to the thread", async () => {
    await service.postMessage('q-1', QueryMessageAuthor.STAFF, 'user-9', 'Priya', { body: 'Please recheck line 3.' });

    const call = dispatch.emitSafe.mock.calls.find((c) => c[0].type === 'VALIDATION_QUERY_RAISED');
    expect(call).toBeDefined();
    // The assayer's notification deep-links to the assignment, so the id must be resolved.
    expect(call[0].payload.assignmentId).toBe('asn-1');
    expect(call[0].assayerId).toBe('as-1');
  });

  it("publishes a realtime event on every message", async () => {
    await service.postMessage('q-1', QueryMessageAuthor.ASSAYER, 'as-1', 'Belekar', { body: 'ok' });
    expect(publisher.publish).toHaveBeenCalledWith('query:message', expect.objectContaining({ queryId: 'q-1' }));
  });

  it("refuses an assayer replying to someone else's clarification", async () => {
    await expect(
      service.postMessage('q-1', QueryMessageAuthor.ASSAYER, 'other-assayer', 'X', { body: 'hi' }),
    ).rejects.toThrow(ForbiddenException);
    expect(dispatch.emitSafe).not.toHaveBeenCalled();
  });

  it("refuses to add to a resolved clarification", async () => {
    queryRepo.findOne.mockResolvedValue({ ...query, status: ValidationQueryStatus.RESOLVED });
    await expect(
      service.postMessage('q-1', QueryMessageAuthor.STAFF, 'user-9', 'Priya', { body: 'more' }),
    ).rejects.toThrow(/resolved/i);
  });
});
