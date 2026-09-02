import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';

/**
 * FAPOMS — one way to upload a spreadsheet and watch what happened to it.
 *
 * ## What this replaces
 *
 * Two pages uploaded branch files and each invented its own idea of "done":
 *
 * - **Branches** awaited a request that ran the whole import inline. On the real 3,759-row client
 *   file that is minutes of a frozen page, then usually a timeout — after which the import is
 *   still running on the server, and the operator, told it failed, uploads it again.
 * - **Projects** already got a `202 Accepted` and a job id for a large file, and then ignored it:
 *   with no `meta` in the response it printed *"Branches uploaded."* and stopped. The operator was
 *   told the work was done at the moment it started, with no way to see it finish.
 *
 * Both are the same missing idea — an import is a thing with a lifetime, not a request that
 * returns. This hook models that lifetime once: upload, and if the server queued the file, follow
 * the job it named until it finishes, then report exactly what it did. A small file still finishes
 * inside the request and lands in `done` immediately; the caller does not branch on which happened.
 */

/** Row-level detail, identical for skipped and imprecise rows. */
export interface ImportRowNote {
  row: number;
  solId?: string;
  reason: string;
}

/** What an import did, once it is over. */
export interface ImportReport {
  totalRows: number;
  created: number;
  updated: number;
  /**
   * Rows that matched an existing record and needed no change.
   *
   * `updated` counts only real changes, so re-uploading an unchanged sheet correctly reports
   * `created: 0, updated: 0` — which is indistinguishable from a file whose column headings did
   * not match and from which nothing could be read. Those two need opposite messages.
   */
  unchanged?: number;
  /** Newly attached to a project. Always 0 for an import into a client's branch master. */
  linked?: number;
  skipped: ImportRowNote[];
  /**
   * Rows that imported but landed on a fallback coordinate. Distinct from `skipped` — these
   * branches exist; they simply cannot be planned or checked into until someone corrects where
   * they are, which the operator has to be told while the import is still in front of them.
   */
  imprecise: ImportRowNote[];
  /**
   * Archived branches this file brought back.
   *
   * Shown because a branch reappearing in the estate is a change the operator should see
   * attributed to the file they just uploaded. Optional so an older server, or an importer that
   * has no such notion, simply reports nothing here.
   */
  revived?: ImportRowNote[];
}

/** Live counters while a queued import runs. */
export interface ImportProgress {
  processed: number;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  linked: number;
  skipped: number;
  imprecise: number;
}

/**
 * The one sentence, and the row detail, to show about a finished import.
 *
 * Returned by a per-importer summariser rather than derived in the panel, because the branch
 * importer and the roster importer report genuinely different things — branches have imprecise
 * coordinates, a roster has references and background checks. What they share is the *shape* of
 * the answer: a verdict, a sentence, and named rows worth expanding.
 */
export interface ImportSummary {
  tone: 'success' | 'warning' | 'error';
  text: string;
  /** Extra lines shown under the sentence — one fact each, not a paragraph. */
  notes?: string[];
  /** Row-level detail, each group behind its own disclosure. */
  sections?: { label: string; rows: ImportRowNote[] }[];
}

export type ImportPhase<TReport = ImportReport> =
  /** Nothing has been uploaded in this session. */
  | { phase: 'idle' }
  /** The file is on its way; the server has not answered yet. */
  | { phase: 'uploading'; fileName: string }
  /** Accepted and queued. `progress` is null until the worker reports its first batch. */
  | { phase: 'running'; fileName: string; jobId: string; progress: ImportProgress | null; totalRows: number; message: string }
  /** Over, successfully. `report` says what it did — including the rows it could not use. */
  | { phase: 'done'; fileName: string; report: TReport }
  /** Over, unsuccessfully. `error` is already a sentence an operator can act on. */
  | { phase: 'error'; fileName: string; error: string };

/** The 202 body the server sends when it queues a file. */
interface QueuedResponse {
  jobId: string;
  queued: true;
  statusUrl: string;
  totalRows: number;
  message: string;
}

/** The poll response for a queued job. */
interface JobStatus<TReport> {
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'stuck' | 'unknown';
  progress: ImportProgress | null;
  result: TReport | null;
  error: string | null;
  totalRows: number;
}

/**
 * How often to ask the server how far it has got.
 *
 * Two seconds is fast enough that the bar visibly moves on an import doing roughly one geocode a
 * second, and slow enough that a twenty-minute job is ~600 requests rather than ~12,000. The poll
 * reads one Bull job from Redis, so it is cheap, but it is not free and there may be several
 * operators watching.
 */
const POLL_MS = 2000;

/**
 * Stop polling eventually, even if the server never resolves the job.
 *
 * A worker that dies mid-job leaves the job `active` forever from the client's point of view. An
 * infinite poll would spin for as long as the tab stays open and, worse, would show a progress bar
 * that never moves as though the work were merely slow.
 */
const MAX_POLL_MS = 60 * 60 * 1000;

const isQueued = (body: unknown): body is QueuedResponse =>
  !!body && typeof body === 'object' && (body as QueuedResponse).queued === true
  && typeof (body as QueuedResponse).jobId === 'string';

export function useImportJob<TReport = ImportReport>() {
  const [state, setState] = useState<ImportPhase<TReport>>({ phase: 'idle' });

  /**
   * Cleared on unmount so a poll cannot call `setState` on a page the operator has navigated away
   * from, and cannot keep hitting the server for a job nobody is watching any more.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => {
    cancelled.current = true;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const poll = useCallback(async (fileName: string, statusUrl: string, jobId: string, startedAt: number) => {
    if (cancelled.current) return;

    try {
      const status = await api.request<JobStatus<TReport>>(statusUrl);

      if (cancelled.current) return;

      if (status.state === 'completed' && status.result) {
        setState({ phase: 'done', fileName, report: status.result });
        return;
      }
      if (status.state === 'failed') {
        setState({
          phase: 'error',
          fileName,
          error: status.error ?? 'The import failed without recording a reason.',
        });
        return;
      }
      if (Date.now() - startedAt > MAX_POLL_MS) {
        setState({
          phase: 'error',
          fileName,
          error:
            'This import has been running for over an hour with no result. It may still finish — '
            + 'check the branch list before uploading the file again, so it is not imported twice.',
        });
        return;
      }

      setState((prev) =>
        prev.phase === 'running'
          ? { ...prev, progress: status.progress, totalRows: status.totalRows || prev.totalRows }
          : prev,
      );
      timer.current = setTimeout(() => void poll(fileName, statusUrl, jobId, startedAt), POLL_MS);
    } catch (err) {
      if (cancelled.current) return;
      /**
       * A failed poll is not a failed import.
       *
       * The job keeps running on the server whatever happens to this tab's network, so a dropped
       * poll is retried rather than reported — telling the operator the import failed because a
       * status check did would be the same lie the old timeout told, from the other direction.
       * The hour cap above is what eventually ends it.
       */
      if (Date.now() - startedAt > MAX_POLL_MS) {
        setState({ phase: 'error', fileName, error: userMessage(err) });
        return;
      }
      timer.current = setTimeout(() => void poll(fileName, statusUrl, jobId, startedAt), POLL_MS);
    }
  }, []);

  /**
   * Upload a file and follow it to the end.
   *
   * @param url The import endpoint. It must answer either a report (small file, done inside the
   *   request) or a 202 carrying `jobId` and `statusUrl` — which every import endpoint does,
   *   because they all route through the same `ImportJobService`.
   */
  const start = useCallback(async (url: string, file: File) => {
    if (timer.current) clearTimeout(timer.current);
    cancelled.current = false;
    setState({ phase: 'uploading', fileName: file.name });

    const body = new FormData();
    body.append('file', file);

    try {
      const res = await api.request<QueuedResponse | TReport>(url, { method: 'POST', body });

      if (isQueued(res)) {
        setState({
          phase: 'running',
          fileName: file.name,
          jobId: res.jobId,
          progress: null,
          totalRows: res.totalRows,
          message: res.message,
        });
        void poll(file.name, res.statusUrl, res.jobId, Date.now());
        return;
      }

      setState({ phase: 'done', fileName: file.name, report: res as TReport });
    } catch (err) {
      setState({ phase: 'error', fileName: file.name, error: userMessage(err) });
    }
  }, [poll]);

  /** Dismiss the result panel and stop any poll still in flight. */
  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    cancelled.current = true;
    setState({ phase: 'idle' });
  }, []);

  /** True while the operator should not be starting a second import of the same thing. */
  const busy = state.phase === 'uploading' || state.phase === 'running';

  return { state, start, reset, busy };
}

/**
 * The one sentence to show an operator about a finished import.
 *
 * Written here rather than in each page because the two pages had drifted into saying different
 * things about the same outcome — one reported "Successfully imported 3759 branches" for a file
 * that had also silently dropped four rows, the other reported success for a file from which
 * nothing at all had been imported.
 */
export function summariseImport(report: ImportReport): ImportSummary {
  const { totalRows, created, updated, skipped, imprecise } = report;
  const linked = report.linked ?? 0;
  const unchanged = report.unchanged ?? 0;
  const recognised = created + updated + unchanged;

  if (recognised === 0 && skipped.length === 0) {
    /**
     * Rows were read, none matched anything and none produced a record, and nothing was even
     * refused with a reason — which is what a sheet with the wrong column headings looks like from
     * here. Reported as a failure, because announcing "0 created, 0 updated" in green tells the
     * operator their upload worked when their file was in fact ignored wholesale.
     */
    return {
      tone: 'error',
      text:
        `Nothing was imported. ${totalRows} row(s) were read but no branch could be built from `
        + 'them — the column headings probably do not match. Download the template and use its headings.',
    };
  }

  if (created === 0 && updated === 0 && skipped.length === 0) {
    /**
     * Every row matched an existing branch and none of them differed. A real and common outcome —
     * re-uploading the same sheet to check it landed — and the one the branch above would
     * otherwise have reported as "your column headings are wrong".
     */
    return {
      tone: 'success',
      text: `Already up to date. All ${unchanged} branch(es) in this file match what is on record; nothing needed changing.`,
    };
  }

  const parts = [`${created} created`, `${updated} updated`];
  if (unchanged > 0) parts.push(`${unchanged} already up to date`);
  // Named in the headline, not just in a disclosure: restoring an archived branch puts it back in
  // every list and every plan, which is not something to discover by expanding a section.
  if ((report.revived ?? []).length > 0) parts.push(`${report.revived!.length} archived branch(es) restored`);
  if (linked > 0) parts.push(`${linked} newly linked to this project`);
  const head = `${totalRows} row(s) read: ${parts.join(', ')}.`;

  if (skipped.length > 0) {
    const detail = skipped.slice(0, 5).map((s) => `row ${s.row}: ${s.reason}`).join('; ');
    return {
      tone: 'error',
      text: `${head} ${skipped.length} row(s) could not be used — ${detail}${skipped.length > 5 ? '…' : ''}`,
      sections: rowSections(report),
    };
  }

  if (imprecise.length > 0) {
    const detail = imprecise.slice(0, 3).map((v) => `row ${v.row}: ${v.reason}`).join('; ');
    return {
      tone: 'warning',
      text:
        `${head} ${imprecise.length} branch(es) could not be located precisely — ${detail}`
        + `${imprecise.length > 3 ? '…' : ''}`,
      sections: rowSections(report),
    };
  }

  return { tone: 'success', text: head, sections: rowSections(report) };
}

/**
 * The rows worth naming, grouped.
 *
 * A count on its own ("12 skipped") sends an operator back to a 3,759-row sheet with no idea which
 * rows or why, which is what both upload screens used to do.
 */
function rowSections(report: ImportReport): ImportSummary['sections'] {
  const sections: NonNullable<ImportSummary['sections']> = [];
  if (report.skipped.length > 0) {
    sections.push({ label: `Show the ${report.skipped.length} row(s) that could not be used`, rows: report.skipped });
  }
  if (report.imprecise.length > 0) {
    sections.push({
      label: `Show the ${report.imprecise.length} branch(es) that need their location corrected`,
      rows: report.imprecise,
    });
  }
  const revived = report.revived ?? [];
  if (revived.length > 0) {
    sections.push({
      label: `Show the ${revived.length} archived branch(es) this file restored`,
      rows: revived,
    });
  }
  return sections.length ? sections : undefined;
}
