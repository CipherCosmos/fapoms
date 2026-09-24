import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { BackgroundJobKind, BackgroundJobStatus } from '@fapoms/shared';
import { getRequestContext } from '../../core/context/request-context';
import { BackgroundJobEntity } from './background-job.entity';
import { BackgroundJobRegistry } from './background-job.registry';
import { ExclusiveSlotBusyError, type JobListFilter, OPEN_STATUSES } from './background-job.store';
import { BackgroundJobsService, INTERRUPTED_MESSAGE, isVisibleTo, type JobReader } from './background-jobs.service';
import { BackgroundJobRunner, CANCEL_CHECK_INTERVAL_MS, exclusiveKeyFor, messageFor } from './background-job.runner';
import { BackgroundJobRecovery, MAX_ATTEMPTS } from './background-jobs.recovery';
import {
  awaitReview,
  BackgroundJobCancelledError,
  type BackgroundJobDefinition,
  JOB_UPDATED_EVENT,
  succeed,
} from './background-jobs.contract';

/**
 * The background-job lifecycle, end to end, without Postgres or Redis.
 *
 * The store is an in-memory stand-in that keeps the two database rules that matter — one OPEN row per
 * dedupe key, one RUNNING row per exclusive key — and every conditional transition's "only from these
 * statuses". The SQL that implements those rules for real is pinned separately in
 * `background-job.store.db.spec.ts`. What is proven here is that the service, the runner and the
 * recovery sweep lean on them correctly.
 */

// A kind no production code registers — the foundation must not need a real importer to be tested.
const FAKE = 'TEST_FAKE' as BackgroundJobKind;
const OTHER = 'TEST_OTHER' as BackgroundJobKind;

class FakeStore {
  rows = new Map<string, BackgroundJobEntity>();

  private clone(r: BackgroundJobEntity | undefined | null) {
    return r ? ({ ...r, progress: { ...r.progress } } as BackgroundJobEntity) : null;
  }

  async findById(id: string) { return this.clone(this.rows.get(id)); }

  async findOpenByDedupe(key: string) {
    return this.clone([...this.rows.values()].find((r) => r.dedupeKey === key && OPEN_STATUSES.includes(r.status)));
  }

  async insert(values: Partial<BackgroundJobEntity>) {
    const clash = values.dedupeKey ? await this.findOpenByDedupe(values.dedupeKey) : null;
    if (clash) return { job: clash, inserted: false };
    const now = new Date();
    const row = {
      id: randomUUID(), attempts: 0, bullJobId: null, cancelRequestedAt: null, cancelRequestedBy: null,
      result: null, resultObjectKey: null, resultFileName: null, resultMimeType: null, error: null,
      exclusiveKey: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now,
      ...values,
    } as BackgroundJobEntity;
    this.rows.set(row.id, row);
    return { job: this.clone(row)!, inserted: true };
  }

  async setBullJobId(id: string, bullJobId: string) { this.touch(id, { bullJobId }); }

  async claim(id: string, exclusiveKey: string | null) {
    const row = this.rows.get(id);
    if (!row || !['QUEUED', 'RUNNING'].includes(row.status)) return null;
    if (exclusiveKey && [...this.rows.values()].some((r) => r.id !== id && r.status === 'RUNNING' && r.exclusiveKey === exclusiveKey)) {
      throw new ExclusiveSlotBusyError();
    }
    this.touch(id, { status: 'RUNNING', exclusiveKey, attempts: row.attempts + 1, startedAt: row.startedAt ?? new Date(), error: null });
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

  async requestCancel(id: string, by: string) {
    return this.transition(id, ['RUNNING'], { cancelRequestedAt: new Date(), cancelRequestedBy: by });
  }

  async cancelRequestedAt(id: string) { return this.rows.get(id)?.cancelRequestedAt ?? null; }

  async list(f: JobListFilter) {
    return [...this.rows.values()]
      .filter((r) => f.statuses.includes(r.status))
      .filter((r) => !f.requestedBy || r.requestedBy === f.requestedBy)
      .filter((r) => f.withinRegions === undefined || f.withinRegions === null
        || (!!r.regions && r.regions.every((g) => f.withinRegions!.includes(g))))
      .filter((r) => !f.kind || r.kind === f.kind)
      .filter((r) => !f.scopeType || r.scopeType === f.scopeType)
      .filter((r) => !f.scopeId || r.scopeId === f.scopeId)
      .filter((r) => !f.finishedAfter || (!!r.finishedAt && r.finishedAt > f.finishedAfter))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, f.limit)
      .map((r) => this.clone(r)!);
  }

  async findStaleOpen(idleMs: number) {
    return [...this.rows.values()]
      .filter((r) => ['QUEUED', 'RUNNING'].includes(r.status) && r.updatedAt.getTime() < Date.now() - idleMs)
      .map((r) => this.clone(r)!);
  }

  /** Test helper: age a row so the recovery sweep considers it. */
  age(id: string, ms: number) {
    const row = this.rows.get(id)!;
    row.updatedAt = new Date(Date.now() - ms);
  }

  private touch(id: string, patch: Partial<BackgroundJobEntity>) {
    const row = this.rows.get(id);
    if (!row) return;
    Object.assign(row, patch, { updatedAt: new Date() });
  }
}

class FakeQueue {
  jobs = new Map<string, { id: string; name: string; data: any; opts: any; state: string; remove: jest.Mock; getState: () => Promise<string> }>();
  add = jest.fn(async (name: string, data: any, opts: any) => {
    const job = {
      id: opts.jobId, name, data, opts, state: opts.delay ? 'delayed' : 'waiting',
      remove: jest.fn(async () => { this.jobs.delete(opts.jobId); }),
      getState: async () => job.state,
    };
    this.jobs.set(opts.jobId, job);
    return job;
  });
  getJob = jest.fn(async (id: string) => this.jobs.get(id) ?? null);
}

class FakeStorage {
  objects = new Map<string, Buffer>();
  saved: string[] = [];
  saveFile = jest.fn(async (name: string, content: Buffer | Readable) => {
    const buf = Buffer.isBuffer(content) ? content : await streamToBuffer(content);
    const key = `k/${randomUUID()}/${name.length}`;
    this.objects.set(key, buf);
    this.saved.push(key);
    return key;
  });
  getFileStream = jest.fn(async (key: string) => Readable.from(this.objects.get(key) ?? Buffer.alloc(0)));
  deleteFile = jest.fn(async (key: string) => { this.objects.delete(key); });
}

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const ADMIN = 'cccccccc-0000-4000-8000-000000000003';

const actor = (userId = ALICE, roleNames = ['OPERATIONS']) => ({ userId, roleNames, displayName: userId.slice(0, 5) });
const reader = (userId = ALICE, roleNames = ['OPERATIONS'], regions: string[] | null = null): JobReader =>
  ({ userId, roleNames, regions, organizationId: null });
const file = (text = 'sol_id,name\n1,Main\n', name = 'branches.csv') =>
  ({ buffer: Buffer.from(text), originalName: name, mimeType: 'text/csv', size: Buffer.byteLength(text) });

let store: FakeStore;
let queue: FakeQueue;
let storage: FakeStorage;
let events: { publish: jest.Mock };
let registry: BackgroundJobRegistry;
let service: BackgroundJobsService;
let runner: BackgroundJobRunner;
let recovery: BackgroundJobRecovery;

function define(overrides: Partial<BackgroundJobDefinition<any>> = {}): BackgroundJobDefinition<any> {
  return {
    kind: FAKE,
    input: 'required',
    idempotent: false,
    exclusive: 'none',
    start: { permissions: ['branch:create:organization'] },
    run: async () => succeed({ summary: 'did it' }),
    ...overrides,
  };
}

beforeAll(() => Logger.overrideLogger(false));
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

beforeEach(() => {
  store = new FakeStore();
  queue = new FakeQueue();
  storage = new FakeStorage();
  events = { publish: jest.fn() };
  registry = new BackgroundJobRegistry();
  service = new BackgroundJobsService(store as any, registry, queue as any, storage as any, events as any);
  runner = new BackgroundJobRunner(store as any, registry, service, storage as any);
  recovery = new BackgroundJobRecovery(store as any, registry, service, queue as any);
});

/** Hand the Bull job the service queued for this row to the runner, as the worker would. */
async function work(jobId: string) {
  const row = store.rows.get(jobId)!;
  const bull = queue.jobs.get(row.bullJobId!)!;
  return runner.run({ id: bull.id, data: bull.data } as any);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('an interrupted non-idempotent kind', () => {
  it("is failed with the kind's own sentence when it has one — by the runner and by the sweep", async () => {
    const sentence = 'Interrupted — check the versions list before uploading again.';
    registry.register(define({ interruptedMessage: sentence }));
    const a = (await service.create({ kind: FAKE, actor: actor(), regions: null, file: file('a') })).job;
    const b = (await service.create({ kind: FAKE, actor: actor(), regions: null, file: file('b') })).job;
    await store.claim(a.id, null);
    await store.claim(b.id, null);

    // A redelivered (stalled) Bull job finds its row RUNNING.
    await work(a.id);
    expect(store.rows.get(a.id)!).toMatchObject({ status: 'FAILED', error: sentence });

    // A row Bull lost altogether is found by the sweep.
    queue.jobs.clear();
    store.age(b.id, 10 * 60_000);
    await recovery.sweep();
    expect(store.rows.get(b.id)!).toMatchObject({ status: 'FAILED', error: sentence });
  });
});

describe('starting a job', () => {
  it('stores the file BEFORE the row, queues only the row id, and answers with a QUEUED job', async () => {
    registry.register(define());
    const order: string[] = [];
    storage.saveFile.mockImplementationOnce(async (name: string, content: any) => {
      order.push(`store:${store.rows.size}`);
      const key = `k/${name}`;
      storage.objects.set(key, Buffer.isBuffer(content) ? content : await streamToBuffer(content));
      return key;
    });

    const { job, deduplicated } = await service.create({
      kind: FAKE, actor: actor(), regions: ['NORTH'], scope: { type: 'CLIENT', id: 'c-1' }, file: file(),
    });

    expect(order).toEqual(['store:0']); // no row existed when the file was stored
    expect(deduplicated).toBe(false);
    expect(job.status).toBe('QUEUED');
    expect(job.inputFileName).toBe('branches.csv');
    const row = store.rows.get(job.id)!;
    expect(row.inputObjectKey).toBe('k/branches.csv');
    expect(row.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.regions).toEqual(['NORTH']);

    // The Bull job carries the row id and NOTHING else — never bytes, never params.
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe(FAKE);
    expect(data).toEqual({ backgroundJobId: job.id });
    expect(opts.jobId).toBe(job.id);
    expect(row.bullJobId).toBe(job.id);
  });

  it('streams a disk-backed upload into storage rather than reading it into memory', async () => {
    registry.register(define());
    const path = join(tmpdir(), `bgjob-${randomUUID()}.csv`);
    await fsp.writeFile(path, 'a,b\n1,2\n');
    try {
      await service.create({ kind: FAKE, actor: actor(), regions: null, file: { path, originalName: 'x.csv', size: 8 } });
      const content = storage.saveFile.mock.calls[0][1];
      expect(Buffer.isBuffer(content)).toBe(false);
      expect(content).toBeInstanceOf(Readable);
    } finally {
      await fsp.rm(path, { force: true });
    }
  });

  it('publishes job:updated addressed to the requester', async () => {
    registry.register(define());
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    expect(events.publish).toHaveBeenCalledWith(
      JOB_UPDATED_EVENT,
      expect.objectContaining({ requestedBy: ALICE, job: expect.objectContaining({ id: job.id, status: 'QUEUED' }) }),
    );
  });

  it('refuses a kind with no handler, and a required file that is missing', async () => {
    await expect(service.create({ kind: FAKE, actor: actor(), regions: null, file: file() }))
      .rejects.toBeInstanceOf(BadRequestException);
    registry.register(define());
    await expect(service.create({ kind: FAKE, actor: actor(), regions: null }))
      .rejects.toThrow(/No file was uploaded/);
    expect(storage.saveFile).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("uses prepare's title and total, and a refusal from prepare stores nothing", async () => {
    registry.register(define({
      prepare: async ({ params }) => {
        if (params.bad) throw new BadRequestException('That sheet is the assayer roster, not branches.');
        return { title: '5,000 branches for SBI', total: 5000, stage: 'Waiting for a worker' };
      },
    }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    expect(job.title).toBe('5,000 branches for SBI');
    expect(job.progress).toEqual(expect.objectContaining({ processed: 0, total: 5000, percent: 0, stage: 'Waiting for a worker' }));

    storage.saveFile.mockClear();
    await expect(service.create({ kind: FAKE, actor: actor(), regions: null, file: file('other'), params: { bad: true } }))
      .rejects.toThrow(/assayer roster/);
    expect(storage.saveFile).not.toHaveBeenCalled();
  });

  it('marks the row FAILED (not stuck QUEUED) when the queue refuses it', async () => {
    registry.register(define());
    queue.add.mockRejectedValueOnce(new Error('Redis down'));
    await expect(service.create({ kind: FAKE, actor: actor(), regions: null, file: file() })).rejects.toThrow(/could not be queued/);
    const [row] = [...store.rows.values()];
    expect(row.status).toBe('FAILED');
  });

  describe('the POST /jobs gate', () => {
    const userWith = (...perms: string[]) => ({
      roles: [{ name: 'CUSTOM', permissions: perms.map((p) => { const [resource, action, scope] = p.split(':'); return { resource, action, scope }; }) }],
    });

    it('admits a caller holding every permission the kind names (PLATFORM implying narrower)', () => {
      registry.register(define());
      expect(() => service.assertMayStart(FAKE, userWith('branch:create:organization'))).not.toThrow();
      expect(() => service.assertMayStart(FAKE, userWith('branch:create:platform'))).not.toThrow();
    });

    it('refuses one who does not, and a kind that did not opt in to the generic door', () => {
      registry.register(define());
      expect(() => service.assertMayStart(FAKE, userWith('branch:view:organization'))).toThrow(ForbiddenException);
      registry.register(define({ kind: OTHER, start: undefined }));
      expect(() => service.assertMayStart(OTHER, userWith('branch:create:organization'))).toThrow(BadRequestException);
    });
  });
});

describe('dedupe', () => {
  beforeEach(() => registry.register(define()));

  it('the same person re-uploading the same file for the same scope gets the SAME job back', async () => {
    const first = await service.create({ kind: FAKE, actor: actor(), regions: null, scope: { type: 'CLIENT', id: 'c-1' }, file: file() });
    const again = await service.create({ kind: FAKE, actor: actor(), regions: null, scope: { type: 'CLIENT', id: 'c-1' }, file: file() });
    expect(again.deduplicated).toBe(true);
    expect(again.job.id).toBe(first.job.id);
    expect(store.rows.size).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    // The fast path answers before the duplicate's bytes are stored at all.
    expect(storage.saveFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a different file', { file: file('different bytes') }],
    ['a different scope', { scope: { type: 'CLIENT', id: 'c-2' } }],
    ['different parameters', { params: { overwrite: true } }],
    ['a different person', { actor: actor(BOB) }],
  ])('%s is a new job', async (_label, change) => {
    const base = { kind: FAKE, actor: actor(), regions: null, scope: { type: 'CLIENT', id: 'c-1' }, file: file() };
    const first = await service.create(base);
    const second = await service.create({ ...base, ...(change as object) });
    expect(second.deduplicated).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it('a finished job is never joined — re-uploading after it settled starts fresh', async () => {
    const first = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    await work(first.job.id);
    expect(store.rows.get(first.job.id)!.status).toBe('SUCCEEDED');
    const again = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    expect(again.deduplicated).toBe(false);
  });

  it('losing an insert race discards the loser\'s stored file and returns the winner', async () => {
    const first = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    // Simulate the race: the fast-path check misses, the insert then collides.
    const findOpen = jest.spyOn(store, 'findOpenByDedupe').mockResolvedValueOnce(null);
    const again = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    findOpen.mockRestore();
    expect(again).toEqual(expect.objectContaining({ deduplicated: true }));
    expect(again.job.id).toBe(first.job.id);
    const loserKey = storage.saved[1];
    expect(storage.deleteFile).toHaveBeenCalledWith(loserKey);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('visibility', () => {
  const row = (requestedBy: string, regions: string[] | null) => ({ requestedBy, regions, organizationId: null });

  it('the requester sees their own job; another non-admin does not', () => {
    expect(isVisibleTo(reader(ALICE), row(ALICE, null))).toBe(true);
    expect(isVisibleTo(reader(BOB), row(ALICE, null))).toBe(false);
  });

  it('an unrestricted administrator sees everybody\'s; DEVELOPER counts as one', () => {
    expect(isVisibleTo(reader(ADMIN, ['ADMIN']), row(ALICE, ['NORTH']))).toBe(true);
    expect(isVisibleTo(reader(ADMIN, ['DEVELOPER']), row(ALICE, null))).toBe(true);
  });

  it('a regional administrator sees only jobs wholly inside their regions — never national work', () => {
    const north = reader(ADMIN, ['ADMIN'], ['NORTH']);
    expect(isVisibleTo(north, row(ALICE, ['NORTH']))).toBe(true);
    expect(isVisibleTo(north, row(ALICE, ['NORTH', 'SOUTH']))).toBe(false);
    expect(isVisibleTo(north, row(ALICE, null))).toBe(false);
  });

  it('another organisation\'s job is invisible even to an administrator', () => {
    expect(isVisibleTo({ ...reader(ADMIN, ['ADMIN']), organizationId: 'org-a' }, { ...row(ALICE, null), organizationId: 'org-b' })).toBe(false);
  });

  it('GET /jobs/:id answers 404 — not 403 — for a job that is not yours', async () => {
    registry.register(define());
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    await expect(service.get(reader(BOB), job.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(reader(BOB), 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(reader(ALICE), job.id)).resolves.toEqual(expect.objectContaining({ id: job.id }));
  });

  it('the list is mine by default; all=true is refused to a non-administrator and region-bounded for one', async () => {
    registry.register(define());
    await service.create({ kind: FAKE, actor: actor(ALICE), regions: ['NORTH'], file: file('a') });
    await service.create({ kind: FAKE, actor: actor(BOB), regions: ['SOUTH'], file: file('b') });

    const mine = await service.list(reader(ALICE), { include: ['active', 'recent'], limit: 10 });
    expect(mine.active.map((j) => j.requestedBy)).toEqual([ALICE]);

    await expect(service.list(reader(ALICE), { include: ['active'], all: true, limit: 10 })).rejects.toBeInstanceOf(ForbiddenException);

    const northAdmin = await service.list(reader(ADMIN, ['ADMIN'], ['NORTH']), { include: ['active'], all: true, limit: 10 });
    expect(northAdmin.active.map((j) => j.requestedBy)).toEqual([ALICE]);
    const nationalAdmin = await service.list(reader(ADMIN, ['ADMIN'], null), { include: ['active'], all: true, limit: 10 });
    expect(nationalAdmin.active).toHaveLength(2);
  });

  it('active and recent are separate lists, and a page can ask for its own kind + scope', async () => {
    registry.register(define());
    const done = await service.create({ kind: FAKE, actor: actor(), regions: null, scope: { type: 'CLIENT', id: 'c-1' }, file: file('1') });
    await work(done.job.id);
    const open = await service.create({ kind: FAKE, actor: actor(), regions: null, scope: { type: 'CLIENT', id: 'c-2' }, file: file('2') });

    const all = await service.list(reader(), { include: ['active', 'recent'], limit: 10 });
    expect(all.active.map((j) => j.id)).toEqual([open.job.id]);
    expect(all.recent.map((j) => j.id)).toEqual([done.job.id]);

    const c1 = await service.list(reader(), { include: ['active', 'recent'], kind: FAKE, scopeType: 'CLIENT', scopeId: 'c-1', limit: 10 });
    expect([...c1.active, ...c1.recent].map((j) => j.id)).toEqual([done.job.id]);
  });
});

describe('running a job', () => {
  it('runs inside the requester\'s context and finishes SUCCEEDED with 100%', async () => {
    let seen: string | undefined;
    registry.register(define({
      run: async (ctx) => {
        seen = getRequestContext()?.userId;
        await ctx.progress(1, 2, 'Importing');
        await ctx.progress(2, 2, 'Importing');
        return succeed({ summary: '2 imported', counts: { created: 2 } });
      },
    }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    expect(await work(job.id)).toBe('SUCCEEDED');

    const row = store.rows.get(job.id)!;
    expect(seen).toBe(ALICE);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.result).toEqual({ summary: '2 imported', counts: { created: 2 } });
    expect(row.progress).toEqual(expect.objectContaining({ processed: 2, total: 2, percent: 100, stage: 'Done' }));
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.attempts).toBe(1);
  });

  it('hands the handler its uploaded file back from storage', async () => {
    let text = '';
    registry.register(define({ run: async (ctx) => { text = (await ctx.readInput()).toString(); return succeed({ summary: 'ok' }); } }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file('hello,world') });
    await work(job.id);
    expect(text).toBe('hello,world');
  });

  it('throttles progress writes: a 5,000-row loop does not write 5,000 times', async () => {
    const writes = jest.spyOn(store, 'writeProgress');
    registry.register(define({
      run: async (ctx) => {
        for (let i = 1; i <= 5000; i++) await ctx.progress(i, 5000, 'Importing');
        return succeed({ summary: 'ok' });
      },
    }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    await work(job.id);
    // The first write (nothing written yet) and the last unit; the loop is far faster than 1 s.
    expect(writes.mock.calls.length).toBeLessThanOrEqual(3);
    expect(writes.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a stage change is written at once, whatever the throttle says', async () => {
    const writes = jest.spyOn(store, 'writeProgress');
    registry.register(define({
      run: async (ctx) => {
        await ctx.progress(1, 10, 'Reading');
        await ctx.progress(2, 10, 'Reading');
        await ctx.progress(3, 10, 'Geocoding');
        return succeed({ summary: 'ok' });
      },
    }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    await work(job.id);
    expect(writes.mock.calls.map((c) => (c[1] as any).stage)).toEqual(['Reading', 'Geocoding']);
  });

  it('a rehearsal ends AWAITING_REVIEW, and committing it starts a child over the SAME file', async () => {
    registry.register(define({
      run: async (ctx) => (ctx.params.dryRun ? awaitReview({ summary: 'would create 3' }) : succeed({ summary: 'created 3' })),
    }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file(), params: { dryRun: true } });
    expect(await work(job.id)).toBe('AWAITING_REVIEW');
    const rehearsal = store.rows.get(job.id)!;
    expect(rehearsal.finishedAt).toBeInstanceOf(Date);

    const commit = await service.commitReviewed(reader(), actor(), job.id, { dryRun: false });
    const child = store.rows.get(commit.job.id)!;
    expect(child.parentJobId).toBe(job.id);
    expect(child.inputObjectKey).toBe(rehearsal.inputObjectKey);
    expect(storage.saveFile).toHaveBeenCalledTimes(1); // the file was not stored twice
    expect(store.rows.get(job.id)!.status).toBe('SUCCEEDED');
    expect(await work(child.id)).toBe('SUCCEEDED');

    await expect(service.commitReviewed(reader(), actor(), job.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('a thrown error FAILS the job with the message a person can read', async () => {
    registry.register(define({ run: async () => { throw new BadRequestException('Row 12 has no SOL ID.'); } }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    expect(await work(job.id)).toBe('FAILED');
    expect(store.rows.get(job.id)!.error).toBe('Row 12 has no SOL ID.');
  });

  it('never shows a database error\'s SQL to the person', () => {
    const { QueryFailedError } = jest.requireActual('typeorm');
    const err = new QueryFailedError('INSERT INTO branches ...', [], new Error('duplicate key value violates "uq_x"'));
    expect(messageFor(err)).not.toMatch(/INSERT|uq_x/);
  });

  it('a report attached by the handler is downloadable from the job', async () => {
    registry.register(define({
      run: async (ctx) => {
        await ctx.attachReport('skipped.csv', Buffer.from('row,reason\n3,no sol id\n'), 'text/csv');
        return succeed({ summary: '1 skipped' });
      },
    }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    await work(job.id);
    const summary = await service.get(reader(), job.id);
    expect(summary.hasResultFile).toBe(true);
    const download = await service.openResult(reader(), job.id);
    expect(download.fileName).toBe('skipped.csv');
    expect((await streamToBuffer(download.stream)).toString()).toContain('no sol id');
    await expect(service.openResult(reader(BOB), job.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a result too large to travel keeps its sentence and moves its details into a file', async () => {
    registry.register(define({
      run: async () => succeed({ summary: 'big', counts: { rows: 1 }, details: 'x'.repeat(200_000) }),
    }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    await work(job.id);
    const row = store.rows.get(job.id)!;
    expect(row.result).toEqual({ summary: 'big', counts: { rows: 1 } });
    expect(row.resultFileName).toBe('details.json');
  });

  describe('one at a time', () => {
    it('a kind declared exclusive per scope waits (visibly) while another for the same scope runs', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      registry.register(define({ exclusive: 'scope', run: async () => { await gate; return succeed({ summary: 'ok' }); } }));

      const a = await service.create({ kind: FAKE, actor: actor(), regions: null, scope: { type: 'CLIENT', id: 'c-1' }, file: file('a') });
      const b = await service.create({ kind: FAKE, actor: actor(), regions: null, scope: { type: 'CLIENT', id: 'c-1' }, file: file('b') });
      const c = await service.create({ kind: FAKE, actor: actor(), regions: null, scope: { type: 'CLIENT', id: 'c-2' }, file: file('c') });

      const runningA = work(a.job.id);
      await new Promise((r) => setImmediate(r));
      expect(await work(b.job.id)).toBe('deferred');
      const bRow = store.rows.get(b.job.id)!;
      expect(bRow.status).toBe('QUEUED');
      expect(bRow.progress.stage).toMatch(/Waiting for another/);
      expect(bRow.bullJobId).not.toBe(b.job.id); // re-queued under a fresh Bull id, with a delay
      expect(queue.jobs.get(bRow.bullJobId!)!.opts.delay).toBeGreaterThan(0);

      const runningC = work(c.job.id); // a different client is not held up
      await new Promise((r) => setImmediate(r));
      expect(store.rows.get(c.job.id)!.status).toBe('RUNNING');

      release();
      await Promise.all([runningA, runningC]);
      expect(await work(b.job.id)).toBe('SUCCEEDED');
    });

    it('computes the exclusive key per kind, per scope, or not at all', () => {
      const row = { kind: FAKE, scopeType: 'CLIENT', scopeId: 'c-1' };
      expect(exclusiveKeyFor({ exclusive: 'none' }, row)).toBeNull();
      expect(exclusiveKeyFor({ exclusive: 'kind' }, row)).toBe(FAKE);
      expect(exclusiveKeyFor({ exclusive: 'scope' }, row)).toBe(`${FAKE}|CLIENT|c-1`);
    });
  });

  it('an old Bull copy of a re-queued row does not run it a second time', async () => {
    registry.register(define());
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    await store.setBullJobId(job.id, `${job.id}:newer`);
    expect(await runner.run({ id: job.id, data: { backgroundJobId: job.id } } as any)).toBe('skipped');
    expect(store.rows.get(job.id)!.status).toBe('QUEUED');
  });
});

describe('cancelling', () => {
  it('a waiting job is cancelled at once, its Bull job removed, and a later pickup does nothing', async () => {
    const run = jest.fn(async () => succeed({ summary: 'ran' }));
    registry.register(define({ run }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    const bull = queue.jobs.get(job.id)!;

    const cancelled = await service.cancel(reader(), job.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(bull.remove).toHaveBeenCalled();
    expect(await runner.run({ id: job.id, data: { backgroundJobId: job.id } } as any)).toBe('skipped');
    expect(run).not.toHaveBeenCalled();
  });

  it('a running job is flagged, stops at its next checkpoint, and keeps what it managed', async () => {
    let flagged!: () => void;
    const reached = new Promise<void>((r) => { flagged = r; });
    registry.register(define({
      run: async (ctx) => {
        await ctx.progress(10, 100, 'Importing');
        flagged();
        // Give the cancel request time to land, then pass a checkpoint after the re-read interval.
        await new Promise((r) => setTimeout(r, 20));
        jest.spyOn(Date, 'now').mockReturnValue(Date.now() + CANCEL_CHECK_INTERVAL_MS + 1);
        try {
          await ctx.throwIfCancelled();
        } catch (err) {
          if (err instanceof BackgroundJobCancelledError) throw new BackgroundJobCancelledError({ summary: '10 of 100 imported before it was stopped' });
          throw err;
        }
        return succeed({ summary: 'should not get here' });
      },
    }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    const running = work(job.id);
    await reached;
    const asked = await service.cancel(reader(), job.id);
    expect(asked.status).toBe('RUNNING');
    expect(asked.cancelRequested).toBe(true);

    expect(await running).toBe('CANCELLED');
    (Date.now as jest.Mock).mockRestore?.();
    jest.restoreAllMocks();
    const row = store.rows.get(job.id)!;
    expect(row.status).toBe('CANCELLED');
    expect(row.result?.summary).toMatch(/10 of 100/);
    expect(row.cancelRequestedBy).toBe(ALICE);
  });

  it('a rehearsal awaiting review is discarded by cancel', async () => {
    registry.register(define({ run: async () => awaitReview({ summary: 'would do 3' }) }));
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    await work(job.id);
    expect((await service.cancel(reader(), job.id)).status).toBe('CANCELLED');
  });

  it('a finished job cannot be cancelled, and nobody else can cancel yours', async () => {
    registry.register(define());
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
    await expect(service.cancel(reader(BOB), job.id)).rejects.toBeInstanceOf(NotFoundException);
    await work(job.id);
    await expect(service.cancel(reader(), job.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('a regional administrator may cancel a job inside their region', async () => {
    registry.register(define());
    const { job } = await service.create({ kind: FAKE, actor: actor(), regions: ['NORTH'], file: file() });
    expect((await service.cancel(reader(ADMIN, ['ADMIN'], ['NORTH']), job.id)).status).toBe('CANCELLED');
  });
});

describe('after a worker dies', () => {
  describe('Bull redelivers a stalled job (the row still says RUNNING)', () => {
    it('a non-idempotent kind is FAILED "interrupted — please retry", not run twice', async () => {
      const run = jest.fn(async () => succeed({ summary: 'ran' }));
      registry.register(define({ idempotent: false, run }));
      const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
      await store.claim(job.id, null); // the first worker got this far, then died

      expect(await work(job.id)).toBe('interrupted');
      expect(run).not.toHaveBeenCalled();
      expect(store.rows.get(job.id)!.status).toBe('FAILED');
      expect(store.rows.get(job.id)!.error).toBe(INTERRUPTED_MESSAGE);
    });

    it('an idempotent kind runs again from the top, and says so', async () => {
      const stages: string[] = [];
      registry.register(define({ idempotent: true, run: async (ctx) => { stages.push(ctx.job.progress.stage); return succeed({ summary: 'ok' }); } }));
      const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
      await store.claim(job.id, null);

      expect(await work(job.id)).toBe('SUCCEEDED');
      expect(store.rows.get(job.id)!.attempts).toBe(2);
      expect(stages).toEqual(['Restarting after an interruption']);
    });
  });

  describe('the recovery sweep (Bull has lost the job)', () => {
    const lose = (id: string) => { const row = store.rows.get(id)!; queue.jobs.delete(row.bullJobId!); store.age(id, 10 * 60_000); };

    it('a job that never started is simply queued again', async () => {
      registry.register(define());
      const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
      lose(job.id);
      expect(await recovery.sweep()).toEqual(['requeued']);
      const row = store.rows.get(job.id)!;
      expect(row.status).toBe('QUEUED');
      expect(queue.jobs.get(row.bullJobId!)).toBeDefined();
      expect(await work(job.id)).toBe('SUCCEEDED');
    });

    it('a RUNNING non-idempotent job is FAILED as interrupted', async () => {
      registry.register(define({ idempotent: false }));
      const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
      await store.claim(job.id, null);
      lose(job.id);
      expect(await recovery.sweep()).toEqual(['interrupted']);
      expect(store.rows.get(job.id)!).toEqual(expect.objectContaining({ status: 'FAILED', error: INTERRUPTED_MESSAGE }));
      expect(events.publish).toHaveBeenLastCalledWith(JOB_UPDATED_EVENT, expect.objectContaining({ job: expect.objectContaining({ status: 'FAILED' }) }));
    });

    it('a RUNNING idempotent job is re-queued — until it has used its attempts', async () => {
      registry.register(define({ idempotent: true }));
      const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
      await store.claim(job.id, null);
      lose(job.id);
      expect(await recovery.sweep()).toEqual(['requeued']);

      store.rows.get(job.id)!.attempts = MAX_ATTEMPTS;
      lose(job.id);
      expect(await recovery.sweep()).toEqual(['interrupted']);
    });

    it('leaves alone a job Bull still has, and one touched recently', async () => {
      registry.register(define());
      const { job } = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file() });
      store.age(job.id, 10 * 60_000);
      expect(await recovery.sweep()).toEqual(['left']); // Bull says waiting
      const fresh = await service.create({ kind: FAKE, actor: actor(), regions: null, file: file('new') });
      queue.jobs.delete(fresh.job.id);
      expect((await recovery.sweep()).length).toBe(1); // the fresh row is not stale yet
    });
  });
});

describe('the registry', () => {
  it('refuses to register a kind twice', () => {
    registry.register(define());
    expect(() => registry.register(define())).toThrow(/registered twice/);
  });
});
