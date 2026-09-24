/**
 * The BRANCH_IMPORT kind as the Jobs foundation drives it: `prepare` in the request (the region
 * ceiling, the wrong-file and wrong-scope refusals) and `run` in the worker (rehearse → review →
 * commit over the stored review).
 *
 * The region cases are the ones the old routes got wrong: the client commit had no check at all,
 * the project commit compared a STATE name to a list of region CODES (so every region-scoped user
 * was refused), and a review showed branches of any region to anyone.
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import type { BackgroundJobSummary, BranchReviewReport } from '@fapoms/shared';
import { RegionGuardService } from '../../../infrastructure/scope/region-guard.service';
import { BackgroundJobCancelledError, type PrepareContext, type RunContext } from '../../../infrastructure/background-jobs/background-jobs.contract';
import { BranchImportJob, validateDecisions } from './branch-import.job';
import { countingLookups, master, MemoryBranchStore, sheetOf, target } from './branch-import.fixtures';
import type { BranchImportParams, BranchImportScopeType } from './branch-import.types';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const actor = { userId: 'u-1', roleNames: ['OPERATIONS'] };

const row = (overrides: Record<string, unknown> = {}) => ({
  BRANCH: 'S-1', BRANCH_NAME: 'Thenkurissi', DISTRICT: 'Palakkad', STATE: 'Kerala',
  'Branch Address': '1 Main Road 678671', Packets: 58, ...overrides,
});

function harness(seed = [master({ solId: 'W-1', state: 'Maharashtra', region: 'WEST' })]) {
  const memory = new MemoryBranchStore(seed);
  const results = new Map<string, Buffer>();
  const store = {
    resolveTarget: jest.fn(async (scopeType: BranchImportScopeType, id: string) => {
      if (id === '99999999-9999-4999-8999-999999999999') throw new NotFoundException('That client was not found');
      return target({ scopeType, projectId: scopeType === 'PROJECT' ? id : null });
    }),
    regionsOfKnownBranches: jest.fn(async (_clientId: string | null, sols: string[]) => {
      const want = new Set(sols.map((s) => s.toUpperCase()));
      return [...memory.branches.values()].filter((b) => want.has(b.solId.toUpperCase()) && b.region).map((b) => b.region!);
    }),
    readsFor: () => memory.reads(),
    commitStoreFor: () => memory.commitStore(),
    recordImportSummary: jest.fn(async () => undefined),
  };
  const jobs = {
    openResult: jest.fn(async (_reader: unknown, id: string) => {
      const content = results.get(id);
      if (!content) throw new NotFoundException('This job has no report to download.');
      return { stream: Readable.from(content), fileName: 'branch-review.json', mimeType: 'application/json' };
    }),
  };
  const registry = { register: jest.fn() };
  const regionGuard = new RegionGuardService(null as any, null as any);
  const job = new BranchImportJob(registry as any, jobs as any, store as any, regionGuard, { enqueueBackfill: jest.fn() } as any);
  const { lookups, calls } = countingLookups();
  job.lookups = lookups;
  return { job, memory, results, store, calls };
}

function prepareCtx(
  over: Partial<PrepareContext<BranchImportParams>> & { rows?: Array<Record<string, unknown>> } = {},
): PrepareContext<BranchImportParams> {
  const buffer = over.rows ? sheetOf(over.rows) : null;
  const file = buffer
    ? { originalName: 'b.xlsx', mimeType: null, size: buffer.length, sha256: 'x', read: async () => buffer, stream: () => Readable.from(buffer) }
    : null;
  const { rows: _rows, ...rest } = over;
  return {
    kind: 'BRANCH_IMPORT',
    actor,
    regions: null,
    scope: { type: 'CLIENT', id: CLIENT },
    params: { phase: 'rehearse' },
    parent: null,
    file,
    files: file ? [file] : [],
    ...rest,
  } as PrepareContext<BranchImportParams>;
}

function runCtx(h: ReturnType<typeof harness>, over: {
  id: string; params: BranchImportParams; input?: Buffer; parentJobId?: string | null; regions?: string[] | null;
  scopeType?: BranchImportScopeType; cancelAfter?: number;
}): RunContext<BranchImportParams> & { report?: { name: string; content: Buffer } } {
  let checks = 0;
  const ctx: any = {
    job: { id: over.id, parentJobId: over.parentJobId ?? null } as Partial<BackgroundJobSummary>,
    kind: 'BRANCH_IMPORT',
    params: over.params,
    actor,
    regions: over.regions ?? null,
    scope: { type: over.scopeType ?? 'CLIENT', id: over.scopeType === 'PROJECT' ? PROJECT : CLIENT },
    attempt: 1,
    openInput: async () => Readable.from(over.input!),
    readInput: async () => over.input!,
    progress: async () => undefined,
    stage: async () => undefined,
    throwIfCancelled: async () => undefined,
    isCancelRequested: async () => over.cancelAfter !== undefined && ++checks > over.cancelAfter,
    attachReport: async (name: string, content: Buffer) => {
      ctx.report = { name, content };
      h.results.set(over.id, content);
    },
  };
  return ctx;
}

describe('BRANCH_IMPORT prepare — the region ceiling, in the request', () => {
  it('accepts a file wholly inside the uploader\'s regions, and names it', async () => {
    const { job } = harness();
    const out = await job.prepare(prepareCtx({ regions: ['SOUTH'], rows: [row(), row({ BRANCH: 'S-2' })] }));
    expect(out).toMatchObject({ total: 2, title: '2 branches for SBI' });
  });

  it('refuses a file naming a state in a region the uploader does not hold', async () => {
    const { job } = harness();
    await expect(job.prepare(prepareCtx({ regions: ['SOUTH'], rows: [row(), row({ BRANCH: 'S-2', STATE: 'Maharashtra' })] })))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a file that names a known branch sitting in another region, even with no state on the row', async () => {
    const { job } = harness();
    await expect(job.prepare(prepareCtx({ regions: ['SOUTH'], rows: [row(), { BRANCH: 'W-1', BRANCH_NAME: 'Pune' }] })))
      .rejects.toThrow(/WEST region/);
  });

  it('lets an unrestricted account upload anything', async () => {
    const { job } = harness();
    await expect(job.prepare(prepareCtx({ regions: null, rows: [row({ STATE: 'Maharashtra' })] }))).resolves.toBeTruthy();
  });

  it('refuses a scope that is not a client or a project, and an id that is not one', async () => {
    const { job } = harness();
    await expect(job.prepare(prepareCtx({ scope: { type: 'CLIENT', id: '' }, rows: [row()] }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(job.prepare(prepareCtx({ scope: { type: 'ROSTER', id: CLIENT }, rows: [row()] }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(job.prepare(prepareCtx({ scope: { type: 'CLIENT', id: '99999999-9999-4999-8999-999999999999' }, rows: [row()] })))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses another importer\'s file before anything is stored', async () => {
    const { job } = harness();
    await expect(job.prepare(prepareCtx({ rows: [{ 'Assayer Code': 'A1', 'Assayer Name': 'X', 'Residence Address': 'Y' }] })))
      .rejects.toThrow(/assayer roster, not a branch list/);
  });

  describe('a commit', () => {
    async function rehearsed(h: ReturnType<typeof harness>, rows: Array<Record<string, unknown>>) {
      await h.job.run(runCtx(h, { id: 'rehearsal-1', params: { phase: 'rehearse' }, input: sheetOf(rows) }));
      const report = JSON.parse(h.results.get('rehearsal-1')!.toString()) as BranchReviewReport;
      const parent = {
        id: 'rehearsal-1', kind: 'BRANCH_IMPORT', status: 'AWAITING_REVIEW', scopeType: 'CLIENT', scopeId: CLIENT,
        hasResultFile: true, result: { summary: '', details: { phase: 'rehearse' } }, title: 't',
      } as unknown as BackgroundJobSummary;
      return { report, parent };
    }

    it('maps each row\'s STATE to its region before checking — a scoped user can commit their own rows', async () => {
      const h = harness([]);
      const { parent } = await rehearsed(h, [row(), row({ BRANCH: 'S-2', STATE: 'Tamil Nadu' })]);
      await expect(h.job.prepare(prepareCtx({
        regions: ['SOUTH'], params: { phase: 'commit', decisions: { mode: 'all_valid', excluded: [], edits: {} } }, parent,
      }))).resolves.toMatchObject({ total: 2 });
    });

    it('refuses decisions that would move a row into another region', async () => {
      const h = harness([]);
      const { report, parent } = await rehearsed(h, [row()]);
      await expect(h.job.prepare(prepareCtx({
        regions: ['SOUTH'], parent,
        params: { phase: 'commit', decisions: { mode: 'all_valid', excluded: [], edits: { [report.rows[0].rowNumber]: { state: 'Gujarat' } } } },
      }))).rejects.toThrow(/WEST region/);
    });

    it('refuses a review that belongs to another client', async () => {
      const h = harness([]);
      const { parent } = await rehearsed(h, [row()]);
      await expect(h.job.prepare(prepareCtx({
        scope: { type: 'CLIENT', id: '33333333-3333-4333-8333-333333333333' }, parent,
        params: { phase: 'commit', decisions: { mode: 'all_valid', excluded: [], edits: {} } },
      }))).rejects.toThrow(/another import/);
    });

    it('refuses malformed decisions with a sentence, before anything is queued', () => {
      expect(() => validateDecisions(null)).toThrow(/no decisions/);
      expect(() => validateDecisions({ mode: 'everything' })).toThrow(/commit every valid row/);
      expect(() => validateDecisions({ mode: 'all_valid', excluded: ['x'] })).toThrow(/row numbers/);
      expect(() => validateDecisions({ mode: 'all_valid', edits: { abc: {} } })).toThrow(/edit for row abc/);
    });
  });
});

describe('BRANCH_IMPORT run — rehearse, review, commit', () => {
  it('rehearses into a stored review, then commits the decisions against it', async () => {
    const h = harness([]);
    const input = sheetOf([row(), row({ BRANCH: 'S-2' }), row({ BRANCH: 'S-3', STATE: '' })]);

    const rehearsal = await h.job.run(runCtx(h, { id: 'r-1', params: { phase: 'rehearse' }, input }));
    expect(rehearsal.status).toBe('AWAITING_REVIEW');
    expect(rehearsal.result.details).toMatchObject({ phase: 'rehearse', summary: { totalRows: 3, needsDetailsCount: 0 } });
    // S-3 had no state: the IFSC directory (asked for that row alone) supplied it.
    expect(h.memory.branches.size).toBe(0); // a rehearsal writes nothing

    const review = JSON.parse(h.results.get('r-1')!.toString()) as BranchReviewReport;
    const s3 = review.rows.find((r) => r.solId === 'S-3')!;
    const committed = await h.job.run(runCtx(h, {
      id: 'c-1', parentJobId: 'r-1',
      params: { phase: 'commit', decisions: { mode: 'all_valid', excluded: [], edits: { [s3.rowNumber]: { state: 'Tamil Nadu' } } } },
    }));

    expect(committed.status).toBe('SUCCEEDED');
    expect(committed.result.counts).toMatchObject({ created: 3, skipped: 0 });
    expect(committed.result.summary).toBe('3 branches saved (3 new, 0 updated); 3 placed approximately for now.');
    expect(h.memory.bySol('S-3')!.state).toBe('Tamil Nadu');
    expect(h.store.recordImportSummary).toHaveBeenCalledTimes(1);
  });

  it('refuses in the worker what slipped past the request — rows outside the requester\'s regions', async () => {
    const h = harness();
    await expect(h.job.run(runCtx(h, {
      id: 'r-2', params: { phase: 'rehearse' }, regions: ['SOUTH'], input: sheetOf([row(), { BRANCH: 'W-1', BRANCH_NAME: 'Pune' }]),
    }))).rejects.toThrow(/WEST, which your account is not assigned to/);
  });

  it('a cancelled commit stops between chunks and says how far it got', async () => {
    const h = harness([]);
    const rows = Array.from({ length: 450 }, (_, i) => row({ BRANCH: `K-${i}` }));
    await h.job.run(runCtx(h, { id: 'r-3', params: { phase: 'rehearse' }, input: sheetOf(rows) }));
    const run = h.job.run(runCtx(h, {
      id: 'c-3', parentJobId: 'r-3', cancelAfter: 1,
      params: { phase: 'commit', decisions: { mode: 'all_valid', excluded: [], edits: {} } },
    }));
    const err = await run.catch((e) => e);
    expect(err).toBeInstanceOf(BackgroundJobCancelledError);
    expect(err.partial.summary).toMatch(/Stopped on request after 400 of 450 rows/);
    expect(h.memory.branches.size).toBe(400);
  });
});
