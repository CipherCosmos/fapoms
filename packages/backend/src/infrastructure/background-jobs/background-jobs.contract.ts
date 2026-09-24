/**
 * FAPOMS — the contract a background-job HANDLER is written against.
 *
 * ## The shape of it
 *
 * A kind is registered once, at module init, with a definition:
 *
 * ```ts
 * @Injectable()
 * export class BranchImportJob implements OnModuleInit {
 *   constructor(private readonly registry: BackgroundJobRegistry, private readonly importer: ...) {}
 *
 *   onModuleInit() {
 *     this.registry.register<BranchImportParams>({
 *       kind: 'BRANCH_IMPORT',
 *       input: 'required',
 *       idempotent: true,          // re-running from the top after a crash converges on the same rows
 *       exclusive: 'scope',        // one import per client at a time; different clients run side by side
 *       start: { permissions: ['branch:create:organization'] },   // may be started from POST /jobs
 *       prepare: async ({ file, scope, globalScope }) => {         // in the REQUEST: refuse early
 *         const rows = await this.importer.preflight(await file!.read());
 *         return { title: `${rows} branches for ${clientName}`, total: rows };
 *       },
 *       run: async (ctx) => {                                      // in the WORKER
 *         const buffer = await ctx.readInput();
 *         for (const [i, chunk] of chunks(buffer).entries()) {
 *           await ctx.throwIfCancelled();                          // between chunks, never mid-write
 *           await this.importer.importChunk(chunk);
 *           await ctx.progress(i * CHUNK, total, 'Importing branches');
 *         }
 *         await ctx.attachReport('skipped-rows.xlsx', reportBuffer, XLSX_MIME);
 *         return succeed({ summary: '4,980 imported; 20 skipped', counts: { created, skipped } });
 *       },
 *     });
 *   }
 * }
 * ```
 *
 * Everything else — storing the upload, the row, dedupe, the queue, progress writes, socket pushes,
 * the actor's request context, cancellation, restart recovery, retention — is the foundation's job
 * and is written once, in `BackgroundJobsService` and `BackgroundJobRunner`.
 *
 * ## The rules a handler must keep
 *
 *  1. **Never trust the process to live to the end.** A deploy or an out-of-memory kill can stop a
 *     run at any line. Declare `idempotent: true` only if running again from the top converges on
 *     the same state; otherwise an interrupted run is FAILED with "interrupted — please retry" and a
 *     person decides.
 *  2. **Check for cancellation between units of work, never inside one.** `throwIfCancelled()` is
 *     cheap (it reads the row at most every two seconds); call it at every chunk boundary.
 *  3. **Keep `result` small.** A sentence, some counts. Row-level detail goes in `attachReport`.
 *  4. **Throw to fail.** The message of what you throw is what the person reads, so write it for
 *     them. A stack trace is never shown.
 */

import type { Readable } from 'stream';
import type {
  BackgroundJobKind, BackgroundJobResult, BackgroundJobScope, BackgroundJobSummary,
} from '@fapoms/shared';
import type { JobActor } from '../queue/job-actor';
import type { GlobalScope } from '../scope/global-scope';

/** The Bull queue every background job is woken on. NOT `background-jobs` — that name is the legacy generic queue's. */
export const TRACKED_JOBS_QUEUE = 'tracked-jobs';

/** What the Bull job carries: the row id, and nothing else. Never file bytes, never parameters. */
export interface TrackedJobData {
  backgroundJobId: string;
}

/** The event published on every change to a row; the gateway routes it to the requester's room. */
export const JOB_UPDATED_EVENT = 'job:updated';

/**
 * Which jobs of a kind may not run at the same time.
 *
 *  - `none`  — any number at once (the queue's own concurrency is the only bound).
 *  - `kind`  — one of this kind at a time, system-wide.
 *  - `scope` — one of this kind per scope (per client, per project) at a time.
 *
 * Enforced by a unique index over RUNNING rows, not by a check in code: two workers that both
 * "checked first" would both start. A job that cannot start yet is put back on the queue with a
 * short delay and shows "Waiting for another … to finish".
 */
export type BackgroundJobExclusivity = 'none' | 'kind' | 'scope';

/** An uploaded file, as `prepare` sees it — still on this API replica's disk (or in memory). */
export interface PreparedInputFile {
  originalName: string;
  mimeType: string | null;
  size: number;
  sha256: string;
  /** The whole file in memory. Fine for a spreadsheet; use `stream()` for anything that may be large. */
  read(): Promise<Buffer>;
  stream(): Readable;
}

export interface PrepareContext<P> {
  kind: BackgroundJobKind;
  actor: JobActor;
  /** The requester's regions, null when unrestricted. */
  regions: string[] | null;
  /** The region/client scope resolved for this request, when the caller's route supplied one. */
  globalScope?: GlobalScope;
  scope: BackgroundJobScope | null;
  params: P;
  file: PreparedInputFile | null;
  /** Every file of a several-file upload (`input: 'files'`), in upload order; empty otherwise. */
  files: PreparedInputFile[];
  /** The rehearsal this commit was reviewed from, when there is one. */
  parent: BackgroundJobSummary | null;
}

/** What `prepare` may say about the job before it is accepted. */
export interface PrepareOutcome {
  /** What a person would call it. Defaults to the kind's label plus the file name. */
  title?: string;
  /** The denominator, when the request already knows it (rows counted in a preflight). */
  total?: number;
  /** The first stage shown while it waits for a worker. */
  stage?: string;
}

export interface RunContext<P> {
  job: BackgroundJobSummary;
  kind: BackgroundJobKind;
  params: P;
  actor: JobActor;
  regions: string[] | null;
  scope: BackgroundJobScope | null;
  /** 1 on the first run; higher when an idempotent kind is re-run after an interruption. */
  attempt: number;

  /** The uploaded file (or the rehearsal's file, for a commit), streamed from object storage. */
  openInput(): Promise<Readable>;
  /** The same, buffered. */
  readInput(): Promise<Buffer>;

  /**
   * Every file of a several-file upload (`input: 'files'`), in upload order, each streamed from
   * object storage on demand — so a hundred PDFs are never all in memory at once. Empty for any
   * other kind.
   */
  inputFiles: ReadonlyArray<RunInputFile>;

  /**
   * Report progress in units of work. Throttled: written to the row and pushed to the screen at most
   * about once a second, or immediately when the stage changes or the last unit is done. Awaiting it
   * in a per-row loop costs a function call on most iterations.
   */
  progress(processed: number, total: number | null, stage?: string, message?: string | null): Promise<void>;
  /** Change the stage label now, whatever the throttle says. */
  stage(stage: string, message?: string | null): Promise<void>;

  /** Throws `BackgroundJobCancelledError` if someone asked this job to stop. Call between chunks. */
  throwIfCancelled(): Promise<void>;
  /** The same question without throwing, for a handler that wants to wind down its own way. */
  isCancelRequested(): Promise<boolean>;

  /**
   * Store a row-level report (skipped rows, a reconciliation sheet) as this job's downloadable
   * result. The last one attached wins.
   */
  attachReport(fileName: string, content: Buffer | Readable, mimeType: string): Promise<void>;
}

/** One file of a several-file upload, as a handler sees it in the worker. */
export interface RunInputFile {
  /** Position in the upload, from 0. */
  index: number;
  fileName: string;
  mimeType: string | null;
  size: number;
  sha256: string;
  open(): Promise<Readable>;
  read(): Promise<Buffer>;
}

/** How a run ended, when it did not throw. Build it with `succeed` or `awaitReview`. */
export interface RunOutcome {
  status: 'SUCCEEDED' | 'AWAITING_REVIEW';
  result: BackgroundJobResult;
}

/** The work is done. */
export const succeed = (result: BackgroundJobResult): RunOutcome => ({ status: 'SUCCEEDED', result });

/**
 * A rehearsal finished and a person must decide. The row waits in AWAITING_REVIEW until they either
 * commit it (`BackgroundJobsService.commitReviewed`, which starts a child job over the same file) or
 * discard it (cancel).
 */
export const awaitReview = (result: BackgroundJobResult): RunOutcome => ({ status: 'AWAITING_REVIEW', result });

/**
 * Thrown by `throwIfCancelled`. A handler may also throw it itself, with whatever it managed to do,
 * so a cancelled run still says how far it got.
 */
export class BackgroundJobCancelledError extends Error {
  constructor(readonly partial?: BackgroundJobResult) {
    super('Cancelled.');
    this.name = 'BackgroundJobCancelledError';
  }
}

/** Who may start a kind through the generic `POST /jobs`. */
export interface BackgroundJobStartPolicy {
  /**
   * Every permission listed is required (`resource:action:scope`, as `@RequirePermissions` takes
   * them, PLATFORM implying narrower scopes). Checked against the live principal in the request.
   */
  permissions: string[];
}

export interface BackgroundJobDefinition<P = Record<string, unknown>> {
  kind: BackgroundJobKind;

  /**
   * Whether the job takes an uploaded file. `required` refuses a start without one. `files` takes
   * ONE OR MORE files in one upload (`CreateJobRequest.files`), each stored on its own and handed to
   * the run as `inputFiles` — for a drop of many documents, where zipping them in the browser would
   * only add a format to unpack (and to police for zip bombs and path tricks) on the server.
   */
  input: 'required' | 'optional' | 'none' | 'files';

  /** Safe to run again from the top after a worker died mid-run. See rule 1 above. */
  idempotent: boolean;

  /**
   * What the person reads when a run of a NON-idempotent kind is interrupted (the worker died
   * mid-run) and is failed rather than re-run. Defaults to the generic "interrupted — please retry";
   * a kind whose retry could double something should say where to look first.
   */
  interruptedMessage?: string;

  exclusive: BackgroundJobExclusivity;

  /**
   * Present → the kind may be started through `POST /jobs` by a caller holding these permissions.
   * Absent → only the kind's own controller can start it (by calling `BackgroundJobsService.create`
   * after its own guards), and `POST /jobs` refuses it.
   */
  start?: BackgroundJobStartPolicy;

  /**
   * Runs in the REQUEST, before anything is stored. Validate parameters, check the caller may act
   * on this scope and its rows' regions, preflight the file. Throw an HttpException to refuse — its
   * message goes straight back to the person. Never write anything here.
   */
  prepare?(ctx: PrepareContext<P>): Promise<PrepareOutcome | void>;

  /** Runs in the WORKER, inside the requester's context (`runAsJobActor`). */
  run(ctx: RunContext<P>): Promise<RunOutcome>;
}
