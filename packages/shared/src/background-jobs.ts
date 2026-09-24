/**
 * FAPOMS — a piece of work the server accepted and is doing in the background.
 *
 * ## Why this exists
 *
 * A 5,000-branch upload used to be a request: the browser held one connection open while the server
 * parsed, geocoded and wrote every row. It took long enough that proxies and browsers gave up on it,
 * and a refresh lost the only thing on screen that said it was happening — so people uploaded again,
 * and two imports raced over the same rows.
 *
 * A background job is the durable answer. The request stores the file, records a row in
 * `background_jobs` and returns at once. A worker does the work and writes progress onto that row.
 * Every screen — including one opened after a hard refresh, on another tab, or the next morning —
 * reads the row back from the server. Nothing about a job lives only in the browser.
 *
 * These are the words both sides use for it. The server's `BackgroundJobsService` writes them; the
 * web app's Jobs tray and `useBackgroundJob` hook read them.
 */

/**
 * The kinds of background job the system knows about.
 *
 * A kind is declared here (so the web app can name it and link back to the page that owns it) and
 * given a handler on the server (`BackgroundJobRegistry.register`). A kind declared here with no
 * handler registered is refused at creation, never queued to wait forever.
 *
 * The imports come first: their handlers run on the foundation's own queue. The rest run on their
 * feature's queue and are tracked here (see the note in the list).
 */
export const BACKGROUND_JOB_KINDS = [
  'BRANCH_IMPORT',
  'ROSTER_IMPORT',
  'CUSTOMER_MASTER_IMPORT',
  'GENERATED_DOCUMENT_BATCH',
  // ── Work that runs on its feature's own queue and is only TRACKED here ──────────────────────
  // (`BackgroundJobsService.enqueueTracked` + `BackgroundJobTracker`, see `background-job.tracker.ts`
  // on the server). The feature keeps its queue, its concurrency and its duplicate rule; the row is
  // what lets a refreshed page, and the Jobs tray, find the run again.
  'DOCUMENT_DISPATCH',
  'PLANNING_EXECUTE_PLAN',
  'PLANNING_GENERATE_VERSION',
  'PLANNING_BULK_OFFER',
  'PLANNING_BULK_UNABLE_TO_COVER',
  'BILLING_APPROVE_PAYOUTS',
  'BILLING_PAY_PAYOUTS',
  'BILLING_INVITE_ALL_INVOICES',
  'BILLING_FINAL_APPROVAL',
  'BILLING_RECONCILE',
  'WORKFORCE_APP_ACCESS',
  'WORKFORCE_NOTIFY',
  'WORKFORCE_LIFECYCLE',
  'REPORT_EXPORT',
] as const;

export type BackgroundJobKind = (typeof BACKGROUND_JOB_KINDS)[number];

/**
 * Where a job is in its life.
 *
 *  - `QUEUED`          accepted and stored, waiting for a worker.
 *  - `RUNNING`         a worker has it.
 *  - `AWAITING_REVIEW` a rehearsal (dry run) finished and its result needs a person's decision before
 *                      anything is written. It is not in flight, but it is not over either.
 *  - `SUCCEEDED`       done; `result` says what it did.
 *  - `FAILED`          stopped with an error; `error` says why, in words a clerk can act on.
 *  - `CANCELLED`       stopped because somebody asked it to (or a rehearsal was discarded).
 */
export type BackgroundJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'AWAITING_REVIEW'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export const BACKGROUND_JOB_STATUSES: readonly BackgroundJobStatus[] = [
  'QUEUED', 'RUNNING', 'AWAITING_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED',
];

/** A worker has it, or will: show a spinner. */
export function isBackgroundJobInFlight(status: BackgroundJobStatus | null | undefined): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

/**
 * Not over yet — in flight, or waiting on a person. This is what "active" means in the Jobs tray and
 * what a duplicate upload is matched against: re-uploading the file behind a rehearsal that is still
 * waiting for review returns that rehearsal rather than starting a second one.
 */
export function isBackgroundJobOpen(status: BackgroundJobStatus | null | undefined): boolean {
  return isBackgroundJobInFlight(status) || status === 'AWAITING_REVIEW';
}

/** Reached an answer that will not change. */
export function isBackgroundJobSettled(status: BackgroundJobStatus | null | undefined): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

/**
 * What a job is working ON — the record the work belongs to, so a page can ask "is there an upload
 * running for THIS client?" and a duplicate is judged per scope.
 *
 * `type` is an open vocabulary on purpose (`CLIENT`, `PROJECT`, `ROSTER`, ...): a new kind should not
 * need a shared-package release to name what it is scoped to. `id` is null for a scope that is the
 * whole of something (the national roster).
 */
export interface BackgroundJobScope {
  type: string;
  id: string | null;
}

/**
 * How far along it is.
 *
 * Units of work, not only a percent: "1,240 of 5,000 rows" tells the person more than 25%, and a job
 * in its opening phase (reading the file) has a stage to show before it has anything to count.
 */
export interface BackgroundJobProgress {
  /** Units done so far. */
  processed: number;
  /** Units in total, or null while it is not yet known. */
  total: number | null;
  /** 0–100, or null while the total is unknown. Forced to 100 on success. */
  percent: number | null;
  /** The phase, in words — "Reading the file", "Looking up addresses". */
  stage: string;
  /** Anything else worth a line under the bar. */
  message?: string | null;
}

/**
 * What a job did, small enough to live on the row and travel on every update.
 *
 * A row-level report (every skipped row and why) does NOT go here — it goes into a stored file and
 * is fetched once from `GET /jobs/:id/result`. `hasResultFile` on the summary says one exists.
 */
export interface BackgroundJobResult {
  /** One sentence a clerk can read: "4,980 branches imported; 20 skipped." */
  summary: string;
  /** Named counts, for a screen that wants to lay them out: `{ created: 4200, updated: 780 }`. */
  counts?: Record<string, number>;
  /** Anything else small and structured the owning page needs. Keep it small. */
  details?: unknown;
  /**
   * A file the result is fetched from by its FEATURE'S own route, rather than stored on the job
   * (`hasResultFile`). For an export whose bytes deliberately live only briefly (a report workbook
   * kept 15 minutes): the Jobs tray offers it until `expiresAt`, and says it has expired after.
   */
  download?: BackgroundJobDownload;
}

export interface BackgroundJobDownload {
  /** API path, under `/api/v1`, that answers with the file for the person who ran the job. */
  path: string;
  fileName: string;
  /** ISO time after which the file is gone; null when it does not expire. */
  expiresAt: string | null;
}

/** The download link on a result, if it has one and it has not expired. */
export function liveBackgroundJobDownload(
  result: BackgroundJobResult | null | undefined,
  now: number = Date.now(),
): BackgroundJobDownload | null {
  const d = result?.download;
  if (!d?.path) return null;
  if (d.expiresAt && Date.parse(d.expiresAt) <= now) return null;
  return d;
}

/**
 * Whether a job has something a person can download: a stored report that is not the internal
 * review file its page reads (`reviewFileName`), or a feature link that has not expired.
 */
export function backgroundJobHasDownload(
  job: Pick<BackgroundJobSummary, 'kind' | 'hasResultFile' | 'resultFileName' | 'result'>,
  now: number = Date.now(),
): boolean {
  const reviewFile = (BACKGROUND_JOB_KIND_INFO as Record<string, BackgroundJobKindInfo | undefined>)[job.kind]?.reviewFileName;
  const report = job.hasResultFile && !(reviewFile && job.resultFileName === reviewFile);
  return report || !!liveBackgroundJobDownload(job.result, now);
}

/** One job, as every screen sees it. */
export interface BackgroundJobSummary {
  id: string;
  kind: BackgroundJobKind;
  status: BackgroundJobStatus;
  /** What a person would call it — "5,000 branches for SBI". */
  title: string;
  requestedBy: string;
  scopeType: string | null;
  scopeId: string | null;
  progress: BackgroundJobProgress;
  result: BackgroundJobResult | null;
  error: string | null;
  inputFileName: string | null;
  inputSize: number | null;
  /** How many files the job was uploaded with (a batch of documents is several). */
  inputFileCount?: number;
  /** A commit job points at the rehearsal it was reviewed from. */
  parentJobId: string | null;
  /** A cancel was asked for and the worker has not stopped yet. */
  cancelRequested: boolean;
  /**
   * False when this job cannot be stopped now — a run on its feature's own queue that has already
   * started has no checkpoint to stop at. Absent means it can (while it is open).
   */
  cancellable?: boolean;
  /** A report file can be downloaded from `GET /jobs/:id/result`. */
  hasResultFile: boolean;
  resultFileName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** `GET /jobs` answers with the two lists the Jobs tray draws. */
export interface BackgroundJobList {
  /** In flight or awaiting review, newest first. */
  active: BackgroundJobSummary[];
  /** Settled recently, newest first. */
  recent: BackgroundJobSummary[];
}

/** `POST /jobs` (and any kind's own start route) answers 202 with this. */
export interface BackgroundJobAccepted {
  job: BackgroundJobSummary;
  /**
   * The same person had already uploaded the same file for the same thing and it is not finished —
   * this is that job, not a new one.
   */
  deduplicated: boolean;
}

/** The socket event every job update is pushed on, to the requester's own room. */
export const BACKGROUND_JOB_EVENT = 'job:updated';

/**
 * How each kind is named, and where the page that owns it lives.
 *
 * The Jobs tray links every job back to its page, so a job started on the Branches page and watched
 * from anywhere else still leads the person back to where its result means something.
 */
export interface BackgroundJobKindInfo {
  /** Short noun phrase: "Branch import". */
  label: string;
  /** The page to open for a job of this kind. */
  route: (job: Pick<BackgroundJobSummary, 'scopeType' | 'scopeId'>) => string;
  /**
   * A rehearsal of this kind is reviewed on its own page (row by row), so the tray offers
   * "Open page" for it instead of a blind "Go ahead".
   */
  reviewOnPage?: boolean;
  /**
   * The file a rehearsal of this kind stores for its page to read the review back from. It is the
   * page's working copy, not a report for a person, so no screen offers it as a download — while
   * the review waits, nor after it was committed or discarded.
   */
  reviewFileName?: string;
}

export const BACKGROUND_JOB_KIND_INFO: Record<BackgroundJobKind, BackgroundJobKindInfo> = {
  BRANCH_IMPORT: {
    label: 'Branch import',
    // Each page deep-links to the thing the import belongs to: the Branches page reads `?client=`,
    // the Projects page selects `?id=` and opens its Branches tab for `tab=branches`.
    route: (job) => {
      if (job.scopeType === 'PROJECT') {
        return job.scopeId ? `/projects?id=${encodeURIComponent(job.scopeId)}&tab=branches` : '/projects';
      }
      return job.scopeId ? `/branches?client=${encodeURIComponent(job.scopeId)}` : '/branches';
    },
    reviewOnPage: true,
    reviewFileName: 'branch-review.json',
  },
  ROSTER_IMPORT: {
    label: 'Roster import',
    route: () => '/hr/roster',
  },
  CUSTOMER_MASTER_IMPORT: {
    label: 'Customer master import',
    // The Daily Run panel on the Documents page is where the file is uploaded and reconciled.
    route: () => '/documents',
  },
  GENERATED_DOCUMENT_BATCH: {
    label: 'Audit packet upload',
    route: () => '/documents',
  },
  DOCUMENT_DISPATCH: { label: 'Document dispatch', route: () => '/documents' },
  PLANNING_EXECUTE_PLAN: { label: 'Plan execution', route: () => '/planning' },
  PLANNING_GENERATE_VERSION: { label: 'Plan version', route: () => '/planning' },
  PLANNING_BULK_OFFER: { label: 'Bulk offers', route: () => '/planning' },
  PLANNING_BULK_UNABLE_TO_COVER: { label: 'Unable to cover', route: () => '/planning' },
  BILLING_APPROVE_PAYOUTS: { label: 'Payout approval', route: () => '/billing' },
  BILLING_PAY_PAYOUTS: { label: 'Payout payment', route: () => '/billing' },
  BILLING_INVITE_ALL_INVOICES: { label: 'Invoice invitations', route: () => '/billing' },
  BILLING_FINAL_APPROVAL: { label: 'Final approval', route: () => '/billing?tab=final' },
  BILLING_RECONCILE: { label: 'Billing reconciliation', route: () => '/billing' },
  WORKFORCE_APP_ACCESS: { label: 'App access change', route: () => '/hr/roster' },
  WORKFORCE_NOTIFY: { label: 'Workforce message', route: () => '/hr/roster' },
  WORKFORCE_LIFECYCLE: { label: 'Status change', route: () => '/hr/roster' },
  REPORT_EXPORT: {
    label: 'Report export',
    // `scopeType` names the report, so the tray leads back to the page it was exported from.
    route: (job) => REPORT_EXPORT_ROUTES[job.scopeType ?? ''] ?? '/assignments',
  },
};

/** Which page each report export (`REPORT_EXPORT`, `scopeType` = the report) was started from. */
export const REPORT_EXPORT_ROUTES: Record<string, string> = {
  ASSIGNMENTS: '/assignments',
  BILLING: '/billing',
  COMMAND_CENTER: '/executive-map',
  ASSAYER_ROSTER: '/hr/roster',
  ASSAYER_ROSTER_PDF: '/hr/roster',
};

/** The label for any kind, including one this build of the web app has never heard of. */
export function backgroundJobLabel(kind: string): string {
  return (BACKGROUND_JOB_KIND_INFO as Record<string, BackgroundJobKindInfo | undefined>)[kind]?.label
    ?? 'Background job';
}

/** The page that owns a job, or null when this build does not know the kind. */
export function backgroundJobRoute(job: Pick<BackgroundJobSummary, 'kind' | 'scopeType' | 'scopeId'>): string | null {
  const info = (BACKGROUND_JOB_KIND_INFO as Record<string, BackgroundJobKindInfo | undefined>)[job.kind];
  return info ? info.route(job) : null;
}

/** Whether a rehearsal of this kind must be reviewed on its page rather than accepted from the tray. */
export function backgroundJobReviewsOnPage(kind: string): boolean {
  return !!(BACKGROUND_JOB_KIND_INFO as Record<string, BackgroundJobKindInfo | undefined>)[kind]?.reviewOnPage;
}
