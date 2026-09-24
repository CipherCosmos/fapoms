import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import * as xlsx from 'xlsx';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import type { BackgroundJobStatus } from '@fapoms/shared';
import { BackgroundJobEntity } from '../../infrastructure/background-jobs/background-job.entity';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import { ExclusiveSlotBusyError, OPEN_STATUSES } from '../../infrastructure/background-jobs/background-job.store';
import { BackgroundJobsService, type JobReader } from '../../infrastructure/background-jobs/background-jobs.service';
import { BackgroundJobRunner } from '../../infrastructure/background-jobs/background-job.runner';
import { RosterImportJob, isRehearsal } from './roster-import.job';
import { RosterImportService, type RosterImportSummary } from './roster-import.service';

/**
 * THE ROSTER IMPORT AS A BACKGROUND JOB (`ROSTER_IMPORT`).
 *
 * Driven through the real foundation (`BackgroundJobsService` + `BackgroundJobRunner`) over
 * in-memory fakes of its store, queue and object storage, so what is pinned is what a person sees:
 * the upload is accepted before any row is read; the wrong file is refused before anything is
 * stored; a rehearsal ends waiting for review with the summary the page renders; committing it runs
 * the REAL import over the same stored file; and only the route's roles may do either.
 */

class FakeStore {
  rows = new Map<string, BackgroundJobEntity>();
  private clone(r: BackgroundJobEntity | undefined | null) {
    return r ? ({ ...r, progress: { ...r.progress } } as BackgroundJobEntity) : null;
  }
  async findById(id: string) { return this.clone(this.rows.get(id)); }
  async findOpenByDedupe(key: string) {
    return this.clone([...this.rows.values()].find((r) => r.dedupeKey === key && OPEN_STATUSES.includes(r.status)));
  }
  insert = jest.fn(async (values: Partial<BackgroundJobEntity>) => {
    const clash = values.dedupeKey ? await this.findOpenByDedupe(values.dedupeKey) : null;
    if (clash) return { job: clash, inserted: false };
    const now = new Date();
    const row = {
      id: randomUUID(), attempts: 0, bullJobId: null, cancelRequestedAt: null, cancelRequestedBy: null,
      result: null, resultObjectKey: null, resultFileName: null, resultMimeType: null, error: null,
      exclusiveKey: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now,
      inputObjects: null, runnerQueue: null,
      ...values,
    } as BackgroundJobEntity;
    this.rows.set(row.id, row);
    return { job: this.clone(row)!, inserted: true };
  });
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
  progressWrites: any[] = [];
  async writeProgress(id: string, progress: any) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'RUNNING') return false;
    this.progressWrites.push(progress);
    this.touch(id, { progress });
    return true;
  }
  async patch(id: string, patch: Partial<BackgroundJobEntity>) { this.touch(id, patch); }
  async cancelRequestedAt(id: string) { return this.rows.get(id)?.cancelRequestedAt ?? null; }
  private touch(id: string, patch: Partial<BackgroundJobEntity>) {
    const row = this.rows.get(id);
    if (row) Object.assign(row, patch, { updatedAt: new Date() });
  }
}

class FakeQueue {
  jobs = new Map<string, { id: string; name: string; data: any; opts: any; state: string; remove: jest.Mock; getState: () => Promise<string> }>();
  add = jest.fn(async (name: string, data: any, opts: any) => {
    const job = {
      id: opts.jobId, name, data, opts, state: 'waiting',
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
  saveFile = jest.fn(async (name: string, content: Buffer | Readable) => {
    const buf = Buffer.isBuffer(content) ? content : await toBuffer(content);
    const key = `k/${randomUUID()}`;
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

const HR = 'aaaaaaaa-0000-4000-8000-000000000001';
const actor = (roleNames = ['OPERATIONS']) => ({ userId: HR, roleNames, displayName: 'Priya' });
const reader = (roleNames = ['OPERATIONS']): JobReader => ({ userId: HR, roleNames, regions: null, organizationId: null });
const workbook = Buffer.from('a roster workbook');
const upload = () => ({ buffer: workbook, originalName: 'roster.xlsx', mimeType: 'application/vnd.ms-excel', size: workbook.length });
const SCOPE = { type: 'ROSTER', id: null };

const SUMMARY = (dryRun: boolean): RosterImportSummary => ({
  rowsRead: 3, created: 2, updated: 1, skipped: 0, references: 4, onboardingDocuments: 5,
  backgroundChecks: 1, empanelments: 2, issues: 1, notes: ['ICICI will be created as a client.'], dryRun,
});

let store: FakeStore;
let queue: FakeQueue;
let storage: FakeStorage;
let registry: BackgroundJobRegistry;
let service: BackgroundJobsService;
let runner: BackgroundJobRunner;
let importer: { inspectSheet: jest.Mock; importAssayerSheet: jest.Mock };

beforeAll(() => Logger.overrideLogger(false));
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

beforeEach(() => {
  store = new FakeStore();
  queue = new FakeQueue();
  storage = new FakeStorage();
  registry = new BackgroundJobRegistry();
  service = new BackgroundJobsService(store as any, registry, queue as any, storage as any, { publish: jest.fn() } as any);
  runner = new BackgroundJobRunner(store as any, registry, service, storage as any);
  importer = {
    inspectSheet: jest.fn().mockReturnValue({ sheetName: 'Assayer', rowsRead: 3, headers: [] }),
    // Reports progress the way the real importer does: before the first row, between rows, after the last.
    importAssayerSheet: jest.fn(async (_file: Buffer, _actorId: string, options: any) => {
      for (let i = 0; i <= 3; i++) await options.onProgress?.(i, 3, options.dryRun ? 'Checking rows' : 'Importing rows');
      return SUMMARY(options.dryRun === true);
    }),
  };
  new RosterImportJob(registry, importer as unknown as RosterImportService).onModuleInit();
});

/** Hand the Bull job the service queued for this row to the runner, as the worker would. */
async function work(jobId: string) {
  const row = store.rows.get(jobId)!;
  const bull = queue.jobs.get(row.bullJobId!)!;
  return runner.run({ id: bull.id, data: bull.data } as any);
}

const startRehearsal = (roles?: string[]) => service.create({
  kind: 'ROSTER_IMPORT', actor: actor(roles), regions: null, scope: SCOPE,
  params: { dryRun: true, overwrite: false, sheetName: null }, file: upload(),
});

describe('ROSTER_IMPORT — accepting the upload', () => {
  it('records and queues the job at once, with the row count as its denominator, and imports nothing', async () => {
    const { job, deduplicated } = await startRehearsal();

    expect(deduplicated).toBe(false);
    expect(job).toMatchObject({ kind: 'ROSTER_IMPORT', status: 'QUEUED', scopeType: 'ROSTER', scopeId: null });
    expect(job.title).toBe('Check 3 roster row(s) from roster.xlsx');
    expect(job.progress.total).toBe(3);
    expect(storage.saveFile).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith('ROSTER_IMPORT', { backgroundJobId: job.id }, expect.anything());
    expect(importer.importAssayerSheet).not.toHaveBeenCalled();
  });

  it('refuses the wrong file with its 400 before anything is stored or recorded', async () => {
    importer.inspectSheet.mockImplementation(() => {
      throw new BadRequestException('This looks like a branch list, not the appraiser roster.');
    });

    await expect(startRehearsal()).rejects.toThrow('This looks like a branch list, not the appraiser roster.');
    expect(storage.saveFile).not.toHaveBeenCalled();
    expect(store.insert).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a role the upload route does not admit, even through the generic POST /jobs', async () => {
    await expect(startRehearsal(['HR_OPERATOR'])).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.saveFile).not.toHaveBeenCalled();
  });

  it('admits a role that implies one of the route\'s roles (DEVELOPER implies ADMIN)', async () => {
    await expect(startRehearsal(['DEVELOPER'])).resolves.toMatchObject({ deduplicated: false });
  });
});

describe('ROSTER_IMPORT — the rehearsal, then the real run', () => {
  it('rehearses, reports progress row by row, and waits for review with the summary the page renders', async () => {
    const { job } = await startRehearsal();

    await work(job.id);

    const [file, actorId, options] = importer.importAssayerSheet.mock.calls[0];
    expect(file.equals(workbook)).toBe(true);
    expect(actorId).toBe(HR);
    expect(options).toMatchObject({ dryRun: true, overwrite: false, fileName: 'roster.xlsx' });
    expect(typeof options.checkpoint).toBe('function');

    const row = store.rows.get(job.id)!;
    expect(row.status).toBe('AWAITING_REVIEW');
    expect(row.result!.summary).toMatch(/^Checked 3 row\(s\): importing would add 2 and update 1 appraisers/);
    expect(row.result!.counts).toMatchObject({ rowsRead: 3, created: 2, updated: 1, skipped: 0, issues: 1 });
    expect(row.result!.details).toMatchObject({ dryRun: true, created: 2, notes: ['ICICI will be created as a client.'] });
    // The importer's own progress reached the row (not only the foundation's start and finish).
    expect(store.progressWrites.some((p) => p.stage === 'Checking rows' && p.total === 3)).toBe(true);
  });

  it('commits the reviewed rehearsal as the REAL import over the same stored file', async () => {
    const { job: rehearsal } = await startRehearsal();
    await work(rehearsal.id);

    const { job: real } = await service.commitReviewed(reader(), actor(), rehearsal.id, { dryRun: false });
    expect(real.parentJobId).toBe(rehearsal.id);
    expect(real.title).toBe('Import 3 roster row(s) from roster.xlsx');
    expect(store.rows.get(rehearsal.id)!.status).toBe('SUCCEEDED');
    // No second upload: the child runs over the rehearsal's stored object.
    expect(storage.saveFile).toHaveBeenCalledTimes(1);
    expect(store.rows.get(real.id)!.inputObjectKey).toBe(store.rows.get(rehearsal.id)!.inputObjectKey);

    await work(real.id);

    const options = importer.importAssayerSheet.mock.calls[1][2];
    expect(options.dryRun).toBe(false);
    const row = store.rows.get(real.id)!;
    expect(row.status).toBe('SUCCEEDED');
    expect(row.result!.summary).toMatch(/^Roster imported — 2 new, 1 updated/);
  });

  /** The Jobs tray's "Go ahead" commits with no params, so the child inherits `dryRun: true`. */
  it('treats a commit as the real run even when it inherited the rehearsal\'s dryRun', async () => {
    const { job: rehearsal } = await startRehearsal();
    await work(rehearsal.id);

    const { job: real } = await service.commitReviewed(reader(), actor(), rehearsal.id);
    expect(store.rows.get(real.id)!.params).toMatchObject({ dryRun: true });

    await work(real.id);

    expect(importer.importAssayerSheet.mock.calls[1][2].dryRun).toBe(false);
    expect(store.rows.get(real.id)!.status).toBe('SUCCEEDED');
  });

  it('refuses a commit by a role the route does not admit, and leaves the rehearsal waiting', async () => {
    const { job: rehearsal } = await startRehearsal();
    await work(rehearsal.id);

    await expect(service.commitReviewed(reader(['HR_OPERATOR']), actor(['HR_OPERATOR']), rehearsal.id, { dryRun: false }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(store.rows.get(rehearsal.id)!.status).toBe('AWAITING_REVIEW');
    expect([...store.rows.values()]).toHaveLength(1);
  });

  it('may be committed through POST /jobs only by someone holding the route\'s permission', () => {
    const holder = { roles: [{ name: 'OPERATIONS', permissions: [{ resource: 'assayer', action: 'create', scope: 'organization' }] }] };
    const without = { roles: [{ name: 'OPERATIONS', permissions: [{ resource: 'assayer', action: 'read', scope: 'organization' }] }] };
    expect(() => service.assertMayStart('ROSTER_IMPORT', holder)).not.toThrow();
    expect(() => service.assertMayStart('ROSTER_IMPORT', without)).toThrow(ForbiddenException);
  });

  it('runs a real import directly (no rehearsal) to a finished job', async () => {
    const { job } = await service.create({
      kind: 'ROSTER_IMPORT', actor: actor(), regions: null, scope: SCOPE,
      params: { dryRun: false, overwrite: true, sheetName: null }, file: upload(),
    });

    await work(job.id);

    expect(importer.importAssayerSheet.mock.calls[0][2]).toMatchObject({ dryRun: false, overwrite: true });
    expect(store.rows.get(job.id)!.status).toBe('SUCCEEDED');
  });

  it('only an explicit true rehearses', () => {
    expect(isRehearsal({ parentJobId: null }, { dryRun: true })).toBe(true);
    expect(isRehearsal({ parentJobId: null }, {})).toBe(false);
    expect(isRehearsal({ parentJobId: null }, { dryRun: 'true' as any })).toBe(false);
    expect(isRehearsal({ parentJobId: 'p' }, { dryRun: true })).toBe(false);
  });
});

/**
 * The importer's side of the contract, against the real `RosterImportService` over an in-memory
 * unit of work: it reports progress as it goes, and a stop asked for between rows ends the run
 * inside its one transaction — so nothing after the commit (geocoding, lifecycle moves, the audit
 * row) happens and the transaction is rolled back by the throw.
 */
describe('RosterImportService — progress and checkpoints', () => {
  const sheet = () => {
    const rows = [1, 2, 3].map((n) => ({ 'Appraiser code': `AS90${n}`, 'Appraiser Name': `Person ${n}` }));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), 'Assayers');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };
  const uow = () => {
    let id = 1;
    const manager = {
      find: async () => [],
      createQueryBuilder: () => {
        const qb: any = { where: () => qb, andWhere: () => qb, getMany: async () => [] };
        return qb;
      },
      query: async () => [],
      findOne: async () => undefined,
      create: (_e: unknown, obj: Record<string, any>) => ({ ...obj }),
      save: async (_e: unknown, obj: any) => { if (obj && obj.id == null) obj.id = `id-${id++}`; return obj; },
      insert: async () => undefined,
    };
    return { run: jest.fn((work: (m: any, emit: any) => Promise<any>) => work(manager, () => {})) };
  };
  const build = () => {
    const geo = { enqueueBackfill: jest.fn().mockResolvedValue(undefined) };
    const service = new RosterImportService(uow() as any, geo as any, { get: jest.fn().mockResolvedValue(true) } as any);
    return { service, geo };
  };

  it('reports progress from the first row to the last', async () => {
    const { service } = build();
    const seen: Array<[number, number, string]> = [];

    await service.importAssayerSheet(sheet(), 'u-1', {
      dryRun: true,
      onProgress: (p, t, s) => { seen.push([p, t, s]); },
    });

    expect(seen[0]).toEqual([0, 3, 'Checking rows']);
    expect(seen[seen.length - 1]).toEqual([3, 3, 'Checking rows']);
    expect(seen.map(([p]) => p)).toEqual([0, 1, 2, 3]);
  });

  it('stops between rows when asked, before anything after the transaction happens', async () => {
    const { service, geo } = build();
    let calls = 0;
    const stop = new Error('Cancelled.');

    await expect(service.importAssayerSheet(sheet(), 'u-1', {
      dryRun: false,
      checkpoint: async () => { if (++calls === 2) throw stop; },
    })).rejects.toBe(stop);

    expect(geo.enqueueBackfill).not.toHaveBeenCalled();
  });
});
