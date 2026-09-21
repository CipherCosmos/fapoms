import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DocumentStatus, DispatchMethod } from '@fapoms/shared';
import { DocumentDispatchJobsService } from './document-dispatch-jobs.service';
import { DocumentDispatchWorker } from './document-dispatch.worker';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { DocumentEntity } from './document.entity';
import {
  DOCUMENT_DISPATCH_JOB,
  DISPATCH_BATCH_JOB_OPTIONS,
} from './document-dispatch-jobs.contract';
import { AssessmentEntity } from '../project/assessment.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { ValidationService } from '../validation/validation.service';
import { EmailService } from '../notifications/email.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { getRequestContext } from '../../core/context/request-context';

/**
 * A BATCH DISPATCH IS ACCEPTED, THEN SENT ONCE, ONE DOCUMENT AT A TIME, AS THE PERSON WHO PRESSED SEND.
 *
 * `POST /documents/dispatch-batch` with a branch address used to email every document inside the
 * request — a storage read and an SMTP send each. Thirty of them outlived the web client's 30-second
 * timeout, so the page said it failed while the server kept sending, and pressing Send again emailed
 * the branch a second copy. These pin what makes the move safe: the request only accepts; a repeat
 * press joins the batch already going; only the requester can read it back; a document is marked
 * DISPATCHED only when its own email went; and a worker that dies mid-batch is not re-run from the
 * top, re-sending what already went.
 */

const ACTOR = { userId: 'desk-1', roleNames: ['DESK'], organizationId: 'org-1', displayName: 'Anita' };
const IDS = ['doc-c', 'doc-a', 'doc-b'];

function queueWith(jobs: any[] = []) {
  let n = 0;
  return {
    add: jest.fn(async (name: string, data: any) => {
      const job = { id: String(++n), name, data, getState: async () => 'waiting', progress: () => 0, timestamp: Date.now() };
      jobs.push(job);
      return job;
    }),
    getJobs: jest.fn(async () => jobs),
    getJob: jest.fn(async (id: string) => jobs.find((j) => j.id === id) ?? null),
  };
}

describe('DocumentDispatchJobsService', () => {
  it('accepts the batch and returns a job id instead of sending anything', async () => {
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any);

    const result = await service.enqueueBatch({ documentIds: IDS, branchEmail: ' manager@bank.example ' }, ACTOR);

    expect(result).toEqual({ jobId: '1', deduplicated: false });
    expect(queue.add).toHaveBeenCalledWith(
      DOCUMENT_DISPATCH_JOB.DISPATCH_BATCH,
      expect.objectContaining({
        documentIds: ['doc-a', 'doc-b', 'doc-c'],
        branchEmail: 'manager@bank.example',
        requestedBy: 'desk-1',
        actor: ACTOR,
      }),
      DISPATCH_BATCH_JOB_OPTIONS,
    );
  });

  it('joins the batch already going when the same person presses Send again — the branch gets one copy', async () => {
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any);

    const first = await service.enqueueBatch({ documentIds: IDS, branchEmail: 'manager@bank.example' }, ACTOR);
    const again = await service.enqueueBatch({ documentIds: [...IDS].reverse(), branchEmail: 'manager@bank.example' }, ACTOR);

    expect(again).toEqual({ jobId: first.jobId, deduplicated: true });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  /** A batch is readable only by whoever started it, so joining another person's would answer them 404. */
  it("does not fold one person's press into another person's identical batch", async () => {
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any);

    const mine = await service.enqueueBatch({ documentIds: IDS }, ACTOR);
    const theirs = await service.enqueueBatch({ documentIds: IDS }, { ...ACTOR, userId: 'desk-2' });

    expect(theirs.deduplicated).toBe(false);
    expect(theirs.jobId).not.toBe(mine.jobId);
  });

  it('treats the same documents to a different address as a delivery of its own', async () => {
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any);

    await service.enqueueBatch({ documentIds: IDS, branchEmail: 'one@bank.example' }, ACTOR);
    const other = await service.enqueueBatch({ documentIds: IDS, branchEmail: 'two@bank.example' }, ACTOR);
    const toAssayers = await service.enqueueBatch({ documentIds: IDS }, ACTOR);

    expect(other.deduplicated).toBe(false);
    expect(toAssayers.deduplicated).toBe(false);
    expect(queue.add).toHaveBeenCalledTimes(3);
  });

  it('never retries a batch, because a retry emails the branch again', () => {
    expect(DISPATCH_BATCH_JOB_OPTIONS.attempts).toBe(1);
  });

  it('answers 404 to anybody but the person who started the batch', async () => {
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any);
    const { jobId } = await service.enqueueBatch({ documentIds: IDS }, ACTOR);

    await expect(service.status(jobId, 'someone-else')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.status(jobId, 'desk-1')).resolves.toMatchObject({ jobId, state: 'queued' });
  });

  /** Job ids are a counter shared with the hourly scan; its jobs carry no requester and are nobody's. */
  it('answers 404 for a job on the queue that is not a batch', async () => {
    const queue = queueWith([
      { id: '7', name: DOCUMENT_DISPATCH_JOB.AUTO_DISPATCH, data: { requestedBy: 'desk-1' } },
    ]);
    const service = new DocumentDispatchJobsService(queue as any);

    await expect(service.status('7', 'desk-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('POST /documents/dispatch-batch', () => {
  const build = () => {
    const documentService = {
      findOne: jest.fn(async (id: string) => ({ id, assessment: { branch: { region: 'WEST' } } })),
      dispatchMany: jest.fn(),
      dispatchDocument: jest.fn(),
    };
    const regionGuard = { assertRegionAllowedStaged: jest.fn(async () => undefined) };
    const dispatchJobs = { enqueueBatch: jest.fn(async () => ({ jobId: '42', deduplicated: false })) };
    const controller = new DocumentController(
      documentService as any,
      null as any, null as any, null as any, null as any, null as any, null as any, null as any, null as any, null as any,
      regionGuard as any,
      dispatchJobs as any,
    );
    return { controller, documentService, regionGuard, dispatchJobs };
  };
  const req = { user: { id: 'desk-1' } };

  it('queues the batch and answers 202 with the job id, sending nothing inside the request', async () => {
    const { controller, documentService, dispatchJobs } = build();

    const response = await controller.dispatchBatch(
      { documentIds: IDS, branchEmail: 'manager@bank.example' } as any, req, undefined,
    );

    expect(response.data).toEqual({ jobId: '42', deduplicated: false });
    expect(dispatchJobs.enqueueBatch).toHaveBeenCalledWith(
      { documentIds: IDS, branchEmail: 'manager@bank.example' },
      expect.objectContaining({ userId: 'desk-1' }),
    );
    expect(documentService.dispatchMany).not.toHaveBeenCalled();
    expect(documentService.dispatchDocument).not.toHaveBeenCalled();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, DocumentController.prototype.dispatchBatch)).toBe(202);
  });

  /** The worker has no region scope, so the ceiling is the request's job — for every id, before anything is queued. */
  it('refuses the whole batch, queuing nothing, when one document is outside the caller\'s region', async () => {
    const { controller, regionGuard, dispatchJobs } = build();
    regionGuard.assertRegionAllowedStaged
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ForbiddenException('outside your region'));

    await expect(controller.dispatchBatch({ documentIds: IDS } as any, req, undefined)).rejects.toBeInstanceOf(ForbiddenException);
    expect(dispatchJobs.enqueueBatch).not.toHaveBeenCalled();
  });
});

describe('DocumentDispatchWorker — a batch', () => {
  const documents: Record<string, any> = {
    'doc-ok': {
      id: 'doc-ok', status: DocumentStatus.UPLOADED, isActive: true, fileName: 'kolhapur.pdf',
      filePath: 'k/1', mimeType: 'application/pdf', assessmentId: null,
      assessment: { branchId: 'br-1', branch: { name: 'Kolhapur Main' } },
    },
    'doc-refused': {
      id: 'doc-refused', status: DocumentStatus.UPLOADED, isActive: true, fileName: 'sangli.pdf',
      filePath: 'k/2', mimeType: 'application/pdf', assessmentId: null,
      assessment: { branchId: 'br-2', branch: { name: 'Sangli' } },
    },
  };

  const documentRepo = {
    findOne: jest.fn(async ({ where }: any) => (documents[where.id] ? { ...documents[where.id] } : null)),
    save: jest.fn(async (v: any) => v),
    manager: { query: jest.fn() },
  };
  const emails = { isEnabled: jest.fn(() => true), sendNow: jest.fn(), queue: jest.fn() };
  const storage = { getFileStream: jest.fn(async () => (async function* () { yield Buffer.from('%PDF-1.4'); })()) };

  /** A real DocumentService, so "DISPATCHED only when the email went" is the service's own rule, not a mock's. */
  const buildWorker = async () => {
    const module = await Test.createTestingModule({
      providers: [
        DocumentService,
        { provide: getRepositoryToken(DocumentEntity), useValue: documentRepo },
        { provide: getRepositoryToken(AssessmentEntity), useValue: { findOne: jest.fn(), find: jest.fn() } },
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(AssignmentEntity), useValue: { findOne: jest.fn(async () => null), find: jest.fn() } },
        { provide: getRepositoryToken(BranchEntity), useValue: { update: jest.fn(async () => ({ affected: 1 })), findOne: jest.fn() } },
        { provide: AuditService, useValue: { recordEvent: jest.fn(), recordEventSafe: jest.fn() } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: NotificationService, useValue: { create: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn(), emit: jest.fn() } },
        { provide: PushNotificationService, useValue: { sendToUser: jest.fn() } },
        { provide: LocalStorageService, useValue: {} },
        { provide: ValidationService, useValue: {} },
        { provide: 'StorageEngine', useValue: storage },
        { provide: EmailService, useValue: emails },
        { provide: RegionGuardService, useValue: { stagedMode: jest.fn(async () => 'off') } },
      ],
    }).compile();
    const service = module.get(DocumentService);
    return { worker: new DocumentDispatchWorker(documentRepo as any, null as any, service, null as any), service };
  };

  const batchJob = (documentIds: string[], branchEmail: string | null) => ({
    id: '5',
    name: DOCUMENT_DISPATCH_JOB.DISPATCH_BATCH,
    data: { documentIds, branchEmail, actor: ACTOR, requestedBy: ACTOR.userId, dedupeKey: 'k' },
    progress: jest.fn(async () => undefined),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    emails.sendNow.mockImplementation(async (msg: any) =>
      msg.attachments[0].filename === 'sangli.pdf'
        ? { sent: false, error: 'Mailbox unavailable', receipt: { id: 'e-2', status: 'FAILED', to: msg.to } }
        : { sent: true, receipt: { id: 'e-1', status: 'SENT', to: msg.to } });
  });

  it('marks DISPATCHED only the documents whose email went, and reports the rest with the reason', async () => {
    const { worker } = await buildWorker();

    const result = await worker.run(batchJob(['doc-ok', 'doc-refused'], 'manager@bank.example') as any);

    expect(result).toEqual({
      dispatched: ['doc-ok'],
      failed: [{ documentId: 'doc-refused', reason: expect.stringMatching(/could not be emailed/i) }],
    });
    const markedDispatched = documentRepo.save.mock.calls
      .map(([row]) => row)
      .filter((row: any) => row.status === DocumentStatus.DISPATCHED)
      .map((row: any) => row.id);
    expect(new Set(markedDispatched)).toEqual(new Set(['doc-ok']));
    expect(emails.sendNow).toHaveBeenCalledTimes(2);
    expect(emails.queue).not.toHaveBeenCalled();
  });

  it('reports progress per document, so the page can show where the batch has got to', async () => {
    const { worker } = await buildWorker();
    const job = batchJob(['doc-ok', 'doc-refused'], 'manager@bank.example');

    await worker.run(job as any);

    expect(job.progress).toHaveBeenLastCalledWith({ percent: 100, stage: 'Emailing documents to the branch (2/2)' });
  });

  it("runs the batch as the person who pressed Send, so the audit trail names them", async () => {
    const { worker, service } = await buildWorker();
    let seen: any = null;
    jest.spyOn(service, 'dispatchDocument').mockImplementation(async () => {
      seen = getRequestContext();
      return {} as any;
    });

    await worker.run(batchJob(['doc-ok'], null) as any);

    expect(seen).toMatchObject({ userId: 'desk-1', roleNames: ['DESK'], organizationId: 'org-1', displayName: 'Anita' });
    expect(service.dispatchDocument).toHaveBeenCalledWith('doc-ok', 'desk-1', DispatchMethod.MANUAL, { branchEmail: undefined });
    expect(getRequestContext()).toBeUndefined();
  });

  it('routes the hourly scan to auto-dispatch, and refuses a job name it does not know', async () => {
    const worker = new DocumentDispatchWorker(null as any, null as any, null as any, null as any);
    const autoDispatch = jest.spyOn(worker, 'autoDispatch').mockResolvedValue({ dispatchedCount: 0, ocrSentCount: 0 });

    await worker.run({ id: '1', name: DOCUMENT_DISPATCH_JOB.AUTO_DISPATCH, data: {} } as any);

    expect(autoDispatch).toHaveBeenCalledTimes(1);
    await expect(worker.run({ id: '2', name: 'mystery', data: {} } as any)).rejects.toThrow(/No handler/);
  });
});

describe('one dispatch at a time, never re-run', () => {
  const stripped = (file: string) => readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /**
   * Bull's loops are per queue and take jobs of any name. A batch handler beside the auto-dispatch
   * handler would be two loops, and two dispatches of one document at once can both pass its
   * UPLOADED check and both email the branch.
   */
  it('has exactly one processing loop on the document-dispatch queue', () => {
    const handlers = [...stripped('document-dispatch.worker.ts').matchAll(/@Process\(([^)]*)\)/g)].map((m) => m[1]);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatch(/name:\s*'\*'/);
    expect(handlers[0]).toMatch(/concurrency:\s*1\b/);
  });

  /** `attempts: 1` does not stop Bull re-running a job whose worker died; this setting does. */
  it('fails a batch whose worker died instead of restarting it and re-sending what already went', () => {
    const module = stripped('document.module.ts');
    const registration = module.slice(module.indexOf('name: DOCUMENT_DISPATCH_QUEUE'));
    expect(registration.slice(0, registration.indexOf('})'))).toMatch(/maxStalledCount:\s*0\b/);
  });
});
