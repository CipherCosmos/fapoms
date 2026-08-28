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

  /**
   * The desk's mark is a page + region anchor, not a cropped screenshot.
   *
   * A validator circles a figure on the returned packet and asks "what is this?". The mark used to
   * be cropped off the render canvas, uploaded, and minted here as an image attachment so the
   * assayer's app — which reads attachments and nothing else — could show it. The assayer now
   * opens the ACTUAL PDF with the same rectangle drawn on it (the read payload carries a
   * `markUrl`), so nothing is cropped and nothing is minted: the message stores only page + region.
   */
  describe("the desk's page + region mark", () => {
    const CROP = '/api/v1/validation-queries/attachment/chat%2Fregion-p3.png';

    it('stores the page + region anchor and mints no crop attachment', async () => {
      await service.postMessage('q-1', QueryMessageAuthor.STAFF, 'user-9', 'Priya', {
        body: 'What is this figure?', pageNumber: 3, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      });

      const created = messageRepo.create.mock.calls.at(-1)![0];
      expect(created.pageNumber).toBe(3);
      expect(created.region).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
      // No screenshot is uploaded any more, so there is no crop to mint.
      expect(created.attachments).toBeNull();
    });

    it('accepts a mark with no typed text as a real message', async () => {
      await service.postMessage('q-1', QueryMessageAuthor.STAFF, 'user-9', 'Priya', {
        pageNumber: 2, region: { x: 0, y: 0, w: 0.5, h: 0.5 },
      });

      // The mark alone is enough content — the guard no longer demands text or a crop.
      const created = messageRepo.create.mock.calls.at(-1)![0];
      expect(created.pageNumber).toBe(2);
      expect(created.body).toBeNull();
    });

    it('stores a legacy snapshotPath but does not mint it into attachments', async () => {
      await service.postMessage('q-1', QueryMessageAuthor.STAFF, 'user-9', 'Priya', {
        snapshotPath: CROP, pageNumber: 3,
      });

      const created = messageRepo.create.mock.calls.at(-1)![0];
      expect(created.snapshotPath).toBe(CROP);
      expect(created.attachments).toBeNull();
    });

    it('keeps only the files the sender genuinely attached', async () => {
      await service.postMessage('q-1', QueryMessageAuthor.STAFF, 'user-9', 'Priya', {
        body: 'see this', pageNumber: 1, region: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 },
        attachments: [{ url: '/a.pdf', fileName: 'a.pdf', fileType: 'application/pdf' }],
      });

      const attachments = messageRepo.create.mock.calls.at(-1)![0].attachments;
      expect(attachments.map((a: any) => a.fileName)).toEqual(['a.pdf']);
    });

    it('is not copied back onto the query row, which no client reads', async () => {
      let savedQuery: any;
      queryRepo.save.mockImplementation(async (q: any) => { savedQuery = q; return q; });

      await service.postMessage('q-1', QueryMessageAuthor.STAFF, 'user-9', 'Priya', {
        pageNumber: 2, region: { x: 0, y: 0, w: 0.4, h: 0.4 },
      });

      // The fixture starts with `attachments: null` and must still be null.
      expect(savedQuery.attachments).toBeNull();
    });

    it('leaves an assayer message alone — only the desk marks up the packet', async () => {
      await service.postMessage('q-1', QueryMessageAuthor.ASSAYER, 'as-1', 'Belekar', {
        body: 'It is 412 grams.',
      });

      expect(messageRepo.create.mock.calls.at(-1)![0].attachments).toBeNull();
    });
  });

  it('records that an answer arrived without copying the answer onto the query row', async () => {
    let savedQuery: any;
    queryRepo.save.mockImplementation(async (q: any) => { savedQuery = q; return q; });

    await service.postMessage('q-1', QueryMessageAuthor.ASSAYER, 'as-1', 'Belekar', { body: 'Corrected.' });

    expect(savedQuery.status).toBe(ValidationQueryStatus.RESPONDED);
    expect(savedQuery.lastMessageAt).toBeDefined();
    // The message text has one home. This column used to hold a second, corrupted copy.
    expect(savedQuery.assayerResponse).toBeUndefined();
  });

  it("refuses to add to a resolved clarification", async () => {
    queryRepo.findOne.mockResolvedValue({ ...query, status: ValidationQueryStatus.RESOLVED });
    await expect(
      service.postMessage('q-1', QueryMessageAuthor.STAFF, 'user-9', 'Priya', { body: 'more' }),
    ).rejects.toThrow(/resolved/i);
  });
});
