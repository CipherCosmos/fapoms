/**
 * Guards "one import of each kind at a time", which the three import workers claimed for months
 * while it was false.
 *
 * All three import kinds shared the `import-jobs` queue, each in its own `@Processor` class at
 * `concurrency: 1`. Bull has no per-name slots: every `@Process({ name, concurrency })` adds that
 * many loops to the QUEUE, and each loop pops the next waiting job of any name. So the three
 * handlers were three shared loops, and two roster imports (writing the same people) or two
 * customer-master uploads (each registering "the next" version number) could run side by side.
 * Nothing about the code looked wrong; the comments on every worker said it could not happen.
 *
 * The fix is a queue per kind with one handler. What can quietly undo it, and what each test here
 * catches:
 *  - a worker pointed back at a shared queue, or a fourth import kind added onto an existing one;
 *  - a second handler (or a higher concurrency) on an import worker, which adds a loop;
 *  - the producer or a status endpoint reading another kind's queue — Bull job ids are a per-queue
 *    counter, so that answers "not found" for a job that exists, or finds the wrong job;
 *  - the customer-master queue losing `maxStalledCount: 0`, so a dead worker's reconciliation is
 *    re-run and registers the same file twice.
 *
 * The module under test is the real `ImportModule` with only the Redis-backed queues swapped for
 * mocks, so the registrations the app boots with are the ones checked.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken, getQueueOptionsToken } from '@nestjs/bull';
import { BULL_MODULE_QUEUE, BULL_MODULE_QUEUE_PROCESS } from '@nestjs/bull/dist/bull.constants';

import { ImportModule } from './import.module';
import { ImportJobService } from './import-job.service';
import {
  IMPORT_QUEUE,
  ROSTER_IMPORT_QUEUE,
  CUSTOMER_MASTER_IMPORT_QUEUE,
  BRANCH_IMPORT_JOB,
  ROSTER_IMPORT_JOB,
  CUSTOMER_MASTER_IMPORT_JOB,
} from './import.constants';
import { ImportJobWorker } from '../project/import-job.worker';
import { RosterImportWorker } from '../assayer/roster-import.worker';
import { CustomerMasterImportWorker } from '../customer-master/customer-master-import.worker';

const IMPORT_WORKERS = [
  { worker: ImportJobWorker, queue: IMPORT_QUEUE, job: BRANCH_IMPORT_JOB },
  { worker: RosterImportWorker, queue: ROSTER_IMPORT_QUEUE, job: ROSTER_IMPORT_JOB },
  { worker: CustomerMasterImportWorker, queue: CUSTOMER_MASTER_IMPORT_QUEUE, job: CUSTOMER_MASTER_IMPORT_JOB },
];

/** The queue a `@Processor` class is bound to, as `@nestjs/bull`'s explorer will read it. */
const queueOf = (worker: object): unknown => Reflect.getMetadata(BULL_MODULE_QUEUE, worker)?.name;

/** Every `@Process` handler on a class, with the options Bull will register it with. */
const handlersOf = (worker: { prototype: object }): Array<{ name?: string; concurrency?: number }> =>
  Object.getOwnPropertyNames(worker.prototype)
    .map((key) => Reflect.getMetadata(BULL_MODULE_QUEUE_PROCESS, (worker.prototype as any)[key]))
    .filter(Boolean);

describe('import queues: each kind runs one at a time', () => {
  it('binds the branch, roster and customer-master workers to three different, named queues', () => {
    const queues = IMPORT_WORKERS.map(({ worker }) => queueOf(worker));

    // `@Processor(undefined)` silently binds Bull's default queue, so "defined" is part of this.
    expect(queues).toEqual([IMPORT_QUEUE, ROSTER_IMPORT_QUEUE, CUSTOMER_MASTER_IMPORT_QUEUE]);
    expect(queues.every((q) => typeof q === 'string' && q.length > 0)).toBe(true);
    expect(new Set(queues).size).toBe(3);
  });

  /** A second handler, or a concurrency above one, is a second loop on that kind's queue. */
  it('gives each import worker exactly one handler, at concurrency 1, under its job name', () => {
    for (const { worker, job } of IMPORT_WORKERS) {
      expect({ worker: worker.name, handlers: handlersOf(worker) }).toEqual({
        worker: worker.name,
        handlers: [{ name: job, concurrency: 1 }],
      });
    }
  });

  /**
   * The recurrence this exists for: the next import kind gets added as another `@Processor` on an
   * import queue because the constant is right there. Read from source, because a class nobody
   * imports into this spec would otherwise be invisible to it.
   */
  it('lets no other @Processor in the tree consume an import queue', () => {
    const SRC = join(__dirname, '..', '..');
    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
        return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
      });
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const byConstant: Record<string, string> = { IMPORT_QUEUE, ROSTER_IMPORT_QUEUE, CUSTOMER_MASTER_IMPORT_QUEUE };

    const consumers: Record<string, string[]> = {
      [IMPORT_QUEUE]: [], [ROSTER_IMPORT_QUEUE]: [], [CUSTOMER_MASTER_IMPORT_QUEUE]: [],
    };
    for (const file of sourceFiles(SRC)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const m of code.matchAll(/@Processor\(\s*(?:\{\s*name:\s*)?([^,)}\s]+)/g)) {
        const literal = /^['"`]([^'"`]+)['"`]$/.exec(m[1]);
        const queue = literal ? literal[1] : byConstant[m[1]];
        if (queue && consumers[queue]) consumers[queue].push(file.slice(SRC.length + 1));
      }
    }

    expect(consumers).toEqual({
      [IMPORT_QUEUE]: ['modules/project/import-job.worker.ts'],
      [ROSTER_IMPORT_QUEUE]: ['modules/assayer/roster-import.worker.ts'],
      [CUSTOMER_MASTER_IMPORT_QUEUE]: ['modules/customer-master/customer-master-import.worker.ts'],
    });
  });
});

describe('import queues: the producer and the status endpoints use the kind\'s own queue', () => {
  let moduleRef: TestingModule;
  let service: ImportJobService;
  const queues = {
    branch: { add: jest.fn(), getJob: jest.fn() },
    roster: { add: jest.fn(), getJob: jest.fn() },
    customerMaster: { add: jest.fn(), getJob: jest.fn() },
  };
  const file = Buffer.from('xlsx');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [ImportModule] })
      .overrideProvider(getQueueToken(IMPORT_QUEUE)).useValue(queues.branch)
      .overrideProvider(getQueueToken(ROSTER_IMPORT_QUEUE)).useValue(queues.roster)
      .overrideProvider(getQueueToken(CUSTOMER_MASTER_IMPORT_QUEUE)).useValue(queues.customerMaster)
      .compile();
    service = moduleRef.get(ImportJobService);
  });

  afterAll(() => moduleRef.close());

  beforeEach(() => {
    jest.clearAllMocks();
    for (const q of Object.values(queues)) q.add.mockResolvedValue({ id: 1 });
  });

  /** Which mock queues were touched by `method` — the answer should be exactly one. */
  const touched = (method: 'add' | 'getJob') =>
    Object.entries(queues).filter(([, q]) => q[method].mock.calls.length > 0).map(([kind]) => kind);

  const job = (data: Record<string, unknown>) => ({
    id: 1, data, getState: jest.fn().mockResolvedValue('failed'), progress: () => 0,
    returnvalue: null, failedReason: 'boom', timestamp: 0, processedOn: 0, finishedOn: 0,
  });

  it('adds a branch import to the branch-import queue and nowhere else', async () => {
    await service.enqueueBranchImport({
      scope: { kind: 'PROJECT', id: 'p-1' }, userId: 'u-1', fileBuffer: file, totalRows: 400, rowsNeedingGeocode: 0,
    });
    expect(touched('add')).toEqual(['branch']);
    expect(queues.branch.add).toHaveBeenCalledWith(BRANCH_IMPORT_JOB, expect.anything(), expect.anything());
  });

  it('adds a roster import to the roster queue and nowhere else', async () => {
    await service.enqueueRosterImport({ actorId: 'u-1', fileBuffer: file, totalRows: 10 });
    expect(touched('add')).toEqual(['roster']);
    expect(queues.roster.add).toHaveBeenCalledWith(ROSTER_IMPORT_JOB, expect.anything(), expect.anything());
  });

  /**
   * A rehearsal is the whole import inside a rolled-back transaction. Beside a real import it would
   * wait on the same row locks inside its own open transaction, and describe a roster the other run
   * is half-way through changing — so it must share the real import's queue AND job name (a
   * different name needs a second handler, which is a second loop).
   */
  it('queues a roster rehearsal behind real roster imports: same queue, same job', async () => {
    await service.enqueueRosterImport({ actorId: 'u-1', fileBuffer: file, totalRows: 10, dryRun: true });
    expect(touched('add')).toEqual(['roster']);
    expect(queues.roster.add).toHaveBeenCalledWith(
      ROSTER_IMPORT_JOB, expect.objectContaining({ dryRun: true }), expect.anything(),
    );
  });

  it('adds a customer-master import to the customer-master queue and nowhere else', async () => {
    await service.enqueueCustomerMasterImport({
      actorId: 'u-1', projectId: 'p-1', fileBuffer: file, fileName: 'cm.xlsx', savedPath: '/x/cm.xlsx',
    });
    expect(touched('add')).toEqual(['customerMaster']);
    expect(queues.customerMaster.add).toHaveBeenCalledWith(CUSTOMER_MASTER_IMPORT_JOB, expect.anything(), expect.anything());
  });

  it('reads a branch import\'s status from the branch-import queue', async () => {
    queues.branch.getJob.mockResolvedValue(job({ scope: { kind: 'PROJECT', id: 'p-1' }, totalRows: 1, rowsNeedingGeocode: 0 }));
    await service.getBranchImportStatus({ kind: 'PROJECT', id: 'p-1' }, '1');
    expect(touched('getJob')).toEqual(['branch']);
  });

  it('reads a roster import\'s status from the roster queue', async () => {
    queues.roster.getJob.mockResolvedValue(job({ actorId: 'u-1', totalRows: 1 }));
    await service.getRosterImportStatus('u-1', '1');
    expect(touched('getJob')).toEqual(['roster']);
  });

  it('reads a customer-master import\'s status from the customer-master queue', async () => {
    queues.customerMaster.getJob.mockResolvedValue(job({ actorId: 'u-1', fileName: 'cm.xlsx' }));
    await service.getCustomerMasterImportStatus('u-1', '1');
    expect(touched('getJob')).toEqual(['customerMaster']);
  });

  describe('when a worker dies mid-import', () => {
    /**
     * Every reconciliation registers a new version and supersedes the active one for that date, so
     * Bull's default — put the stalled job back and run it from the top — registers the same file
     * twice when the first run had already committed. Branch and roster imports converge on a
     * re-run and keep the default; see `import.module.ts`.
     */
    it('fails a customer-master import instead of reconciling the file a second time', () => {
      const options = moduleRef.get(getQueueOptionsToken(CUSTOMER_MASTER_IMPORT_QUEUE), { strict: false });
      expect(options.settings?.maxStalledCount).toBe(0);
    });

    /** Bull's own words ("job stalled more than allowable limit") tell the uploader nothing. */
    it('tells the uploader to check the versions list rather than showing Bull\'s reason', async () => {
      queues.customerMaster.getJob.mockResolvedValue({
        ...job({ actorId: 'u-1', fileName: 'cm.xlsx' }),
        failedReason: ImportJobService.BULL_STALLED_REASON,
      });

      const status = await service.getCustomerMasterImportStatus('u-1', '1');

      expect(status.error).toBe(ImportJobService.CUSTOMER_MASTER_INTERRUPTED);
      expect(status.error).toMatch(/customer-master versions/);
    });

    /** The translation is keyed on Bull's exact string, so a Bull upgrade that rewords it must say so. */
    it('matches the reason Bull actually writes for a stalled job', () => {
      const commands = join(dirname(require.resolve('bull/package.json')), 'lib', 'commands');
      const scripts = readdirSync(commands)
        .filter((f) => f.endsWith('.lua'))
        .map((f) => readFileSync(join(commands, f), 'utf8'))
        .join('\n');
      expect(scripts).toContain(`"${ImportJobService.BULL_STALLED_REASON}"`);
    });
  });
});
