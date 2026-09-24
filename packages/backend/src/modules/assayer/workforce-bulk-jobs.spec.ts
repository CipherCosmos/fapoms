import { NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { WorkforceBulkJobsService } from './workforce-bulk-jobs.service';
import { WorkforceBulkJobsWorker } from './workforce-bulk-jobs.worker';
import { WORKFORCE_BULK_JOB, WORKFORCE_BULK_JOB_OPTIONS } from './workforce-bulk-jobs.contract';
import { getRequestContext } from '../../core/context/request-context';
import { tenantFilterId } from '../../infrastructure/tenancy/ambient-tenant-context';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import { BackgroundJobTracker } from '../../infrastructure/background-jobs/background-job.tracker';

/**
 * ROSTER BULK ACTIONS RUN IN THE BACKGROUND, ONCE, AS THE PERSON WHO STARTED THEM.
 *
 * "Issue app access" over HR's 540-person backlog held one request for about half an hour. The web
 * client gives up at 30 s, so the screen said it failed while the server kept rotating passwords —
 * and a second press rotated everybody's again. These pin what makes the move safe: the request only
 * accepts; a repeat press joins the run already going; the run is never retried; and it sees exactly
 * the people the requester could see.
 */

const ACTOR = { userId: 'hr-1', roleNames: ['OPERATIONS'], organizationId: 'org-1', displayName: 'Priya' };
const IDS = ['c3', 'a1', 'b2'];

function queueWith(jobs: any[] = []) {
  let n = 0;
  return {
    name: 'workforce-bulk-jobs',
    add: jest.fn(async (name: string, data: any) => {
      const job = { id: String(++n), name, data };
      jobs.push(job);
      return job;
    }),
    getJobs: jest.fn(async () => jobs),
    getJob: jest.fn(async (id: string) => jobs.find((j) => j.id === id) ?? null),
  };
}

/**
 * The `background_jobs` rows, in memory — just what a tracked run touches. The real
 * `BackgroundJobsService.enqueueTracked` is used, so the dedupe rule under test is the one in
 * production, not a copy of it.
 */
class RowStore {
  rows = new Map<string, any>();
  private n = 0;
  insert = jest.fn(async (values: any) => {
    const now = new Date();
    const row = {
      id: `bg-${++this.n}`, attempts: 0, bullJobId: null, cancelRequestedAt: null, result: null, error: null,
      resultObjectKey: null, resultFileName: null, exclusiveKey: null, startedAt: null, finishedAt: null,
      createdAt: now, updatedAt: now, inputObjects: null, inputObjectKey: null, parentJobId: null, ...values,
    };
    this.rows.set(row.id, row);
    return { job: { ...row }, inserted: true };
  });
  async setBullJobId(id: string, bullJobId: string) { Object.assign(this.rows.get(id), { bullJobId }); }
  async findById(id: string) { const r = this.rows.get(id); return r ? { ...r } : null; }
  async claim(id: string) {
    const r = this.rows.get(id);
    if (!r || !['QUEUED', 'RUNNING'].includes(r.status)) return null;
    Object.assign(r, { status: 'RUNNING', attempts: r.attempts + 1, startedAt: new Date() });
    return { ...r };
  }
  async transition(id: string, from: string[], patch: any) {
    const r = this.rows.get(id);
    if (!r || !from.includes(r.status)) return null;
    Object.assign(r, patch, { updatedAt: new Date() });
    return { ...r };
  }
  async writeProgress(id: string, progress: any) { const r = this.rows.get(id); if (!r) return false; r.progress = progress; return true; }
  async patch(id: string, patch: any) { Object.assign(this.rows.get(id), patch); }
}

function tracking() {
  const store = new RowStore();
  const jobs = new BackgroundJobsService(
    store as any, new BackgroundJobRegistry(), {} as any, {} as any, { publish: jest.fn() } as any,
  );
  const tracker = new BackgroundJobTracker(store as any, jobs, {} as any);
  return { store, jobs, tracker };
}

/** The service as production builds it: its own queue, tracked on the real `enqueueTracked`. */
function serviceWith(queue: ReturnType<typeof queueWith>) {
  const t = tracking();
  return { service: new WorkforceBulkJobsService(queue as any, t.jobs), ...t };
}

/** A pass-through tracker for worker tests about scope, not tracking: an untracked job runs as before. */
const tracker = () => tracking().tracker;

describe('WorkforceBulkJobsService', () => {
  it('accepts the run and returns a job id instead of doing the work', async () => {
    const queue = queueWith();
    const { service, store } = serviceWith(queue);

    const result = await service.enqueueAppAccess(IDS, ACTOR, ['NORTH']);

    expect(result).toEqual({ jobId: '1', deduplicated: false, backgroundJobId: 'bg-1' });
    expect(queue.add).toHaveBeenCalledWith(
      WORKFORCE_BULK_JOB.APP_ACCESS,
      expect.objectContaining({ ids: ['a1', 'b2', 'c3'], requestedBy: 'hr-1', actor: ACTOR, backgroundJobId: 'bg-1' }),
      WORKFORCE_BULK_JOB_OPTIONS,
    );
    // Recorded on a row the Jobs tray lists after a refresh — counts only, never the ids.
    expect(store.rows.get('bg-1')).toMatchObject({
      kind: 'WORKFORCE_APP_ACCESS', status: 'QUEUED', requestedBy: 'hr-1', regions: ['NORTH'],
      title: 'Issue app access to 3 assayers', params: { action: 'app-access', count: 3 },
      runnerQueue: 'workforce-bulk-jobs', bullJobId: '1',
    });
    expect(store.rows.get('bg-1').progress.total).toBe(3);
  });

  it('joins the run already going when the same person presses the button again — nobody gets a second password', async () => {
    const queue = queueWith();
    const { service, store } = serviceWith(queue);

    const first = await service.enqueueAppAccess(IDS, ACTOR);
    const second = await service.enqueueAppAccess([...IDS].reverse(), ACTOR);

    expect(second).toEqual({ jobId: first.jobId, deduplicated: true, backgroundJobId: first.backgroundJobId });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(store.insert).toHaveBeenCalledTimes(1);
  });

  it('joins a notify run already going when the same message goes to the same people in another order', async () => {
    const queue = queueWith();
    const { service, store } = serviceWith(queue);
    const message = { subject: 'Holiday', body: 'Closed Monday', sendEmail: true };

    const first = await service.enqueueNotify({ ids: IDS, ...message }, ACTOR);
    const second = await service.enqueueNotify({ ids: [...IDS].reverse(), ...message }, ACTOR);

    expect(second).toEqual({ jobId: first.jobId, deduplicated: true, backgroundJobId: first.backgroundJobId });
    // The message itself stays in the Bull payload; the row the tray lists carries counts only.
    expect(store.rows.get(first.backgroundJobId!)).toMatchObject({
      kind: 'WORKFORCE_NOTIFY', params: { action: 'notify', count: 3, sendEmail: true },
    });
    expect(JSON.stringify(store.rows.get(first.backgroundJobId!).params)).not.toMatch(/Closed Monday/);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  /**
   * The run is readable only by whoever started it, so joining somebody else's would hand the
   * second person a job id that answers them 404 — and their press would appear to do nothing.
   */
  it("does not fold one person's press into another person's run over the same people", async () => {
    const queue = queueWith();
    const { service, store } = serviceWith(queue);

    const mine = await service.enqueueAppAccess(IDS, ACTOR);
    const theirs = await service.enqueueAppAccess(IDS, { ...ACTOR, userId: 'hr-2' });

    expect(theirs.deduplicated).toBe(false);
    expect(theirs.jobId).not.toBe(mine.jobId);
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[1][1]).toMatchObject({ requestedBy: 'hr-2' });
  });

  it('treats a different message to the same people as a run of its own, not a repeat to be swallowed', async () => {
    const queue = queueWith();
    const { service, store } = serviceWith(queue);

    await service.enqueueNotify({ ids: IDS, subject: 'Holiday', body: 'Closed Monday', sendEmail: false }, ACTOR);
    const second = await service.enqueueNotify({ ids: IDS, subject: 'Holiday', body: 'Open Monday after all', sendEmail: false }, ACTOR);
    const third = await service.enqueueNotify({ ids: IDS, subject: 'Holiday', body: 'Open Monday after all', sendEmail: true }, ACTOR);

    expect(second.deduplicated).toBe(false);
    expect(third.deduplicated).toBe(false);
    expect(queue.add).toHaveBeenCalledTimes(3);
  });

  it('joins a lifecycle walk already going for the same people and target, but not a different target', async () => {
    const queue = queueWith();
    const { service, store } = serviceWith(queue);

    const first = await service.enqueueLifecycle({ ids: IDS, targetStatus: 'ACTIVE' }, ACTOR);
    const again = await service.enqueueLifecycle({ ids: [...IDS].reverse(), targetStatus: 'ACTIVE' }, ACTOR);
    const other = await service.enqueueLifecycle({ ids: IDS, targetStatus: 'ON_LEAVE' }, ACTOR);

    expect(again).toEqual({ jobId: first.jobId, deduplicated: true, backgroundJobId: first.backgroundJobId });
    expect(other.deduplicated).toBe(false);
    expect(store.rows.get(first.backgroundJobId!)).toMatchObject({
      kind: 'WORKFORCE_LIFECYCLE', title: 'Move 3 assayers to Active', params: { action: 'lifecycle', count: 3, targetStatus: 'ACTIVE' },
    });
  });

  it('never retries a credential run, because a retry rotates the passwords it already sent', () => {
    expect(WORKFORCE_BULK_JOB_OPTIONS.attempts).toBe(1);
  });

  it("answers 404 to anybody but the person who started the run", async () => {
    const queue = queueWith();
    const { service, store } = serviceWith(queue);
    const { jobId } = await service.enqueueNotify({ ids: IDS, subject: 's', body: 'b', sendEmail: false }, ACTOR);

    await expect(service.status(jobId, 'someone-else')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('WorkforceBulkJobsWorker', () => {
  /** What the batch sees of who is running it — the org it is scoped to and the roles it holds. */
  const scopeSeen = () => {
    const ctx = getRequestContext();
    return { org: tenantFilterId(), userId: ctx?.userId, roleNames: ctx?.roleNames, displayName: ctx?.displayName };
  };
  const SCOPE = { org: 'org-1', userId: 'hr-1', roleNames: ['OPERATIONS'], displayName: 'Priya' };

  it("runs the batch inside the requester's scope, so it finds exactly the people they could", async () => {
    let seen: ReturnType<typeof scopeSeen> | null = null;
    const assayers = {
      bulkIssueAppAccess: jest.fn(async () => {
        seen = scopeSeen();
        return { succeeded: [], skipped: [], failed: [] };
      }),
    };
    const worker = new WorkforceBulkJobsWorker(assayers as any, tracker());

    await worker.appAccess({ id: '9', data: { ids: IDS, actor: ACTOR }, progress: jest.fn() } as any);

    // Outside a request a background job is unscoped; this one must not be.
    expect(tenantFilterId()).toBeNull();
    expect(seen).toEqual(SCOPE);
    expect(assayers.bulkIssueAppAccess).toHaveBeenCalledWith(IDS, 'hr-1', expect.any(Function));
  });

  it("passes the message through for a notify run, inside the requester's scope too", async () => {
    let seen: ReturnType<typeof scopeSeen> | null = null;
    const assayers = {
      bulkNotify: jest.fn(async () => {
        seen = scopeSeen();
        return { succeeded: [], skipped: [], failed: [] };
      }),
    };
    const worker = new WorkforceBulkJobsWorker(assayers as any, tracker());

    await worker.notify({
      id: '10', data: { ids: IDS, subject: 'Holiday', body: 'Closed Monday', sendEmail: true, actor: ACTOR }, progress: jest.fn(),
    } as any);

    expect(assayers.bulkNotify).toHaveBeenCalledWith(IDS, 'Holiday', 'Closed Monday', true, 'hr-1', expect.any(Function));
    expect(seen).toEqual(SCOPE);
    expect(tenantFilterId()).toBeNull();
  });

  /**
   * Tenant scoping reads every role, not the first: a cross-tenant role anywhere in the list is
   * what widens the lookup. A context carrying only the first role would confine this ADMIN to one
   * organisation in the background while the same press in the request reached every one.
   */
  it('gives a principal whose ADMIN role is not listed first the same cross-organisation reach it had in the request', async () => {
    let org: string | null | undefined = 'unset';
    const assayers = { bulkIssueAppAccess: jest.fn(async () => { org = tenantFilterId(); return {}; }) };
    const worker = new WorkforceBulkJobsWorker(assayers as any, tracker());
    const actor = { ...ACTOR, roleNames: ['OPERATIONS', 'ADMIN'] };

    await worker.appAccess({ id: '11', data: { ids: IDS, actor }, progress: jest.fn() } as any);

    expect(org).toBeNull();
  });
});

describe('a roster bulk run is recorded on its background_jobs row (the Jobs tray)', () => {
  it('goes RUNNING, carries the progress, and ends SUCCEEDED with a one-line summary — the Bull result unchanged', async () => {
    const queue = queueWith();
    const { service, store, tracker: realTracker } = serviceWith(queue);
    const { jobId, backgroundJobId } = await service.enqueueAppAccess(IDS, ACTOR);
    const bull = queue.add.mock.results[0].value;
    const buckets = {
      succeeded: [{ id: 'a1', channels: ['EMAIL'] }, { id: 'b2', channels: ['SMS'] }],
      skipped: [{ id: 'c3', reason: 'Has no phone or email' }],
      failed: [],
    };
    const assayers = {
      bulkIssueAppAccess: jest.fn(async (_ids: string[], _by: string, progress: any) => {
        expect(store.rows.get(backgroundJobId!).status).toBe('RUNNING');
        await progress(3, 3, 'Issuing access');
        return buckets;
      }),
    };
    const worker = new WorkforceBulkJobsWorker(assayers as any, realTracker);
    const job = { ...(await bull), id: jobId, progress: jest.fn(), attemptsMade: 0, opts: { attempts: 1 } };

    const result = await worker.run(job as any);

    expect(result).toBe(buckets);
    // Bull still gets its progress, so the page's own poll route answers as before.
    expect(job.progress).toHaveBeenCalled();
    const row = store.rows.get(backgroundJobId!);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.result).toEqual({
      summary: '2 issued app access; 1 skipped.',
      counts: { succeeded: 2, skipped: 1, failed: 0 },
    });
  });

  it('records a failed run as FAILED with its reason, and still rethrows for Bull', async () => {
    const queue = queueWith();
    const { service, store, tracker: realTracker } = serviceWith(queue);
    const { jobId, backgroundJobId } = await service.enqueueLifecycle({ ids: IDS, targetStatus: 'ACTIVE' }, ACTOR);
    const bull = await queue.add.mock.results[0].value;
    const assayers = { bulkTransitionLifecycle: jest.fn(async () => { throw new Error('The database is unavailable.'); }) };
    const worker = new WorkforceBulkJobsWorker(assayers as any, realTracker);

    await expect(worker.run({ ...bull, id: jobId, progress: jest.fn(), attemptsMade: 0, opts: { attempts: 1 } } as any))
      .rejects.toThrow('The database is unavailable.');
    expect(store.rows.get(backgroundJobId!)).toMatchObject({ status: 'FAILED', error: 'The database is unavailable.' });
  });
});

describe('one roster bulk run at a time', () => {
  const stripped = (file: string) => readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /**
   * Bull's loops are per queue and take jobs of any name. Two `@Process` handlers at concurrency 1
   * were two loops, so two credential runs over the same people could rotate a password twice at once.
   */
  it('has exactly one processing loop on the queue', () => {
    const worker = stripped('workforce-bulk-jobs.worker.ts');
    const handlers = [...worker.matchAll(/@Process\(([^)]*)\)/g)].map((m) => m[1]);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatch(/name:\s*'\*'/);
    expect(handlers[0]).toMatch(/concurrency:\s*1\b/);
  });

  it('routes each job name to its action, and refuses a name it does not know', async () => {
    const assayers = {
      bulkIssueAppAccess: jest.fn(async () => ({ succeeded: [], skipped: [], failed: [] })),
      bulkNotify: jest.fn(async () => ({ succeeded: [], skipped: [], failed: [] })),
    };
    const worker = new WorkforceBulkJobsWorker(assayers as any, tracker());
    const job = (name: string, data: any) => ({ id: '1', name, data, progress: jest.fn() }) as any;

    await worker.run(job(WORKFORCE_BULK_JOB.APP_ACCESS, { ids: IDS, actor: ACTOR }));
    await worker.run(job(WORKFORCE_BULK_JOB.NOTIFY, { ids: IDS, subject: 's', body: 'b', sendEmail: false, actor: ACTOR }));

    expect(assayers.bulkIssueAppAccess).toHaveBeenCalledTimes(1);
    expect(assayers.bulkNotify).toHaveBeenCalledTimes(1);
    await expect(worker.run(job('mystery', {}))).rejects.toThrow(/No handler/);
  });

  it('runs a lifecycle walk inside the requester\'s scope, reporting progress', async () => {
    let org: string | null = 'unset';
    const assayers = {
      bulkTransitionLifecycle: jest.fn(async () => { org = tenantFilterId(); return { succeeded: [], partial: [], skipped: [], failed: [] }; }),
    };
    const worker = new WorkforceBulkJobsWorker(assayers as any, tracker());

    await worker.run({ id: '12', name: WORKFORCE_BULK_JOB.LIFECYCLE, data: { ids: IDS, targetStatus: 'ACTIVE', reason: 'cleared', actor: ACTOR }, progress: jest.fn() } as any);

    expect(assayers.bulkTransitionLifecycle).toHaveBeenCalledWith(IDS, 'ACTIVE', 'hr-1', 'cleared', expect.any(Function));
    expect(org).toBe('org-1');
  });

  /** `attempts: 1` does not stop Bull re-running a job whose worker died; this setting does. */
  it('fails a run whose worker died instead of restarting it and re-rotating passwords', () => {
    const module = stripped('assayer.module.ts');
    const registration = module.slice(module.indexOf('name: WORKFORCE_BULK_QUEUE'));
    expect(registration.slice(0, registration.indexOf('})'))).toMatch(/maxStalledCount:\s*0\b/);
  });
});

describe('the bulk roster routes', () => {
  const controller = readFileSync(join(__dirname, 'assayer.controller.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const body = (method: string) => {
    const start = controller.indexOf(`async ${method}(`);
    return controller.slice(start, controller.indexOf('\n  }\n', start));
  };

  it.each(['bulkIssueAppAccess', 'bulkNotify', 'bulkTransitionLifecycle'])('%s queues the run rather than performing it inside the request', (method) => {
    expect(body(method)).toMatch(/this\.bulkJobs\.enqueue/);
    expect(body(method)).not.toMatch(/this\.assayerService\.bulk/);
    // The region check still happens before anything is accepted — once for the whole batch.
    expect(body(method)).toMatch(/assertAssayersInScope\(dto\.ids, scope\)/);
    // And the requester's regions go on the tracked row, so an administrator's all-jobs view is scoped.
    expect(body(method)).toMatch(/assignedRegions\(req\.user\)/);
  });

  it('still refuses a bad lifecycle target or reason in the request, before anything is queued', () => {
    const lifecycle = body('bulkTransitionLifecycle');
    expect(lifecycle.indexOf('assertBulkLifecycleRequest')).toBeGreaterThan(-1);
    expect(lifecycle.indexOf('assertBulkLifecycleRequest')).toBeLessThan(lifecycle.indexOf('enqueueLifecycle'));
  });
});
