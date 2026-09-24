import { QueryClient } from '@tanstack/react-query';
import type { BackgroundJobList, BackgroundJobSummary } from '@fapoms/shared';
import { applyJobUpdate, downloadJobResult, jobKeys, mergeJob } from './background-jobs';
import { api } from './api';

jest.mock('./api', () => ({ api: { request: jest.fn() } }));

/**
 * How one pushed job update lands in every cached list — the tray's, and only the pages watching
 * that job's own kind and scope.
 */
const job = (over: Partial<BackgroundJobSummary> = {}): BackgroundJobSummary => ({
  id: 'j-1', kind: 'BRANCH_IMPORT', status: 'RUNNING', title: 't', requestedBy: 'u',
  scopeType: 'CLIENT', scopeId: 'c-1',
  progress: { processed: 1, total: 10, percent: 10, stage: 's' },
  result: null, error: null, inputFileName: null, inputSize: null, parentJobId: null,
  cancelRequested: false, hasResultFile: false, resultFileName: null,
  createdAt: '2026-09-24T10:00:00.000Z', startedAt: null, finishedAt: null, updatedAt: '2026-09-24T10:00:00.000Z',
  ...over,
});
const empty = (): BackgroundJobList => ({ active: [], recent: [] });

describe('mergeJob', () => {
  it('moves a job from active to recent when it settles, newest first', () => {
    const older = job({ id: 'j-0', status: 'SUCCEEDED', createdAt: '2026-09-23T10:00:00.000Z' });
    const list = { active: [job()], recent: [older] };
    const done = job({ status: 'SUCCEEDED', updatedAt: '2026-09-24T10:05:00.000Z' });
    expect(mergeJob(list, done)).toEqual({ active: [], recent: [done, older] });
  });

  it('keeps a rehearsal awaiting review in the active list', () => {
    expect(mergeJob(empty(), job({ status: 'AWAITING_REVIEW' })).active).toHaveLength(1);
  });

  it('never lets an older update overwrite a newer one', () => {
    const newer = job({ updatedAt: '2026-09-24T10:05:00.000Z', progress: { processed: 9, total: 10, percent: 90, stage: 's' } });
    const list = { active: [newer], recent: [] };
    expect(mergeJob(list, job())).toBe(list);
  });

  it('lets a finished job win over a progress push stamped by a clock that runs ahead', () => {
    // The push was stamped by the API process's clock, the poll by the database's.
    const pushed = job({ updatedAt: '2026-09-24T10:09:00.000Z' });
    const list = { active: [pushed], recent: [] };
    const finishedPoll = job({ status: 'SUCCEEDED', updatedAt: '2026-09-24T10:08:30.000Z' });
    expect(mergeJob(list, finishedPoll)).toEqual({ active: [], recent: [finishedPoll] });
  });

  it('never lets a late progress push reopen a finished job', () => {
    const finished = job({ status: 'FAILED', updatedAt: '2026-09-24T10:05:00.000Z' });
    const list = { active: [], recent: [finished] };
    expect(mergeJob(list, job({ updatedAt: '2026-09-24T10:06:00.000Z' }))).toBe(list);
  });
});

describe('applyJobUpdate', () => {
  it('updates the tray and the matching page, and leaves another scope\'s page alone', () => {
    const qc = new QueryClient();
    qc.setQueryData(jobKeys.tray, empty());
    qc.setQueryData(jobKeys.forScope('BRANCH_IMPORT', 'CLIENT', 'c-1'), empty());
    qc.setQueryData(jobKeys.forScope('BRANCH_IMPORT', 'CLIENT', 'c-2'), empty());
    qc.setQueryData(jobKeys.forScope('ROSTER_IMPORT'), empty());
    qc.setQueryData(jobKeys.forScope('BRANCH_IMPORT'), empty()); // any scope of this kind

    applyJobUpdate(qc, job());

    const ids = (key: readonly unknown[]) => qc.getQueryData<BackgroundJobList>(key)!.active.map((j) => j.id);
    expect(ids(jobKeys.tray)).toEqual(['j-1']);
    expect(ids(jobKeys.forScope('BRANCH_IMPORT', 'CLIENT', 'c-1'))).toEqual(['j-1']);
    expect(ids(jobKeys.forScope('BRANCH_IMPORT'))).toEqual(['j-1']);
    expect(ids(jobKeys.forScope('BRANCH_IMPORT', 'CLIENT', 'c-2'))).toEqual([]);
    expect(ids(jobKeys.forScope('ROSTER_IMPORT'))).toEqual([]);
  });
});

describe('downloadJobResult', () => {
  const request = api.request as jest.Mock;
  beforeEach(() => {
    request.mockReset().mockResolvedValue(new Blob(['x']));
    (URL as any).createObjectURL = jest.fn(() => 'blob:x');
    (URL as any).revokeObjectURL = jest.fn();
  });

  it('fetches a stored report from the job', async () => {
    await downloadJobResult(job({ hasResultFile: true, resultFileName: 'skipped.xlsx' }));
    expect(request).toHaveBeenCalledWith('/jobs/j-1/result', { raw: true });
  });

  it("follows an export's own link while it lasts, and refuses once it has expired", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await downloadJobResult(job({
      status: 'SUCCEEDED', kind: 'REPORT_EXPORT',
      result: { summary: 'ready', download: { path: '/reports/jobs/7/download', fileName: 'a.xlsx', expiresAt: future } },
    }));
    expect(request).toHaveBeenCalledWith('/reports/jobs/7/download', { raw: true });

    request.mockClear();
    const past = new Date(Date.now() - 1).toISOString();
    await expect(downloadJobResult(job({
      status: 'SUCCEEDED', kind: 'REPORT_EXPORT',
      result: { summary: 'ready', download: { path: '/reports/jobs/7/download', fileName: 'a.xlsx', expiresAt: past } },
    }))).rejects.toThrow(/expired/);
    expect(request).not.toHaveBeenCalled();
  });
});
