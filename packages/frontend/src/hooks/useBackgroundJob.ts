import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isBackgroundJobInFlight,
  type BackgroundJobKind,
  type BackgroundJobList,
  type BackgroundJobScope,
  type BackgroundJobSummary,
} from '@fapoms/shared';
import { useToast } from '../components/ui/Toast';
import { useSocketConnection } from './useSocketConnection';
import { queryKeys } from './queryKeys';
import {
  applyJobUpdate,
  cancelJob,
  commitReviewedJob,
  downloadJobResult,
  fetchJobs,
  uploadJob,
  type UploadProgress,
} from '../services/background-jobs';
import { userMessage } from '../services/errors';

/**
 * FAPOMS — a page's handle on its own background uploads.
 *
 * ```tsx
 * const branches = useBackgroundJob('BRANCH_IMPORT', { type: 'CLIENT', id: clientId });
 * <input type="file" onChange={(e) => branches.start(e.target.files![0])} />
 * <BackgroundJobPanel handle={branches} />
 * ```
 *
 * What it guarantees, and how:
 *
 *  - **Refresh-proof.** `job` is read from the server (`GET /jobs?kind=&scopeType=&scopeId=`) on
 *    mount, so a page reloaded — or hard-reloaded, or opened in another tab — halfway through a
 *    5,000-row import shows that import's progress again. Nothing is kept in browser storage.
 *  - **Live.** `job:updated` pushes are written straight into this query's cache (see
 *    `useSocketInvalidation`); while a job is in flight and the socket is down, it polls every 5 s.
 *  - **Honest about the one thing that is NOT refresh-proof.** Until the server has the file, the
 *    bytes exist only in this tab. While they upload, `upload.phase` is `'uploading'` with a real
 *    fraction, and leaving the page asks first. The moment the server answers, the job is the
 *    server's and leaving is safe — and the toast says so.
 */

/** Poll this often while a job is in flight and the socket is down. */
export const JOB_POLL_OFFLINE_MS = 5_000;
/** And this often with the socket up — a safety net for a missed push, not the update path. */
export const JOB_POLL_LIVE_MS = 30_000;

/** Every screen that lists jobs polls on the same rule. */
export function jobPollInterval(list: BackgroundJobList | undefined, socketLive: boolean): number | false {
  const inFlight = !!list?.active.some((j) => isBackgroundJobInFlight(j.status));
  if (!inFlight) return false;
  return socketLive ? JOB_POLL_LIVE_MS : JOB_POLL_OFFLINE_MS;
}

export type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading'; fileName: string; progress: UploadProgress }
  | { phase: 'error'; fileName: string; message: string };

export interface BackgroundJobHandle {
  /** The newest job of this kind and scope: the one in flight if there is one, else the latest finished. */
  job: BackgroundJobSummary | null;
  active: BackgroundJobSummary[];
  recent: BackgroundJobSummary[];
  /** True until the server has answered the first time. */
  isLoading: boolean;
  upload: UploadState;
  /**
   * Upload `file` (or several, for a kind whose route takes a set) and start the job. Resolves with
   * the job as soon as the server has stored the file(s).
   */
  start: (file: File | File[] | null, params?: Record<string, unknown>, title?: string) => Promise<BackgroundJobSummary | null>;
  /** Stop the bytes that are still uploading. Nothing reached the server, so nothing else to undo. */
  abortUpload: () => void;
  cancel: (jobId?: string) => Promise<void>;
  /** Accept a rehearsal (AWAITING_REVIEW) and start the real run over the same file. */
  commit: (params?: Record<string, unknown>, jobId?: string) => Promise<BackgroundJobSummary | null>;
  downloadResult: (jobId?: string) => Promise<void>;
  resetUpload: () => void;
}

export interface UseBackgroundJobOptions {
  /** A kind whose page has its own start route (same 202 answer) posts there instead of `/jobs`. */
  endpoint?: string;
}

export function useBackgroundJob(
  kind: BackgroundJobKind,
  scope?: BackgroundJobScope | null,
  options: UseBackgroundJobOptions = {},
): BackgroundJobHandle {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const socketLive = useSocketConnection();
  const key = queryKeys.jobs.forScope(kind, scope?.type, scope?.id);

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      fetchJobs({ kind, scopeType: scope?.type, scopeId: scope?.id, status: ['active', 'recent'], limit: 5 }, signal),
    refetchInterval: (q) => jobPollInterval(q.state.data as BackgroundJobList | undefined, socketLive),
  });

  const active = useMemo(() => query.data?.active ?? [], [query.data]);
  const recent = useMemo(() => query.data?.recent ?? [], [query.data]);
  const job = active[0] ?? recent[0] ?? null;

  const [upload, setUpload] = useState<UploadState>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  // Bytes in flight exist only in this tab: leaving now really would lose the upload.
  useEffect(() => {
    if (upload.phase !== 'uploading') return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [upload.phase]);

  const start = useCallback<BackgroundJobHandle['start']>(async (input, params, title) => {
    const files = Array.isArray(input) ? input : null;
    const file = Array.isArray(input) ? null : input;
    const fileName = files
      ? files.length === 1 ? files[0].name : `${files.length} files`
      : file?.name ?? 'your request';
    const totalBytes = files ? files.reduce((sum, f) => sum + f.size, 0) : file?.size ?? 0;
    const controller = new AbortController();
    abortRef.current = controller;
    setUpload({ phase: 'uploading', fileName, progress: { loaded: 0, total: totalBytes, fraction: 0 } });
    toast({
      type: 'info',
      title: `Uploading ${fileName}…`,
      message: 'Keep this page open until the upload finishes. After that you can leave — progress will be in the Jobs tray.',
    });
    try {
      const accepted = await uploadJob(
        { kind, scope, file, files, params, title, endpoint: options.endpoint },
        { onProgress: (progress) => setUpload({ phase: 'uploading', fileName, progress }), signal: controller.signal },
      );
      setUpload({ phase: 'idle' });
      applyJobUpdate(queryClient, accepted.job);
      // A page whose tray query has not loaded yet still sees it on its next read.
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.tray, refetchType: 'none' });
      toast(accepted.deduplicated
        ? {
            type: 'info',
            title: 'Already in progress',
            message: `${fileName} is already being processed — showing that job instead of starting it twice.`,
          }
        : {
            type: 'success',
            title: 'Received — processing in the background',
            message: 'You can leave this page or refresh it; progress is in the Jobs tray.',
          });
      return accepted.job;
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setUpload({ phase: 'idle' });
        return null;
      }
      const message = userMessage(err);
      setUpload({ phase: 'error', fileName, message });
      toast({ type: 'error', title: `${fileName} was not uploaded`, message });
      return null;
    } finally {
      abortRef.current = null;
    }
  }, [kind, scope, options.endpoint, queryClient, toast]);

  const abortUpload = useCallback(() => abortRef.current?.abort(), []);

  const cancel = useCallback<BackgroundJobHandle['cancel']>(async (jobId) => {
    const id = jobId ?? job?.id;
    if (!id) return;
    try {
      applyJobUpdate(queryClient, await cancelJob(id));
    } catch (err) {
      toast({ type: 'error', title: 'Could not cancel', message: userMessage(err) });
    }
  }, [job?.id, queryClient, toast]);

  const commit = useCallback<BackgroundJobHandle['commit']>(async (params, jobId) => {
    const id = jobId ?? job?.id;
    if (!id) return null;
    try {
      const accepted = await commitReviewedJob(id, params);
      applyJobUpdate(queryClient, accepted.job);
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      return accepted.job;
    } catch (err) {
      toast({ type: 'error', title: 'Could not start it', message: userMessage(err) });
      return null;
    }
  }, [job?.id, queryClient, toast]);

  const downloadResult = useCallback<BackgroundJobHandle['downloadResult']>(async (jobId) => {
    const target = [...active, ...recent].find((j) => j.id === (jobId ?? job?.id));
    if (!target) return;
    try {
      await downloadJobResult(target);
    } catch (err) {
      toast({ type: 'error', title: 'Could not download the report', message: userMessage(err) });
    }
  }, [active, recent, job?.id, toast]);

  const resetUpload = useCallback(() => setUpload({ phase: 'idle' }), []);

  return {
    job,
    active,
    recent,
    isLoading: query.isLoading,
    upload,
    start,
    abortUpload,
    cancel,
    commit,
    downloadResult,
    resetUpload,
  };
}
