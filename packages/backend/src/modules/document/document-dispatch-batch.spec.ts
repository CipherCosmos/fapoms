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
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import type { BackgroundJobStatus } from '@fapoms/shared';
import { BackgroundJobEntity } from '../../infrastructure/background-jobs/background-job.entity';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';
import { BackgroundJobTracker } from '../../infrastructure/background-jobs/background-job.tracker';
import { DOCUMENT_DISPATCH_KIND } from './document-dispatch-jobs.service';

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
    name: 'document-dispatch',
    add: jest.fn(async (name: string, data: any, opts: any = {}) => {
      const job = {
        id: String(++n), name, data, opts, attemptsMade: 0,
        getState: async () => 'waiting', progress: jest.fn(async () => 0), timestamp: Date.now(),
      };
      jobs.push(job);
      return job;
    }),
    getJobs: jest.fn(async () => jobs),
    getJob: jest.fn(async (id: string) => jobs.find((j) => j.id === id) ?? null),
  };
}

/**
 * The background-jobs foundation with an in-memory store — the real `BackgroundJobsService` and
 * `BackgroundJobTracker`, so "the batch is tracked on a row" is the foundation's own behaviour here,
 * not a mock's. The store keeps the rules that matter: conditional transitions, one row per insert.
 */
class FakeJobStore {
  rows = new Map<string, BackgroundJobEntity>();
  private clone(r?: BackgroundJobEntity | null) { return r ? ({ ...r, progress: { ...r.progress } } as BackgroundJobEntity) : null; }
  async findById(id: string) { return this.clone(this.rows.get(id)); }
  async findOpenByDedupe() { return null; }
  async insert(values: Partial<BackgroundJobEntity>) {
    const now = new Date();
    const row = {
      id: randomUUID(), attempts: 0, bullJobId: null, cancelRequestedAt: null, result: null, resultObjectKey: null,
      error: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now, inputObjects: null, inputObjectKey: null,
      ...values,
    } as BackgroundJobEntity;
    this.rows.set(row.id, row);
    return { job: this.clone(row)!, inserted: true };
  }
  async setBullJobId(id: string, bullJobId: string) { this.touch(id, { bullJobId }); }
  async claim(id: string) {
    const row = this.rows.get(id);
    if (!row || !['QUEUED', 'RUNNING'].includes(row.status)) return null;
    this.touch(id, { status: 'RUNNING', attempts: row.attempts + 1, startedAt: new Date() });
    return this.findById(id);
  }
  async transition(id: string, from: BackgroundJobStatus[], patch: Partial<BackgroundJobEntity>) {
    const row = this.rows.get(id);
    if (!row || !from.includes(row.status)) return null;
    this.touch(id, patch);
    return this.findById(id);
  }
  async writeProgress(id: string, progress: any) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'RUNNING') return false;
    this.touch(id, { progress });
    return true;
  }
  async patch(id: string, patch: Partial<BackgroundJobEntity>) { this.touch(id, patch); }
  private touch(id: string, patch: Partial<BackgroundJobEntity>) {
    const row = this.rows.get(id);
    if (row) Object.assign(row, patch, { updatedAt: new Date() });
  }
}

function foundation() {
  const store = new FakeJobStore();
  const storage = { saveFile: jest.fn(async () => 'k'), deleteFile: jest.fn() };
  const jobs = new BackgroundJobsService(
    store as any, new BackgroundJobRegistry(), { add: jest.fn() } as any, storage as any, { publish: jest.fn() } as any,
  );
  const tracker = new BackgroundJobTracker(store as any, jobs, storage as any);
  return { store, jobs, tracker };
}

beforeAll(() => Logger.overrideLogger(false));
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

describe('DocumentDispatchJobsService', () => {
  it('accepts the batch and returns a job id instead of sending anything', async () => {
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any, foundation().jobs);

    const result = await service.enqueueBatch({ documentIds: IDS, branchEmail: ' manager@bank.example ' }, ACTOR);

    expect(result).toEqual({ jobId: '1', deduplicated: false, backgroundJobId: expect.any(String) });
    expect(queue.add).toHaveBeenCalledWith(
      DOCUMENT_DISPATCH_JOB.DISPATCH_BATCH,
      expect.objectContaining({
        documentIds: ['doc-a', 'doc-b', 'doc-c'],
        branchEmail: 'manager@bank.example',
        requestedBy: 'desk-1',
        actor: ACTOR,
        backgroundJobId: result.backgroundJobId,
      }),
      DISPATCH_BATCH_JOB_OPTIONS,
    );
  });

  it('records the batch on a tracked row, so the Jobs tray shows it after a refresh — ids stay off the row', async () => {
    const queue = queueWith();
    const { jobs, store } = foundation();
    const service = new DocumentDispatchJobsService(queue as any, jobs);

    const { jobId, backgroundJobId } = await service.enqueueBatch({ documentIds: IDS, branchEmail: 'manager@bank.example' }, ACTOR, ['WEST']);

    const row = store.rows.get(backgroundJobId!)!;
    expect(row).toMatchObject({
      kind: DOCUMENT_DISPATCH_KIND,
      status: 'QUEUED',
      requestedBy: 'desk-1',
      regions: ['WEST'],
      runnerQueue: 'document-dispatch',
      bullJobId: jobId,
      title: 'Send 3 documents to manager@bank.example',
      params: { documentCount: 3, branchEmail: 'manager@bank.example' },
    });
    expect(row.progress.total).toBe(3);
    expect(JSON.stringify(row.params)).not.toContain('doc-a');
  });

  it('a repeat press writes no second row', async () => {
    const queue = queueWith();
    const { jobs, store } = foundation();
    const service = new DocumentDispatchJobsService(queue as any, jobs);

    await service.enqueueBatch({ documentIds: IDS }, ACTOR);
    await service.enqueueBatch({ documentIds: [...IDS].reverse() }, ACTOR);

    expect(store.rows.size).toBe(1);
  });

  it('joins the batch already going when the same person presses Send again — the branch gets one copy', async () => {
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any, foundation().jobs);

    const first = await service.enqueueBatch({ documentIds: IDS, branchEmail: 'manager@bank.example' }, ACTOR);
    const again = await service.enqueueBatch({ documentIds: [...IDS].reverse(), branchEmail: 'manager@bank.example' }, ACTOR);

    expect(again).toEqual({ jobId: first.jobId, deduplicated: true, backgroundJobId: first.backgroundJobId });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  /** A batch is readable only by whoever started it, so joining another person's would answer them 404. */
  it("does not fold one person's press into another person's identical batch", async () => {
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any, foundation().jobs);

    const mine = await service.enqueueBatch({ documentIds: IDS }, ACTOR);
    const theirs = await service.enqueueBatch({ documentIds: IDS }, { ...ACTOR, userId: 'desk-2' });

    expect(theirs.deduplicated).toBe(false);
    expect(theirs.jobId).not.toBe(mine.jobId);
  });

  it('treats the same documents to a different address as a delivery of its own', async () => {
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any, foundation().jobs);

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
    const service = new DocumentDispatchJobsService(queue as any, foundation().jobs);
    const { jobId } = await service.enqueueBatch({ documentIds: IDS }, ACTOR);

    await expect(service.status(jobId, 'someone-else')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.status(jobId, 'desk-1')).resolves.toMatchObject({ jobId, state: 'queued' });
  });

  /** Job ids are a counter shared with the hourly scan; its jobs carry no requester and are nobody's. */
  it('answers 404 for a job on the queue that is not a batch', async () => {
    const queue = queueWith([
      { id: '7', name: DOCUMENT_DISPATCH_JOB.AUTO_DISPATCH, data: { requestedBy: 'desk-1' } },
    ]);
    const service = new DocumentDispatchJobsService(queue as any, foundation().jobs);

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
      null as any, // backgroundJobs
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
      null, // the caller's regions (unrestricted here), captured on the tracked row
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
    const tracked = foundation();
    return {
      worker: new DocumentDispatchWorker(documentRepo as any, null as any, service, null as any, tracked.tracker),
      service,
      tracked,
    };
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

  it('a tracked batch: its row goes RUNNING, carries the progress, and ends SUCCEEDED with a one-line summary', async () => {
    const { worker, tracked } = await buildWorker();
    const queue = queueWith();
    const service = new DocumentDispatchJobsService(queue as any, tracked.jobs);
    const { jobId, backgroundJobId } = await service.enqueueBatch({ documentIds: ['doc-ok', 'doc-refused'], branchEmail: 'manager@bank.example' }, ACTOR);
    const bull = (await queue.getJob(jobId))!;

    const result = await worker.run(bull as any);

    // What Bull (and the page's poll) gets is unchanged…
    expect(result).toEqual({ dispatched: ['doc-ok'], failed: [expect.objectContaining({ documentId: 'doc-refused' })] });
    expect(bull.progress).toHaveBeenCalled();
    // …and the row the Jobs tray reads says how it ended.
    const row = tracked.store.rows.get(backgroundJobId!)!;
    expect(row.status).toBe('SUCCEEDED');
    expect(row.result).toEqual({ summary: 'Sent 1 document; 1 did not go.', counts: { dispatched: 1, failed: 1 } });
    expect(row.progress.percent).toBe(100);
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
    const worker = new DocumentDispatchWorker(null as any, null as any, null as any, null as any, foundation().tracker);
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
