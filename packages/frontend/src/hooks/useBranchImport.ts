import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BackgroundJobAccepted,
  BackgroundJobSummary,
  BranchImportDecisions,
  BranchReviewReport,
} from '@fapoms/shared';
import { api } from '../services/api';
import { applyJobUpdate } from '../services/background-jobs';
import { userMessage } from '../services/errors';
import { useToast } from '../components/ui/Toast';
import { queryKeys } from './queryKeys';
import { useBackgroundJob, type BackgroundJobHandle } from './useBackgroundJob';

/**
 * FAPOMS — a page's handle on its branch imports (the `BRANCH_IMPORT` background job).
 *
 * One flow for the Branches page (scope CLIENT) and a project (scope PROJECT):
 *
 *  1. `start(file)` uploads and answers as soon as the server has stored it. The server rehearses
 *     the file in the background — nothing is written to the branch master yet.
 *  2. When the rehearsal is done the job waits for review (`reviewJob`). `review` is the stored
 *     review, read from the server — so after a refresh, a hard refresh or the next morning the page
 *     offers exactly the same review again.
 *  3. `commit(decisions)` starts the commit job; its progress and result arrive like any other job.
 *  4. `retry(job)` runs a failed or cancelled one again over the same stored file.
 *
 * Nothing about an import is kept in the browser; everything is read back from `/jobs`.
 */

export type BranchImportScope = { type: 'CLIENT' | 'PROJECT'; id: string };

/** Where each scope's routes live. */
export function branchImportBase(scope: BranchImportScope): string {
  return scope.type === 'PROJECT'
    ? `/projects/${scope.id}/branches/import`
    : `/branches/import/${scope.id}`;
}

function jobRoute(scope: BranchImportScope, jobId: string, action: 'commit' | 'retry'): string {
  return scope.type === 'PROJECT'
    ? `${branchImportBase(scope)}/${jobId}/${action}`
    : `${branchImportBase(scope)}/jobs/${jobId}/${action}`;
}

/** A rehearsal is a job whose (small) result says `phase: 'rehearse'`, or one still running with no parent. */
export function isRehearsal(job: Pick<BackgroundJobSummary, 'parentJobId' | 'result'> | null | undefined): boolean {
  if (!job) return false;
  const phase = (job.result?.details as { phase?: string } | undefined)?.phase;
  return phase ? phase === 'rehearse' : !job.parentJobId;
}

function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  // Older engines (and jsdom) have no Blob.text().
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** The stored review of a rehearsal, as the server wrote it. */
export async function fetchBranchReview(jobId: string): Promise<BranchReviewReport> {
  const blob = await api.request<Blob>(`/jobs/${jobId}/result`, { raw: true });
  const report = JSON.parse(await blobText(blob)) as BranchReviewReport;
  if (report?.version !== 1 || !Array.isArray(report.rows)) {
    throw new Error('The review could not be read. Upload the file again.');
  }
  return report;
}

export interface BranchImportHandle {
  /** The generic job handle, for `BackgroundJobPanel` and cancel/download. */
  jobs: BackgroundJobHandle;
  /** The rehearsal waiting for review, if there is one. */
  reviewJob: BackgroundJobSummary | null;
  review: BranchReviewReport | null;
  reviewLoading: boolean;
  reviewError: string | null;
  start: (file: File) => Promise<BackgroundJobSummary | null>;
  commit: (decisions: BranchImportDecisions) => Promise<boolean>;
  retry: (job: BackgroundJobSummary) => Promise<void>;
  discard: () => Promise<void>;
  /**
   * True once, when a rehearsal this page was watching finished and is ready for review — the page
   * opens the review then. A page opened onto a waiting review shows "Review ready" instead of
   * popping a dialog at someone who just arrived.
   */
  reviewJustBecameReady: boolean;
  acknowledgeReviewReady: () => void;
}

export function useBranchImport(
  scope: BranchImportScope | null,
  options: { onCommitted?: (job: BackgroundJobSummary) => void } = {},
): BranchImportHandle {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const jobScope = scope ? { type: scope.type, id: scope.id } : null;
  const jobs = useBackgroundJob('BRANCH_IMPORT', jobScope, { endpoint: scope ? branchImportBase(scope) : undefined });

  const reviewJob = useMemo(
    () => (scope ? jobs.active.find((j) => j.status === 'AWAITING_REVIEW' && isRehearsal(j)) ?? null : null),
    [jobs.active, scope],
  );

  const reviewQuery = useQuery({
    queryKey: [...queryKeys.jobs.all, 'branch-review', reviewJob?.id ?? ''],
    queryFn: () => fetchBranchReview(reviewJob!.id),
    enabled: !!reviewJob?.hasResultFile,
    staleTime: Infinity,
  });

  // A rehearsal we saw running and then saw finish: the person is waiting for it.
  const seenInFlight = useRef(new Set<string>());
  const [readyId, setReadyId] = useState<string | null>(null);
  useEffect(() => {
    for (const j of jobs.active) {
      if (j.status === 'QUEUED' || j.status === 'RUNNING') seenInFlight.current.add(j.id);
    }
    if (reviewJob && seenInFlight.current.has(reviewJob.id)) {
      seenInFlight.current.delete(reviewJob.id);
      setReadyId(reviewJob.id);
    }
  }, [jobs.active, reviewJob]);

  // A commit we saw running and then saw succeed: the page reloads what it shows.
  const committing = useRef(new Set<string>());
  const onCommitted = useRef(options.onCommitted);
  onCommitted.current = options.onCommitted;
  useEffect(() => {
    for (const j of jobs.active) if (!isRehearsal(j)) committing.current.add(j.id);
    for (const j of jobs.recent) {
      if (committing.current.has(j.id) && j.status !== 'QUEUED' && j.status !== 'RUNNING') {
        committing.current.delete(j.id);
        if (j.status === 'SUCCEEDED' || j.status === 'CANCELLED') onCommitted.current?.(j);
      }
    }
  }, [jobs.active, jobs.recent]);

  const start = useCallback(async (file: File) => jobs.start(file), [jobs]);

  const accept = useCallback(async (url: string, body?: unknown) => {
    const accepted = await api.request<BackgroundJobAccepted>(url, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    applyJobUpdate(queryClient, accepted.job);
    void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    return accepted.job;
  }, [queryClient]);

  const commit = useCallback(async (decisions: BranchImportDecisions) => {
    if (!scope || !reviewJob) return false;
    try {
      await accept(jobRoute(scope, reviewJob.id, 'commit'), { decisions });
      toast({
        type: 'success',
        title: 'Saving the reviewed branches',
        message: 'This runs on the server — you can leave or refresh this page. Progress is shown here and in the Jobs tray.',
      });
      return true;
    } catch (err) {
      toast({ type: 'error', title: 'Could not start the commit', message: userMessage(err) });
      return false;
    }
  }, [accept, scope, reviewJob, toast]);

  const retry = useCallback(async (job: BackgroundJobSummary) => {
    if (!scope) return;
    try {
      await accept(jobRoute(scope, job.id, 'retry'));
    } catch (err) {
      toast({ type: 'error', title: 'Could not retry', message: userMessage(err) });
    }
  }, [accept, scope, toast]);

  const discard = useCallback(async () => {
    if (reviewJob) await jobs.cancel(reviewJob.id);
  }, [jobs, reviewJob]);

  return {
    jobs,
    reviewJob,
    review: reviewQuery.data ?? null,
    reviewLoading: reviewQuery.isLoading && !!reviewJob,
    reviewError: reviewQuery.error ? userMessage(reviewQuery.error) : null,
    start,
    commit,
    retry,
    discard,
    reviewJustBecameReady: !!readyId && readyId === reviewJob?.id,
    acknowledgeReviewReady: () => setReadyId(null),
  };
}
