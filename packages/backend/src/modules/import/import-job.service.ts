/**
 * FAPOMS — enqueuing and polling spreadsheet imports.
 *
 * ## The problem this solves
 *
 * `uploadBranchesFromExcel` runs inside the HTTP request. Per row it may geocode, and the free
 * OSM tiers are rate-limited by their providers to roughly one lookup per second (see
 * `politely()` in geo/osm-geocoder.ts). A 400-row client file is therefore about seven minutes;
 * a 2,000-branch file is between 17 minutes and two and a half hours. `main.ts` sets
 * `requestTimeout` to 300 seconds, so the socket dies long before the import finishes — but the
 * server keeps going, having told the operator nothing. What that looks like from the operator's
 * chair is an upload that "failed", so they upload again, and now two imports are geocoding the
 * same file concurrently against a provider that bans by IP.
 *
 * Moving the work to a queue makes the outcome observable: the request accepts the file, says
 * where to watch, and returns. Nothing is held open, nothing times out, and a retry is a
 * deliberate act rather than the operator's only available guess.
 */

import { Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { JobOptions, Queue } from 'bull';

import { IMPORT_QUEUE, BRANCH_IMPORT_JOB, ROSTER_IMPORT_JOB } from './import.constants';
import {
  BranchImportOutcome,
  BranchImportProgress,
  ImportScope,
  importScopeEquals,
} from './import.contract';

/**
 * What the worker needs to run a branch import.
 *
 * The workbook travels as base64 inside the job payload. The alternative — writing it to disk
 * and passing a path — only works while the producer and the consumer are the same container,
 * which is exactly the assumption `PROCESS_ROLE=api` exists to break. Redis is the one place
 * both roles can already reach. `MAX_QUEUED_FILE_BYTES` keeps that honest.
 */
export interface BranchImportJobData {
  /**
   * What the sheet is being loaded into — a project, or a client's branch master.
   *
   * This was `projectId: string`, which is why the client-scoped Branches page could not use the
   * queue at all and ran its own inline importer instead.
   */
  scope: ImportScope;
  /**
   * The pre-scope field, still read when present.
   *
   * A job enqueued by the previous build is sitting in Redis with `projectId` and no `scope`, and
   * `attempts: 1` means nothing will re-create it. Reading both shapes costs one line and keeps a
   * deploy from silently dropping an import that is already paid for.
   *
   * @deprecated Use `scope`. Remove once no job older than the retention window can exist.
   */
  projectId?: string;
  userId: string;
  /** The workbook, base64-encoded. */
  fileBase64: string;
  /** Shown back to the operator while they wait, so they can tell two uploads apart. */
  fileName: string | null;
  /** Measured during preflight, so the poll endpoint can show a denominator before row one. */
  totalRows: number;
  rowsNeedingGeocode: number;
}

/**
 * What the worker needs to run a roster import.
 *
 * Scoped to the person who uploaded it rather than to a project or client: the appraiser roster is
 * one national list, so there is no narrower owner to check a job id against.
 */
export interface RosterImportJobData {
  actorId: string;
  /** The workbook, base64-encoded — same reasoning as `BranchImportJobData`. */
  fileBase64: string;
  fileName: string | null;
  totalRows: number;
  /** An explicit sheet, when the caller knows better than the reader's own scoring. */
  sheetName: string | null;
}

/** Bull's own job states, plus the case where the job is gone. */
export type ImportJobState =
  | 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'stuck' | 'unknown';

/**
 * Generic over what the job reports, because the queue now carries more than one kind of import.
 *
 * The defaults keep every existing branch-import caller reading exactly what it read before.
 */
export interface ImportJobStatus<TProgress = BranchImportProgress, TResult = BranchImportOutcome> {
  jobId: string;
  state: ImportJobState;
  /** Null until the worker has processed its first batch of rows. */
  progress: TProgress | null;
  /** Populated only once `state` is `completed`. */
  result: TResult | null;
  /** Populated only once `state` is `failed`. */
  error: string | null;
  fileName: string | null;
  totalRows: number;
  /**
   * Rows that will each cost a rate-limited geocode — the honest basis for "this will take a
   * while", and the reason the import was queued rather than run inline.
   */
  rowsNeedingGeocode: number;
  enqueuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

@Injectable()
export class ImportJobService {
  private readonly logger = new Logger(ImportJobService.name);

  constructor(@InjectQueue(IMPORT_QUEUE) private readonly queue: Queue) {}

  /**
   * Above this many geocoded rows, the import goes to the queue.
   *
   * Counted in *geocodes*, not rows, because that is what actually costs time: 2,000 rows that
   * carry their own Latitude/Longitude never touch the network, while 60 rows without them is a
   * minute of held-open socket. 25 lookups is roughly 30 seconds — comfortably inside any
   * reasonable client timeout, and the point past which an operator starts wondering whether the
   * page has hung.
   */
  static get syncGeocodeLimit(): number {
    return Number(process.env.BRANCH_IMPORT_SYNC_GEOCODE_LIMIT) || 25;
  }

  /**
   * And above this many rows regardless, because the database work alone adds up.
   *
   * Even fully-located rows still write a branch, a project_branch and an assessment each. 200 is
   * about a second or two of pure database work; past that the request is worth deferring even
   * though nothing is being geocoded.
   */
  static get syncRowLimit(): number {
    return Number(process.env.BRANCH_IMPORT_SYNC_ROW_LIMIT) || 200;
  }

  /**
   * A ceiling on what may be parked in Redis.
   *
   * Base64 inflates by a third, and Redis holds the payload for the life of the job plus its
   * retention window. 10 MB of xlsx is far more than any branch list this platform has ever been
   * sent (the largest real client file is a few hundred kilobytes), so this only ever fires on a
   * mistake — and refusing it with a clear message beats filling Redis and taking the queue,
   * notifications and the throttler down with it.
   */
  static readonly MAX_QUEUED_FILE_BYTES = 10 * 1024 * 1024;

  /**
   * Retention, deliberately bounded on both axes.
   *
   * `removeOnComplete: false` keeps every job forever, and these jobs each carry a whole
   * workbook. A month of daily imports would sit in Redis as tens of megabytes of base64 nobody
   * will ever read again. Bounding by age *and* count means a burst of imports cannot outrun the
   * age window, and a quiet month cannot leave a stale pile behind.
   *
   * This queue was the first to bound retention, when unbounded was still the house default;
   * it is now the house rule instead — `BullQueueManager`, the `ocr` queue, the repeatable
   * schedules, geo-precision, planning, reports and billing all bound both axes.
   *
   * Failures are kept far longer than successes on purpose: a failed import is the one an
   * operator will ask about tomorrow, and its `failedReason` is the only record of why.
   */
  static readonly JOB_OPTIONS: JobOptions = {
    /**
     * One attempt, no automatic retry.
     *
     * The import is upsert-shaped, so a blind retry would not corrupt anything — but it would
     * silently re-geocode the entire file, which is the twenty-minute part, to re-apply writes
     * that already landed. Worse, it would do so without telling anyone, which is the exact
     * failure this whole change exists to end. A failed import reports which rows landed and
     * which did not; re-uploading is then a decision the operator makes with that in front of
     * them.
     *
     * Note this does not cover a worker that dies mid-job: Bull's stalled-job detection will
     * re-deliver that one independently of `attempts`.
     */
    attempts: 1,
    removeOnComplete: { age: 24 * 60 * 60, count: 200 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 200 },
  };

  /**
   * Whether a file of this shape should be queued rather than run in the request.
   *
   * Kept here rather than in the controller so the threshold and the reason for it live next to
   * the queue they route to.
   */
  static shouldQueue(preflight: { totalRows: number; rowsNeedingGeocode: number }): boolean {
    return (
      preflight.rowsNeedingGeocode > ImportJobService.syncGeocodeLimit ||
      preflight.totalRows > ImportJobService.syncRowLimit
    );
  }

  /**
   * Read a job's scope, tolerating a payload written before scopes existed.
   *
   * Exported as a static so the worker reads it the same way the status endpoint does; two
   * hand-written `?? { kind: 'PROJECT' }` fallbacks would be one more place for the two sides of a
   * queue to drift apart.
   */
  static scopeOf(data: BranchImportJobData | undefined): ImportScope | null {
    if (!data) return null;
    if (data.scope?.kind && data.scope?.id) return data.scope;
    return data.projectId ? { kind: 'PROJECT', id: data.projectId } : null;
  }

  async enqueueBranchImport(params: {
    scope: ImportScope;
    userId: string;
    fileBuffer: Buffer;
    fileName?: string | null;
    totalRows: number;
    rowsNeedingGeocode: number;
  }): Promise<ImportJobStatus> {
    if (params.fileBuffer.length > ImportJobService.MAX_QUEUED_FILE_BYTES) {
      throw new PayloadTooLargeException(
        `This file is ${Math.round(params.fileBuffer.length / (1024 * 1024))} MB, which is larger than the ` +
          `${ImportJobService.MAX_QUEUED_FILE_BYTES / (1024 * 1024)} MB an import may be. Split it into smaller files and upload them one at a time.`,
      );
    }

    const data: BranchImportJobData = {
      scope: params.scope,
      userId: params.userId,
      fileBase64: params.fileBuffer.toString('base64'),
      fileName: params.fileName ?? null,
      totalRows: params.totalRows,
      rowsNeedingGeocode: params.rowsNeedingGeocode,
    };

    const job = await this.queue.add(BRANCH_IMPORT_JOB, data, ImportJobService.JOB_OPTIONS);
    this.logger.log(
      `Queued branch import job ${job.id} for ${params.scope.kind.toLowerCase()} ${params.scope.id}: ` +
        `${params.totalRows} row(s), ${params.rowsNeedingGeocode} needing a geocode.`,
    );

    return {
      jobId: String(job.id),
      state: 'waiting',
      progress: null,
      result: null,
      error: null,
      fileName: data.fileName,
      totalRows: data.totalRows,
      rowsNeedingGeocode: data.rowsNeedingGeocode,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
  }

  /**
   * Queue an appraiser-roster import.
   *
   * The roster import writes a person plus their references, background checks, documents and
   * empanelments — thousands of rows for a full roster — and geocodes each home address. It ran
   * inside the request, and the web client compensated with a **fifteen-minute** upload timeout: a
   * page held open for a quarter of an hour, with nothing to look at and no way to tell a slow
   * import from a dead one. Same queue, same reasoning as the branch import.
   *
   * There is no size threshold here, unlike branches: a roster row is expensive whatever the row
   * count, and the rehearsal (`dryRun`) is what the operator waits for interactively.
   */
  async enqueueRosterImport(params: {
    actorId: string;
    fileBuffer: Buffer;
    fileName?: string | null;
    totalRows: number;
    sheetName?: string | null;
  }): Promise<ImportJobStatus<never, unknown>> {
    if (params.fileBuffer.length > ImportJobService.MAX_QUEUED_FILE_BYTES) {
      throw new PayloadTooLargeException(
        `This file is ${Math.round(params.fileBuffer.length / (1024 * 1024))} MB, which is larger than the ` +
          `${ImportJobService.MAX_QUEUED_FILE_BYTES / (1024 * 1024)} MB an import may be. Split it into smaller files and upload them one at a time.`,
      );
    }

    const data: RosterImportJobData = {
      actorId: params.actorId,
      fileBase64: params.fileBuffer.toString('base64'),
      fileName: params.fileName ?? null,
      totalRows: params.totalRows,
      sheetName: params.sheetName ?? null,
    };

    const job = await this.queue.add(ROSTER_IMPORT_JOB, data, ImportJobService.JOB_OPTIONS);
    this.logger.log(`Queued roster import job ${job.id}: ${params.totalRows} row(s).`);

    return {
      jobId: String(job.id),
      state: 'waiting',
      progress: null,
      result: null,
      error: null,
      fileName: data.fileName,
      totalRows: data.totalRows,
      rowsNeedingGeocode: 0,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
  }

  /**
   * Read a roster import job's state.
   *
   * @param actorId The user who started it. Roster jobs are not scoped to a project or a client —
   *   the roster is one national list — so the ownership check is the person who uploaded the
   *   file. Without it, Bull's incrementing job ids would let anyone who may import a roster read
   *   any other import's result, which names real people, their PANs and their addresses.
   */
  async getRosterImportStatus(actorId: string, jobId: string): Promise<ImportJobStatus<never, unknown>> {
    const job = await this.queue.getJob(jobId);
    const data = job?.data as RosterImportJobData | undefined;

    if (!job || !data || data.actorId !== actorId) {
      throw new NotFoundException(
        `Import job ${jobId} was not found. Jobs are kept for 24 hours after they finish ` +
          `(7 days if they failed), so an older one will have been cleared.`,
      );
    }

    const state = (await job.getState()) as ImportJobState;

    return {
      jobId: String(job.id),
      state: state ?? 'unknown',
      // The roster importer reports once, at the end: its work per row spans five tables inside one
      // transaction, so there is no partial count that means anything until the commit.
      progress: null,
      result: state === 'completed' ? ((job.returnvalue as unknown) ?? null) : null,
      error: state === 'failed' ? (job.failedReason ?? 'The import failed without recording a reason.') : null,
      fileName: data.fileName,
      totalRows: data.totalRows,
      rowsNeedingGeocode: 0,
      enqueuedAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    };
  }

  /**
   * Read one import job's state.
   *
   * @param scope The project or client the caller reached this job through. Checked against the
   *   job's own payload rather than trusted, because Bull job ids are a per-queue incrementing
   *   integer: without this, anyone who may read one project could walk `1, 2, 3…` and pull back
   *   other projects' import results — which name real branches, addresses and failure reasons.
   *   The kind is part of the comparison, not just the id, so a client id can never be used to
   *   read a project's job by coincidence of both being UUIDs. A mismatch is reported as "not
   *   found" rather than "forbidden", so the response cannot be used to confirm that some other
   *   scope's job id exists.
   */
  async getBranchImportStatus(scope: ImportScope, jobId: string): Promise<ImportJobStatus> {
    const job = await this.queue.getJob(jobId);
    const data = job?.data as BranchImportJobData | undefined;
    const jobScope = ImportJobService.scopeOf(data);

    if (!job || !data || !jobScope || !importScopeEquals(jobScope, scope)) {
      throw new NotFoundException(
        `Import job ${jobId} was not found here. Jobs are kept for 24 hours after they ` +
          `finish (7 days if they failed), so an older one will have been cleared.`,
      );
    }

    // `getState()` reads Redis; everything else below is already on the job object.
    const state = (await job.getState()) as ImportJobState;
    const rawProgress = job.progress();

    return {
      jobId: String(job.id),
      // Bull reports a job it cannot classify as 'stuck'; anything else unexpected is 'unknown'
      // rather than passed through, so the client has a closed set of states to render.
      state: state ?? 'unknown',
      // Bull's `progress()` returns 0 for a job that has never reported, which is not a progress
      // object — hand back null so the caller renders "not started" rather than a bogus zero row.
      progress: rawProgress && typeof rawProgress === 'object' ? (rawProgress as BranchImportProgress) : null,
      result: state === 'completed' ? ((job.returnvalue as BranchImportOutcome) ?? null) : null,
      error: state === 'failed' ? (job.failedReason ?? 'The import failed without recording a reason.') : null,
      fileName: data.fileName,
      totalRows: data.totalRows,
      rowsNeedingGeocode: data.rowsNeedingGeocode,
      enqueuedAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    };
  }
}
