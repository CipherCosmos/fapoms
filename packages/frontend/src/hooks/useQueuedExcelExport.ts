import { useCallback, useState } from 'react';
import { api } from '../services/api';
import { userMessage } from '../services/errors';

/**
 * Same job the plain `GET /reports/*` download did, run through the queue instead.
 *
 * ## Why this exists next to `useExcelExport`
 *
 * `useExcelExport` still calls the synchronous `GET /reports/*` routes, and it stays exactly as
 * it is — `xlsx.write` is synchronous CPU with no yield point, so for the whole time it runs the
 * process serves nothing else at all (task: measured 5.9s / 1.8GB at 200k rows on the heaviest
 * export). The backend already has a queued POST twin of every one of those routes
 * (`reports.controller.ts` — `POST /reports/<name>/jobs`, `GET /reports/jobs/:jobId`,
 * `GET /reports/jobs/:jobId/download`) that moves the blocking work onto a Bull worker at
 * concurrency 1. This hook is the frontend side of THAT path, and it deliberately keeps the same
 * `{ download, busy }` shape `useExcelExport` has, so a call site swaps the hook and its endpoint
 * (`/reports/assignments` → `/reports/assignments/jobs`) and nothing else about the call changes.
 *
 * ## The three-step flow this hides
 *
 *   1. `POST <endpoint>` with the same query params the old GET took — the same filter contract,
 *      because the job handler is a call to the same `ReportsService` method.
 *   2. Poll `GET /reports/jobs/:jobId` with a growing interval — a poll returns metadata only,
 *      never the file bytes, in case a progress bar is being watched.
 *   3. Once `state === 'done'`, `GET /reports/jobs/:jobId/download` (raw) and save the blob under
 *      the filename the job itself reported, so a queued export produces the exact same
 *      attachment a synchronous one would have.
 *
 * ## Refresh and navigation
 *
 * Every export is also tracked on the server as a `REPORT_EXPORT` job, so the Jobs tray shows it
 * — progress, then a Download button while the file lasts (15 minutes) — with nothing here: after
 * a refresh this hook has forgotten the export, but the tray has not.
 *
 * Navigating to another page does not stop the export either: the poll is deliberately NOT tied to
 * the component's lifetime, so a person who clicks Export and moves on still gets the file (and the
 * page's error toast, if it fails). There is no cancellation flag for the same reason — the one
 * this hook used to have was reset by whichever export finished first, which silently dropped the
 * download of a second export started while the first was running.
 */

/** What `POST /reports/*\/jobs` answers. */
interface EnqueueResult {
  jobId: string;
  deduplicated: boolean;
  /** The tracking row the Jobs tray shows; not needed here. */
  backgroundJobId?: string | null;
}

/** What `GET /reports/jobs/:jobId` answers — a subset of `ReportJobStatus` on the server. */
interface ReportJobStatus {
  jobId: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: { percent: number; stage: string };
  result?: { filename: string; mimeType: string; sizeBytes: number };
  error?: string;
}

/** Fast enough to feel live, cheap enough to hold open. */
const POLL_MS = 2000;

/**
 * Exports finish in seconds to low minutes, not the tens of minutes a spreadsheet import can
 * take, so this ceiling is far tighter than an import's hour — a stuck export should say so
 * quickly rather than leave a disabled button for an hour.
 */
const MAX_POLL_MS = 10 * 60 * 1000;

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function useQueuedExcelExport(): {
  download: (jobsEndpoint: string, params?: Record<string, string | undefined>) => Promise<void>;
  busy: boolean;
} {
  const [busy, setBusy] = useState(false);

  const poll = useCallback(async (jobId: string, startedAt: number): Promise<void> => {
    const status = await api.request<ReportJobStatus>(`/reports/jobs/${jobId}`);

    if (status.state === 'done' && status.result) {
      const blob = await api.request<Blob>(`/reports/jobs/${jobId}/download`, { raw: true });
      saveBlob(blob, status.result.filename);
      return;
    }
    if (status.state === 'failed') {
      throw new Error(status.error ?? 'The export failed without recording a reason.');
    }
    if (Date.now() - startedAt > MAX_POLL_MS) {
      throw new Error(
        'This export has been running for several minutes with no result. It may still finish — try again shortly.',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    return poll(jobId, startedAt);
  }, []);

  const download = useCallback(async (jobsEndpoint: string, params?: Record<string, string | undefined>) => {
    setBusy(true);
    try {
      const query = Object.entries(params ?? {})
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
        .join('&');
      const path = query ? `${jobsEndpoint}?${query}` : jobsEndpoint;

      const enqueued = await api.request<EnqueueResult>(path, { method: 'POST' });
      await poll(enqueued.jobId, Date.now());
    } catch (err) {
      // Re-thrown as a plain Error with the same user-facing sentence `useExcelExport`'s errors
      // get elsewhere in the app, so a call site's existing catch/toast handling needs no change.
      throw new Error(userMessage(err));
    } finally {
      setBusy(false);
    }
  }, [poll]);

  return { download, busy };
}
