import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import type { BackgroundJobKind, BackgroundJobStatus } from '@fapoms/shared';
import { BackgroundJobEntity } from './background-job.entity';
import { BackgroundJobRegistry } from './background-job.registry';
import { OPEN_STATUSES } from './background-job.store';
import { trackedJobLockKey } from './background-job.tracker';
import { BackgroundJobsService, INTERRUPTED_MESSAGE, type JobReader } from './background-jobs.service';
import { BackgroundJobRunner } from './background-job.runner';
import { BackgroundJobRecovery } from './background-jobs.recovery';
import { BackgroundJobTracker } from './background-job.tracker';
import { succeed, type BackgroundJobDefinition, type RunContext } from './background-jobs.contract';

/**
 * The two extensions to the foundation, without Postgres or Redis:
 *
 *  1. a job uploaded as SEVERAL files (`input: 'files'`) — each stored before the row, handed to the
 *     run one at a time;
 *  2. a TRACKED run — one that stays on its feature's own Bull queue (`enqueueTracked` +
 *     `BackgroundJobTracker`) and is recorded on a row so a refreshed page and the Jobs tray find it.
 *
 * The fakes keep the rules the real store keeps (conditional transitions, one open row per dedupe
 * key); `background-jobs.lifecycle.spec.ts` covers the single-file lifecycle with the same shapes.
 */

const FILES_KIND = 'TEST_FILES' as BackgroundJobKind;
const TRACKED_KIND = 'TEST_TRACKED' as BackgroundJobKind;
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';

class FakeStore {
  rows = new Map<string, BackgroundJobEntity>();
  private clone(r: BackgroundJobEntity | undefined | null) {
    return r ? ({ ...r, progress: { ...r.progress } } as BackgroundJobEntity) : null;
  }
  async findById(id: string) { return this.clone(this.rows.get(id)); }
  async findOpenByDedupe(key: string) {
    return this.clone([...this.rows.values()].find((r) => r.dedupeKey === key && OPEN_STATUSES.includes(r.status)));
  }
  insertFails = false;
  async insert(values: Partial<BackgroundJobEntity>) {
    if (this.insertFails) throw new Error('database down');
    const clash = values.dedupeKey ? await this.findOpenByDedupe(values.dedupeKey) : null;
    if (clash) return { job: clash, inserted: false };
    const now = new Date();
    const row = {
      id: randomUUID(), attempts: 0, bullJobId: null, cancelRequestedAt: null, cancelRequestedBy: null,
      result: null, resultObjectKey: null, resultFileName: null, resultMimeType: null, error: null,
      exclusiveKey: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now,
      inputObjects: null, runnerQueue: null, inputObjectKey: null,
      ...values,
    } as BackgroundJobEntity;
    this.rows.set(row.id, row);
    return { job: this.clone(row)!, inserted: true };
  }
  async setBullJobId(id: string, bullJobId: string) { this.touch(id, { bullJobId }); }
  async claim(id: string) {
    const row = this.rows.get(id);
    if (!row || !['QUEUED', 'RUNNING'].includes(row.status)) return null;
    this.touch(id, { status: 'RUNNING', attempts: row.attempts + 1, startedAt: row.startedAt ?? new Date() });
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
  async cancelRequestedAt(id: string) { return this.rows.get(id)?.cancelRequestedAt ?? null; }
  async findStaleOpen(idleMs: number) {
    return [...this.rows.values()]
      .filter((r) => ['QUEUED', 'RUNNING'].includes(r.status) && r.updatedAt.getTime() < Date.now() - idleMs)
      .map((r) => this.clone(r)!);
  }
  age(id: string, ms: number) {
    const row = this.rows.get(id)!;
    row.updatedAt = new Date(Date.now() - ms);
    row.createdAt = new Date(Date.now() - ms);
  }
  private touch(id: string, patch: Partial<BackgroundJobEntity>) {
    const row = this.rows.get(id);
    if (row) Object.assign(row, patch, { updatedAt: new Date() });
  }
}

type FakeBullJob = {
  id: string; name: string; data: any; opts: any; state: string; failedReason?: string;
  remove: jest.Mock; getState: () => Promise<string>; progress: jest.Mock; attemptsMade: number;
};

class FakeQueue {
  constructor(readonly name: string) {}
  private seq = 0;
  jobs = new Map<string, FakeBullJob>();
  add = jest.fn(async (name: string, data: any, opts: any = {}) => {
    const id = opts.jobId ?? String(++this.seq);
    const job: FakeBullJob = {
      id, name, data, opts, state: 'waiting', attemptsMade: 0,
      remove: jest.fn(async () => { this.jobs.delete(id); }),
      getState: async () => job.state,
      progress: jest.fn(async () => undefined),
    };
    this.jobs.set(id, job);
    return job;
  });
  getJob = jest.fn(async (id: string) => this.jobs.get(id) ?? null);
  getJobs = jest.fn(async (states: string[]) => [...this.jobs.values()].filter((j) => states.includes(j.state)));
}

class FakeStorage {
  objects = new Map<string, Buffer>();
  failOnSave: number | null = null;
  private saves = 0;
  saveFile = jest.fn(async (name: string, content: Buffer | Readable) => {
    this.saves++;
    if (this.failOnSave === this.saves) throw new Error('bucket unavailable');
    const buf = Buffer.isBuffer(content) ? content : await toBuffer(content);
    const key = `k/${randomUUID()}/${name}`;
    this.objects.set(key, buf);
    return key;
  });
  getFileStream = jest.fn(async (key: string) => Readable.from(this.objects.get(key) ?? Buffer.alloc(0)));
  deleteFile = jest.fn(async (key: string) => { this.objects.delete(key); });
}

async function toBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

const actor = () => ({ userId: ALICE, roleNames: ['OPERATIONS'], displayName: 'alice' });
const reader = (): JobReader => ({ userId: ALICE, roleNames: ['OPERATIONS'], regions: null, organizationId: null });
const pdf = (name: string, text = `%PDF-1.4 ${name}`) =>
  ({ buffer: Buffer.from(text), originalName: name, mimeType: 'application/pdf', size: Buffer.byteLength(text) });

let store: FakeStore;
let trackedQueue: FakeQueue;
let featureQueue: FakeQueue;
let storage: FakeStorage;
let events: { publish: jest.Mock };
let registry: BackgroundJobRegistry;
let service: BackgroundJobsService;
let runner: BackgroundJobRunner;
let recovery: BackgroundJobRecovery;
let tracker: BackgroundJobTracker;

beforeAll(() => Logger.overrideLogger(false));
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

beforeEach(() => {
  store = new FakeStore();
  trackedQueue = new FakeQueue('tracked-jobs');
  featureQueue = new FakeQueue('billing-bulk');
  storage = new FakeStorage();
  events = { publish: jest.fn() };
  registry = new BackgroundJobRegistry();
  const resolver = { get: (name: string) => (name === featureQueue.name ? featureQueue : null) };
  service = new BackgroundJobsService(store as any, registry, trackedQueue as any, storage as any, events as any, resolver as any);
  runner = new BackgroundJobRunner(store as any, registry, service, storage as any);
  recovery = new BackgroundJobRecovery(store as any, registry, service, trackedQueue as any);
  tracker = new BackgroundJobTracker(store as any, service, storage as any);
});

function defineFiles(overrides: Partial<BackgroundJobDefinition<any>> = {}): BackgroundJobDefinition<any> {
  return { kind: FILES_KIND, input: 'files', idempotent: false, exclusive: 'none', run: async () => succeed({ summary: 'ok' }), ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('a job uploaded as several files', () => {
  it('stores every file before the row, records each, and hands them to the run one by one', async () => {
    const seen: string[] = [];
    registry.register(defineFiles({
      run: async (ctx: RunContext<any>) => {
        for (const f of ctx.inputFiles) seen.push(`${f.index}:${f.fileName}:${(await f.read()).toString()}`);
        return succeed({ summary: `${ctx.inputFiles.length} read` });
      },
    }));

    const { job } = await service.create({
      kind: FILES_KIND, actor: actor(), regions: null, files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')],
    });

    const row = store.rows.get(job.id)!;
    expect(row.inputObjects).toHaveLength(3);
    expect(row.inputObjects!.map((o) => o.fileName)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(row.inputObjects!.every((o) => /^[0-9a-f]{64}$/.test(o.sha256))).toBe(true);
    expect(row.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(job.inputFileName).toBe('3 files');
    expect(job.inputFileCount).toBe(3);
    expect(Number(row.inputSize)).toBe(['a.pdf', 'b.pdf', 'c.pdf'].reduce((n, x) => n + Buffer.byteLength(`%PDF-1.4 ${x}`), 0));
    // The Bull job still carries only the row id.
    expect(trackedQueue.add.mock.calls[0][1]).toEqual({ backgroundJobId: job.id });

    await runner.run({ id: job.id, data: { backgroundJobId: job.id } } as any);
    expect(seen).toEqual(['0:a.pdf:%PDF-1.4 a.pdf', '1:b.pdf:%PDF-1.4 b.pdf', '2:c.pdf:%PDF-1.4 c.pdf']);
    expect(store.rows.get(job.id)!.status).toBe('SUCCEEDED');
  });

  it('a file that cannot be stored undoes the ones already stored — no half-stored set, no row', async () => {
    registry.register(defineFiles());
    storage.failOnSave = 3;
    await expect(service.create({
      kind: FILES_KIND, actor: actor(), regions: null, files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')],
    })).rejects.toThrow('bucket unavailable');
    expect(storage.objects.size).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it('the same set uploaded twice while open is one job', async () => {
    registry.register(defineFiles());
    const first = await service.create({ kind: FILES_KIND, actor: actor(), regions: null, files: [pdf('a.pdf'), pdf('b.pdf')] });
    const again = await service.create({ kind: FILES_KIND, actor: actor(), regions: null, files: [pdf('a.pdf'), pdf('b.pdf')] });
    expect(again.deduplicated).toBe(true);
    expect(again.job.id).toBe(first.job.id);
  });

  it('refuses a set for a one-file kind, one file for a set kind, and an empty set', async () => {
    registry.register(defineFiles());
    registry.register({ ...defineFiles(), kind: 'TEST_ONE' as BackgroundJobKind, input: 'required' });
    await expect(service.create({ kind: FILES_KIND, actor: actor(), regions: null, file: pdf('a.pdf') }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ kind: FILES_KIND, actor: actor(), regions: null, files: [] }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ kind: 'TEST_ONE' as BackgroundJobKind, actor: actor(), regions: null, files: [pdf('a.pdf')] }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

const envelope = (key = 'k1') => ({ requestedBy: ALICE, dedupeKey: key, payableIds: ['p1', 'p2'] });
const trackedRequest = (data = envelope()) => ({
  kind: TRACKED_KIND, actor: actor(), regions: ['WEST'], title: 'Approve 2 payouts', params: { count: 2 }, total: 2,
  queue: featureQueue as any, jobName: 'approve-payouts', data, options: { attempts: 1 },
});

describe('a tracked run on a feature queue', () => {
  it('writes a QUEUED row naming its queue, adds the feature job carrying the row id, and records the Bull id', async () => {
    const out = await service.enqueueTracked(trackedRequest());

    expect(out.deduplicated).toBe(false);
    expect(out.backgroundJobId).toBeTruthy();
    const row = store.rows.get(out.backgroundJobId!)!;
    expect(row.status).toBe('QUEUED');
    expect(row.runnerQueue).toBe('billing-bulk');
    expect(row.bullJobId).toBe(out.jobId);
    expect(row.regions).toEqual(['WEST']);
    expect(row.progress.total).toBe(2);
    // The feature's payload is untouched apart from the row id.
    expect(featureQueue.add).toHaveBeenCalledWith('approve-payouts', { ...envelope(), backgroundJobId: row.id }, { attempts: 1 });
    // Never on the foundation's own queue.
    expect(trackedQueue.add).not.toHaveBeenCalled();
    // Visible through the same list the Jobs tray reads.
    expect(events.publish).toHaveBeenCalled();
  });

  it("keeps the feature's duplicate rule: an identical in-flight run is joined, and no second row is written", async () => {
    const first = await service.enqueueTracked(trackedRequest());
    const again = await service.enqueueTracked(trackedRequest());
    expect(again).toEqual({ jobId: first.jobId, deduplicated: true, backgroundJobId: first.backgroundJobId });
    expect(store.rows.size).toBe(1);
    expect(featureQueue.add).toHaveBeenCalledTimes(1);

    // A finished run is not joined.
    featureQueue.jobs.get(first.jobId)!.state = 'completed';
    const third = await service.enqueueTracked(trackedRequest());
    expect(third.deduplicated).toBe(false);
    expect(store.rows.size).toBe(2);
  });

  it('a run whose add fails leaves a FAILED row, and the error still reaches the caller', async () => {
    featureQueue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.enqueueTracked(trackedRequest())).rejects.toThrow('redis down');
    const [row] = [...store.rows.values()];
    expect(row.status).toBe('FAILED');
  });

  it('tracking never blocks the work: a row that cannot be written queues the run untracked', async () => {
    store.insertFails = true;
    const out = await service.enqueueTracked(trackedRequest());
    expect(out.backgroundJobId).toBeNull();
    expect(featureQueue.add).toHaveBeenCalledWith('approve-payouts', envelope(), { attempts: 1 });
  });

  it('the worker side: RUNNING with progress, then SUCCEEDED with the small summary — the return value is Bull\'s as before', async () => {
    const { jobId, backgroundJobId } = await service.enqueueTracked(trackedRequest());
    const bull = featureQueue.jobs.get(jobId)!;

    const result = await tracker.run(bull as any, async (t) => {
      expect(store.rows.get(backgroundJobId!)!.status).toBe('RUNNING');
      await t.progress(1, 2, 'Approving payouts');
      expect(store.rows.get(backgroundJobId!)!.progress).toMatchObject({ processed: 1, total: 2, percent: 50, stage: 'Approving payouts' });
      await t.attachReport('outcome.xlsx', Buffer.from('xlsx'), 'application/xlsx');
      return { approved: ['p1', 'p2'], refused: [] };
    }, { describe: (r) => ({ summary: `${r.approved.length} approved`, counts: { approved: r.approved.length } }) });

    expect(result).toEqual({ approved: ['p1', 'p2'], refused: [] });
    expect(bull.progress).toHaveBeenCalled(); // Bull progress still written for the old poll route
    const row = store.rows.get(backgroundJobId!)!;
    expect(row.status).toBe('SUCCEEDED');
    expect(row.result).toEqual({ summary: '2 approved', counts: { approved: 2 } });
    expect(row.progress.percent).toBe(100);
    expect(row.resultFileName).toBe('outcome.xlsx');
    expect((await service.get(reader(), row.id)).hasResultFile).toBe(true);
  });

  it('a handler that throws: the row is FAILED with its sentence, and the error is rethrown for Bull', async () => {
    const { jobId, backgroundJobId } = await service.enqueueTracked(trackedRequest());
    await expect(tracker.run(featureQueue.jobs.get(jobId)! as any, async () => {
      throw new Error('Payout p2 is no longer awaiting approval.');
    }, { describe: () => ({ summary: 'x' }) })).rejects.toThrow('no longer awaiting');
    const row = store.rows.get(backgroundJobId!)!;
    expect(row.status).toBe('FAILED');
    expect(row.error).toBe('Payout p2 is no longer awaiting approval.');
  });

  it('a failure Bull will retry puts the row back to QUEUED, and the next attempt claims it again', async () => {
    const { jobId, backgroundJobId } = await service.enqueueTracked({ ...trackedRequest(), options: { attempts: 3 } });
    const bull = featureQueue.jobs.get(jobId)!;
    await expect(tracker.run(bull as any, async () => { throw new Error('transient'); }, { describe: () => ({ summary: 'x' }) }))
      .rejects.toThrow('transient');
    expect(store.rows.get(backgroundJobId!)!.status).toBe('QUEUED');

    bull.attemptsMade = 1;
    await tracker.run(bull as any, async () => 'ok', { describe: () => ({ summary: 'done' }) });
    expect(store.rows.get(backgroundJobId!)!.status).toBe('SUCCEEDED');
  });

  it('a job queued before tracking existed runs untracked, exactly as before', async () => {
    const out = await tracker.run({ id: '9', data: envelope(), progress: jest.fn(), attemptsMade: 0, opts: {} } as any,
      async (t) => { expect(t.backgroundJobId).toBeNull(); return 42; }, { describe: () => ({ summary: 'x' }) });
    expect(out).toBe(42);
    expect(store.rows.size).toBe(0);
  });

  it('cancel: a waiting run is taken off ITS queue; a running one cannot be stopped part-way', async () => {
    const waiting = await service.enqueueTracked(trackedRequest());
    const cancelled = await service.cancel(reader(), waiting.backgroundJobId!);
    expect(cancelled.status).toBe('CANCELLED');
    expect(featureQueue.jobs.has(waiting.jobId)).toBe(false);

    const running = await service.enqueueTracked(trackedRequest(envelope('k2')));
    await store.claim(running.backgroundJobId!);
    expect((await service.get(reader(), running.backgroundJobId!)).cancellable).toBe(false);
    await expect(service.cancel(reader(), running.backgroundJobId!)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('recovering a tracked run whose worker went away', () => {
  async function staleRun(state: string, failedReason?: string) {
    const out = await service.enqueueTracked(trackedRequest(envelope(randomUUID())));
    await store.claim(out.backgroundJobId!);
    const bull = featureQueue.jobs.get(out.jobId)!;
    bull.state = state;
    bull.failedReason = failedReason;
    store.age(out.backgroundJobId!, 10 * 60_000);
    return out;
  }

  it('follows Bull — never re-queues onto the foundation queue', async () => {
    const active = await staleRun('active');
    const done = await staleRun('completed');
    const failed = await staleRun('failed', 'Payout p9 was already paid.');
    const stalled = await staleRun('failed', 'job stalled more than allowable limit');
    const gone = await staleRun('waiting');
    featureQueue.jobs.delete(gone.jobId);

    await recovery.sweep();

    expect(store.rows.get(active.backgroundJobId!)!.status).toBe('RUNNING');
    expect(store.rows.get(done.backgroundJobId!)!.status).toBe('SUCCEEDED');
    expect(store.rows.get(failed.backgroundJobId!)!).toMatchObject({ status: 'FAILED', error: 'Payout p9 was already paid.' });
    expect(store.rows.get(stalled.backgroundJobId!)!).toMatchObject({ status: 'FAILED', error: INTERRUPTED_MESSAGE });
    expect(store.rows.get(gone.backgroundJobId!)!).toMatchObject({ status: 'FAILED', error: INTERRUPTED_MESSAGE });
    expect(trackedQueue.add).not.toHaveBeenCalled();
  });

  it('a queue this process cannot find is "cannot ask", never "gone"', async () => {
    const out = await staleRun('active');
    store.rows.get(out.backgroundJobId!)!.runnerQueue = 'some-other-queue';
    store.age(out.backgroundJobId!, 10 * 60_000);
    await recovery.sweep();
    expect(store.rows.get(out.backgroundJobId!)!.status).toBe('RUNNING');
  });
});

/**
 * Two tracked runs on one queue never overlap, and the recovery sweep never fails a run whose
 * handler still holds its lock — even when Bull says the job failed (a Bull timeout, a stalled
 * lock). Postgres advisory locks, played by a shared in-memory lock table.
 */
describe('tracked runs are serialised per queue, and a live run is never declared dead', () => {
  const pg = () => {
    const held = new Map<string, number>();
    let session = 0;
    return {
      held,
      createQueryRunner: () => {
        const me = ++session;
        return {
          connect: async () => undefined,
          release: async () => undefined,
          query: async (sql: string, [key]: [string]) => {
            if (sql.includes('pg_try_advisory_lock')) {
              const owner = held.get(key);
              if (owner && owner !== me) return [{ ok: false }];
              held.set(key, me);
              return [{ ok: true }];
            }
            if (held.get(key) === me) held.delete(key);
            return [{}];
          },
        };
      },
    };
  };

  it('a second run on the same queue waits for the first to finish', async () => {
    const db = pg();
    const locked = new BackgroundJobTracker(store as any, service, storage as any, db as any);
    locked.lockPollMs = 5;
    const a = await service.enqueueTracked(trackedRequest(envelope('a')));
    const b = await service.enqueueTracked(trackedRequest(envelope('b')));

    const order: string[] = [];
    let finishA!: () => void;
    const runA = locked.run(featureQueue.jobs.get(a.jobId)! as any, async () => {
      order.push('A start');
      await new Promise<void>((r) => { finishA = r; });
      order.push('A end');
      return 'a';
    }, { describe: () => ({ summary: 'a' }) });
    await new Promise((r) => setTimeout(r, 10));
    const runB = locked.run(featureQueue.jobs.get(b.jobId)! as any, async () => { order.push('B start'); return 'b'; },
      { describe: () => ({ summary: 'b' }) });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['A start']);
    expect(store.rows.get(b.backgroundJobId!)!.progress.stage).toBe('Waiting for the previous run to finish');

    finishA();
    await Promise.all([runA, runB]);
    expect(order).toEqual(['A start', 'A end', 'B start']);
    expect(db.held.size).toBe(0);
  });

  it('the sweep leaves a Bull-"failed" row alone while its handler holds the run lock', async () => {
    const db = pg();
    const probing = new BackgroundJobRecovery(store as any, registry, service, trackedQueue as any, db as any);
    const out = await service.enqueueTracked(trackedRequest(envelope(randomUUID())));
    await store.claim(out.backgroundJobId!);
    featureQueue.jobs.get(out.jobId)!.state = 'failed'; // e.g. a Bull timeout: failed, handler still writing
    store.age(out.backgroundJobId!, 10 * 60_000);
    db.held.set(trackedJobLockKey(out.backgroundJobId!), 999); // the live handler's session

    await probing.sweep();
    expect(store.rows.get(out.backgroundJobId!)!.status).toBe('RUNNING');

    db.held.clear(); // the handler is gone
    await probing.sweep();
    expect(store.rows.get(out.backgroundJobId!)!.status).toBe('FAILED');
  });
});
