import type { QueryClient } from '@tanstack/react-query';
import {
  isBackgroundJobOpen,
  liveBackgroundJobDownload,
  type BackgroundJobAccepted,
  type BackgroundJobKind,
  type BackgroundJobList,
  type BackgroundJobScope,
  type BackgroundJobSummary,
} from '@fapoms/shared';
import { api } from './api';
import { queryKeys } from '../hooks/queryKeys';
import { AppError, fromResponse } from './errors';

/**
 * FAPOMS — talking to `/jobs`, the server's record of work it is doing in the background.
 *
 * The one rule this file keeps: **the server is the only memory.** Nothing here writes a job to
 * localStorage or sessionStorage. A page that is refreshed, hard-refreshed, or opened in another tab
 * asks `GET /jobs` and draws what it is told, so what the person sees can never disagree with what
 * is actually happening.
 */

export interface JobListRequest {
  status?: Array<'active' | 'recent'>;
  kind?: BackgroundJobKind;
  scopeType?: string | null;
  scopeId?: string | null;
  limit?: number;
}

export function fetchJobs(request: JobListRequest = {}, signal?: AbortSignal): Promise<BackgroundJobList> {
  const params = new URLSearchParams();
  params.set('status', (request.status ?? ['active', 'recent']).join(','));
  if (request.kind) params.set('kind', request.kind);
  if (request.scopeType) params.set('scopeType', request.scopeType);
  if (request.scopeId) params.set('scopeId', request.scopeId);
  params.set('limit', String(request.limit ?? 10));
  return api.request<BackgroundJobList>(`/jobs?${params.toString()}`, { signal });
}

export const cancelJob = (id: string) =>
  api.request<BackgroundJobSummary>(`/jobs/${id}/cancel`, { method: 'POST' });

export const commitReviewedJob = (id: string, params: Record<string, unknown> = {}) =>
  api.request<BackgroundJobAccepted>(`/jobs/${id}/commit`, { method: 'POST', body: JSON.stringify({ params }) });

/**
 * Fetch a job's report and hand it to the browser as a download (the route needs the auth header).
 *
 * A report stored on the job comes from `GET /jobs/:id/result`; an export whose file lives with its
 * feature for a short while (`result.download`) comes from that feature's route instead.
 */
export async function downloadJobResult(
  job: Pick<BackgroundJobSummary, 'id' | 'resultFileName' | 'hasResultFile'> & Partial<Pick<BackgroundJobSummary, 'result'>>,
): Promise<void> {
  const link = job.hasResultFile ? null : liveBackgroundJobDownload(job.result);
  if (!job.hasResultFile && !link) throw new AppError('This file has expired. Run it again to get a fresh copy.', 'expired');
  const blob = await api.request<Blob>(link ? link.path : `/jobs/${job.id}/result`, { raw: true });
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = (link ? link.fileName : job.resultFileName) || 'report';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
}

export interface StartJobRequest {
  kind: BackgroundJobKind;
  scope?: BackgroundJobScope | null;
  file?: File | null;
  /**
   * Several files in one upload, for a kind whose start route takes a set (a day's audit packets).
   * Sent as repeated `files` parts; never together with `file`.
   */
  files?: File[] | null;
  params?: Record<string, unknown>;
  title?: string;
  /**
   * The route to post to. Defaults to the generic `POST /jobs`; a kind whose page has its own
   * start route (with its own guards) passes that instead — it must answer the same
   * `BackgroundJobAccepted`.
   */
  endpoint?: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  fraction: number;
}

/**
 * Upload a file and start a job over it, reporting real upload progress.
 *
 * XHR rather than `fetch`, for the reason `uploadFeedbackAttachment` gives: `fetch` cannot report
 * upload progress, and a 20 MB sheet over an office link is a minute of nothing without it.
 *
 * Resolves the moment the server has STORED the file and recorded the job (it answers 202 then),
 * never after the work — the work is the server's now.
 */
export function uploadJob(
  request: StartJobRequest,
  opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<BackgroundJobAccepted> {
  const send = () =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const form = new FormData();
      form.append('kind', request.kind);
      if (request.scope?.type) form.append('scopeType', request.scope.type);
      if (request.scope?.id) form.append('scopeId', request.scope.id);
      if (request.params && Object.keys(request.params).length > 0) form.append('params', JSON.stringify(request.params));
      if (request.title) form.append('title', request.title);
      // The file goes last, so the text fields are parsed before multer starts writing bytes.
      if (request.file) form.append('file', request.file);
      for (const f of request.files ?? []) form.append('files', f);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/v1${request.endpoint ?? '/jobs'}`);
      const token = localStorage.getItem('fapoms_token');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (!opts.onProgress) return;
        const total = e.lengthComputable
          ? e.total
          : request.file?.size ?? (request.files ?? []).reduce((sum, f) => sum + f.size, 0);
        opts.onProgress({ loaded: e.loaded, total, fraction: total > 0 ? Math.min(1, e.loaded / total) : 0 });
      };
      xhr.onload = () => {
        let body: any = {};
        try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* handled below */ }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new AppError(
        'The upload could not reach the server. Check the connection and try again.',
        'XHR network error',
      ));
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
      opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    });

  return (async () => {
    let answer = await send();
    if (answer.status === 401) {
      // The access token expired mid-session. Any ordinary API call refreshes it (and ends the
      // session properly if it cannot); then the upload is sent once more.
      await api.request('/jobs?status=active&limit=1');
      answer = await send();
    }
    if (answer.status >= 200 && answer.status < 300) {
      const payload = answer.body && typeof answer.body === 'object' && 'success' in answer.body && 'data' in answer.body
        ? answer.body.data
        : answer.body;
      return payload as BackgroundJobAccepted;
    }
    // The same wording every other refusal in the app gets — the server's sentence names the limit,
    // the allowed types, or what is wrong with the sheet.
    throw fromResponse(answer.status, answer.body);
  })();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keeping every cached job list in step with a pushed update
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The query keys job lists live under. `tray` is the header's list; `forScope` is a page watching
 * its own kind (and scope). Both sit under `['jobs']`, which is what an update walks.
 */
export const jobKeys = queryKeys.jobs;

function matchesKey(key: readonly unknown[], job: BackgroundJobSummary): boolean {
  if (key[1] === 'tray') return true;
  if (key[1] !== 'scope') return false;
  const [, , kind, scopeType, scopeId] = key as [string, string, string, string, string];
  return job.kind === kind
    && (!scopeType || job.scopeType === scopeType)
    && (!scopeId || job.scopeId === scopeId);
}

function byNewest(a: BackgroundJobSummary, b: BackgroundJobSummary): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/** The list with this job put where its status says it belongs, replacing any older copy. */
export function mergeJob(list: BackgroundJobList, job: BackgroundJobSummary): BackgroundJobList {
  const existing = [...list.active, ...list.recent].find((j) => j.id === job.id);
  // An update that arrives out of order (a slow poll answering after a push) must not repaint a
  // newer state with an older one.
  if (existing && existing.updatedAt > job.updatedAt) return list;
  const active = list.active.filter((j) => j.id !== job.id);
  const recent = list.recent.filter((j) => j.id !== job.id);
  if (isBackgroundJobOpen(job.status)) active.push(job);
  else recent.push(job);
  return { active: active.sort(byNewest), recent: recent.sort(byNewest) };
}

/**
 * Apply one job's new state to every cached list it belongs in — the tray and any page watching its
 * kind and scope — without a refetch. Called for each `job:updated` socket event and for the job a
 * start or cancel just returned.
 */
export function applyJobUpdate(queryClient: QueryClient, job: BackgroundJobSummary): void {
  if (!job?.id) return;
  for (const [key, data] of queryClient.getQueriesData<BackgroundJobList>({ queryKey: jobKeys.all })) {
    if (!data || !matchesKey(key, job)) continue;
    queryClient.setQueryData<BackgroundJobList>(key, mergeJob(data, job));
  }
}
