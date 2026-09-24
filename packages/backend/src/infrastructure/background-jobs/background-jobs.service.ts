/**
 * FAPOMS — starting, reading and stopping background jobs.
 *
 * ## The promise this keeps
 *
 * An upload is answered the moment its bytes are safe: the file is in object storage, a row in
 * `background_jobs` says what it is, and a Bull job carrying only that row's id is on the queue.
 * From then on nothing depends on the browser — a refresh, a hard refresh, a closed laptop — because
 * every screen rebuilds what it shows from the row (`GET /jobs`), and every change to the row is
 * pushed to the requester's socket room as `job:updated`.
 *
 * ## Order matters, and it is deliberate
 *
 * File first, then row, then queue. A file stored with no row is an orphan the orphan report finds;
 * a row with no file would be a job that can never run; a queued id with no row would be a worker
 * looking for something that does not exist. Each step's failure leaves only the cheaper mistake.
 *
 * The worker half (claiming a row, progress, finishing) is `BackgroundJobRunner`; the restart half
 * is `BackgroundJobRecovery`. This file owns the rules they share: who may see a job, what a job
 * looks like on the wire, and how it is (re)queued.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { JobOptions, Queue } from 'bull';
import { createHash } from 'crypto';
import { createReadStream, promises as fsp } from 'fs';
import { Readable } from 'stream';
import {
  expandRoles,
  isBackgroundJobOpen,
  SystemRole,
  backgroundJobLabel,
  type BackgroundJobAccepted,
  type BackgroundJobKind,
  type BackgroundJobList,
  type BackgroundJobProgress,
  type BackgroundJobScope,
  type BackgroundJobSummary,
} from '@fapoms/shared';
import type { StorageEngine } from '../storage/storage-engine.interface';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import {
  dedupeKeyFor,
  FAILED_JOB_RETENTION,
  findInFlightDuplicate,
  type QueuedJobEnvelope,
} from '../queue/queued-job';
import type { JobActor } from '../queue/job-actor';
import type { GlobalScope } from '../scope/global-scope';
import { permissionKeysHeldBy } from '../../modules/auth/guards';
import { BackgroundJobEntity, type StoredInputObject } from './background-job.entity';
import { BackgroundJobRegistry } from './background-job.registry';
import { BullQueueResolver } from './bull-queue.resolver';
import { BackgroundJobStore, OPEN_STATUSES, SETTLED_STATUSES } from './background-job.store';
import {
  JOB_UPDATED_EVENT,
  TRACKED_JOBS_QUEUE,
  type PreparedInputFile,
  type TrackedJobData,
} from './background-jobs.contract';

/** A file as multer hands it over: on disk (`path`) for a job upload, or in memory. */
export interface IncomingJobFile {
  path?: string;
  buffer?: Buffer;
  originalName: string;
  mimeType?: string | null;
  size: number;
}

export interface CreateJobRequest {
  kind: BackgroundJobKind;
  actor: JobActor;
  /** The requester's regions (`assignedRegions(req.user)`), null when unrestricted. */
  regions: string[] | null;
  scope?: BackgroundJobScope | null;
  params?: Record<string, unknown> | null;
  file?: IncomingJobFile | null;
  /** A several-file upload, for a kind declared `input: 'files'`. Never together with `file`. */
  files?: IncomingJobFile[] | null;
  /** A commit reviewed from this rehearsal; reuses its file when no new one is sent. */
  parentJobId?: string | null;
  /** The resolved region/client scope of the calling route, handed to `prepare`. */
  globalScope?: GlobalScope;
  /** Overrides whatever `prepare` or the default says. */
  title?: string;
}

/**
 * A run that stays on its FEATURE'S Bull queue and is tracked on a row (see `enqueueTracked`).
 *
 * `data` is the feature's own payload, `dedupeKey` included: the feature's duplicate rule is kept
 * exactly as it was, and the row is written only for a run that was really added.
 */
export interface EnqueueTrackedRequest<T extends QueuedJobEnvelope> {
  kind: BackgroundJobKind;
  actor: JobActor;
  regions: string[] | null;
  scope?: BackgroundJobScope | null;
  /** What a person would call it — "Approve 42 payouts". */
  title: string;
  /** Small, displayable facts about the run (counts, a date). Never the payload itself. */
  params?: Record<string, unknown> | null;
  /** The denominator, when the request already knows it. */
  total?: number | null;
  queue: Queue;
  jobName: string;
  data: T;
  options: JobOptions;
}

export interface TrackedEnqueueResult {
  /** The Bull job id — what the feature's own poll route has always taken. */
  jobId: string;
  /** Joined an identical run already queued or running (the feature's rule, unchanged). */
  deduplicated: boolean;
  /** The row that tracks it, or null for a run queued before tracking existed (or untracked). */
  backgroundJobId: string | null;
}

/** Who is asking to read or stop jobs. */
export interface JobReader {
  userId: string;
  roleNames: string[];
  /** Null for an unrestricted account. */
  regions: string[] | null;
  organizationId?: string | null;
}

export type JobListStatus = 'active' | 'recent';

export interface JobListQuery {
  include: JobListStatus[];
  /** An administrator's view of everybody's jobs within their regions. */
  all?: boolean;
  kind?: string;
  scopeType?: string;
  scopeId?: string;
  limit: number;
}

/** How far back "recent" reaches in the tray. The rows themselves are kept for 30 days. */
export const RECENT_WINDOW_MS = 7 * 86_400_000;

/**
 * Bull's copy of a job is only the wake-up call; the row is the record. So completed Bull jobs are
 * kept briefly (a day, for the Bull Board) and failed ones for the shared failure window.
 */
export const TRACKED_JOB_OPTIONS: JobOptions = {
  attempts: 1,
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: FAILED_JOB_RETENTION,
};

/** Shown for a job whose worker disappeared and whose kind cannot safely be re-run. */
export const INTERRUPTED_MESSAGE =
  'This job was interrupted (the server restarted while it was running) — please retry.';

const NOT_FOUND =
  'No such job. Jobs are kept for 30 days and are only visible to the person who started them.';

@Injectable()
export class BackgroundJobsService {
  private readonly logger = new Logger(BackgroundJobsService.name);

  constructor(
    private readonly store: BackgroundJobStore,
    private readonly registry: BackgroundJobRegistry,
    @InjectQueue(TRACKED_JOBS_QUEUE) private readonly queue: Queue,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
    private readonly events: DomainEventPublisher,
    @Optional() private readonly queues?: BullQueueResolver,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Starting
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The generic `POST /jobs` gate: the kind must opt in to being started there, and the caller must
   * hold every permission it names. A kind's own controller, with its own decorators, does not call
   * this.
   */
  assertMayStart(kind: string, user: unknown): void {
    const definition = this.registry.require(kind);
    if (!definition.start) {
      throw new BadRequestException(`"${kind}" jobs are started from their own page, not from here.`);
    }
    const held = new Set([...permissionKeysHeldBy(user)].map((p) => p.toUpperCase()));
    const missing = definition.start.permissions.filter((p) => !held.has(p.trim().toUpperCase()));
    if (missing.length > 0) throw new ForbiddenException('Insufficient permissions');
  }

  /**
   * Accept a job: store its file, record it, queue it. Answers as soon as the file is safe.
   *
   * A duplicate — same person, kind, scope, file and parameters, while the first is still open —
   * returns the first job (`deduplicated: true`) and starts nothing. That is the answer to the
   * upload that "didn't seem to do anything" being pressed again.
   */
  async create(request: CreateJobRequest): Promise<BackgroundJobAccepted> {
    const definition = this.registry.require(request.kind);
    const params = request.params ?? {};
    const scope = request.scope ?? null;

    const parent = request.parentJobId ? await this.store.findById(request.parentJobId) : null;
    if (request.parentJobId) {
      if (!parent) throw new NotFoundException(NOT_FOUND);
      if (parent.kind !== request.kind) throw new BadRequestException('A commit must be the same kind of job as its rehearsal.');
    }

    const file = request.file ?? null;
    const files = request.files ?? [];
    if (definition.input === 'none' && (file || files.length > 0)) {
      throw new BadRequestException('This kind of job does not take a file.');
    }
    if (definition.input === 'files') {
      if (file) throw new BadRequestException('This kind of job takes its files as a set.');
      if (files.length === 0 && !parent?.inputObjects?.length) {
        throw new BadRequestException('No files were uploaded. Choose the files and try again.');
      }
    } else if (files.length > 0) {
      throw new BadRequestException('This kind of job takes one file, not several.');
    }
    if (definition.input === 'required' && !file && !parent?.inputObjectKey) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }

    const fileDigests = await Promise.all(files.map((f) => sha256Of(f)));
    const sha256 = file
      ? await sha256Of(file)
      : files.length > 0
        ? hash(fileDigests.join('|'))
        : parent?.inputSha256 ?? null;
    const dedupeKey = hash(
      dedupeKeyFor(request.kind, request.actor.userId, {
        scopeType: scope?.type ?? null,
        scopeId: scope?.id ?? null,
        sha256,
        parentJobId: parent?.id ?? null,
        params,
      }),
    );

    // Fast path. The insert below is what actually guarantees one row; this spares a duplicate the
    // cost of storing its file first.
    const existing = await this.store.findOpenByDedupe(dedupeKey);
    if (existing) return { job: this.toSummary(existing), deduplicated: true };

    const prepared = definition.prepare
      ? (await definition.prepare({
          kind: request.kind,
          actor: request.actor,
          regions: request.regions,
          globalScope: request.globalScope,
          scope,
          params,
          file: file ? preparedFile(file, sha256!) : null,
          files: files.map((f, i) => preparedFile(f, fileDigests[i])),
          parent: parent ? this.toSummary(parent) : null,
        })) ?? {}
      : {};

    const inputObjectKey = file
      ? await this.storage.saveFile(
          file.originalName,
          file.path ? createReadStream(file.path) : file.buffer!,
          file.mimeType ?? undefined,
          file.size,
        )
      : parent?.inputObjectKey ?? null;

    // Each file of a set is stored on its own, in order; one that cannot be stored undoes the rest,
    // so a half-stored set never becomes a job.
    let inputObjects: StoredInputObject[] | null = parent?.inputObjects ?? null;
    if (files.length > 0) {
      const stored: StoredInputObject[] = [];
      try {
        for (const [i, f] of files.entries()) {
          const key = await this.storage.saveFile(
            f.originalName,
            f.path ? createReadStream(f.path) : f.buffer!,
            f.mimeType ?? undefined,
            f.size,
          );
          stored.push({ key, fileName: f.originalName, mimeType: f.mimeType ?? null, size: f.size, sha256: fileDigests[i] });
        }
      } catch (err) {
        for (const o of stored) await this.discardObject(o.key);
        throw err;
      }
      inputObjects = stored;
    }
    const storedHere = [
      ...(file && inputObjectKey ? [inputObjectKey] : []),
      ...(files.length > 0 && inputObjects ? inputObjects.map((o) => o.key) : []),
    ];

    const total = typeof prepared.total === 'number' && prepared.total >= 0 ? prepared.total : null;
    const progress: BackgroundJobProgress = {
      processed: 0,
      total,
      percent: total !== null ? 0 : null,
      stage: prepared.stage ?? 'Waiting to start',
      message: null,
    };
    const inputFileName =
      file?.originalName
      ?? (files.length === 1 ? files[0].originalName : files.length > 1 ? `${files.length} files` : null)
      ?? parent?.inputFileName
      ?? null;
    const inputSize = file
      ? String(file.size)
      : files.length > 0
        ? String(files.reduce((sum, f) => sum + f.size, 0))
        : parent?.inputSize ?? null;

    let inserted: { job: BackgroundJobEntity; inserted: boolean };
    try {
      inserted = await this.store.insert({
        kind: request.kind,
        status: 'QUEUED',
        title: truncate(
          request.title ?? prepared.title ?? defaultTitle(request.kind, inputFileName),
          300,
        ),
        requestedBy: request.actor.userId,
        actor: request.actor,
        organizationId: request.actor.organizationId ?? null,
        scopeType: scope?.type ?? null,
        scopeId: scope?.id ?? null,
        regions: request.regions,
        params,
        progress,
        inputObjectKey,
        inputFileName,
        inputMimeType: file?.mimeType ?? parent?.inputMimeType ?? null,
        inputSha256: sha256,
        inputSize,
        inputObjects,
        dedupeKey,
        parentJobId: parent?.id ?? null,
      });
    } catch (err) {
      for (const key of storedHere) await this.discardObject(key);
      throw err;
    }

    if (!inserted.inserted) {
      // Lost a race to an identical upload. Its file is the one kept; ours was never needed.
      for (const key of storedHere) await this.discardObject(key);
      return { job: this.toSummary(inserted.job), deduplicated: true };
    }

    const row = inserted.job;
    try {
      await this.enqueue(row);
    } catch (err) {
      this.logger.error(`Could not queue background job ${row.id}: ${(err as Error).message}`);
      const failed = await this.store.transition(row.id, ['QUEUED'], {
        status: 'FAILED',
        error: 'The file was received but the job could not be queued. Please try again in a minute.',
        finishedAt: new Date(),
      });
      if (failed) this.publish(failed);
      throw new ServiceUnavailableException(
        'The file was received but the job could not be queued. Please try again in a minute.',
      );
    }

    const fresh = (await this.store.findById(row.id)) ?? row;
    this.publish(fresh);
    return { job: this.toSummary(fresh), deduplicated: false };
  }

  /**
   * A person reviewed a rehearsal and wants it done for real: start a child job of the same kind
   * over the same file, and close the rehearsal.
   *
   * The child is created first. If that is refused (the caller may not act, the kind's `prepare`
   * says no) the rehearsal stays open for another decision.
   */
  async commitReviewed(
    reader: JobReader,
    actor: JobActor,
    parentId: string,
    params: Record<string, unknown> = {},
  ): Promise<BackgroundJobAccepted> {
    const parent = await this.visibleRow(reader, parentId);
    if (parent.status !== 'AWAITING_REVIEW') {
      throw new ConflictException('This job is not waiting for a review any more.');
    }
    const accepted = await this.create({
      kind: parent.kind,
      actor,
      regions: reader.regions,
      scope: parent.scopeType ? { type: parent.scopeType, id: parent.scopeId } : null,
      params: { ...(parent.params ?? {}), ...params },
      parentJobId: parent.id,
    });
    const closed = await this.store.transition(parent.id, ['AWAITING_REVIEW'], {
      status: 'SUCCEEDED',
      progress: { ...parent.progress, stage: 'Reviewed — the real run was started', message: null },
    });
    if (closed) this.publish(closed);
    return accepted;
  }

  /**
   * Put a run on a FEATURE'S queue and record it on a row, so it survives a refresh.
   *
   * For work that must keep its own queue — billing's one-at-a-time money runs, the export queue
   * whose single slot guards the process from `xlsx.write`, planning's queues — and so cannot move
   * onto the foundation's two shared `tracked-jobs` slots without changing how it is scheduled. The
   * feature's worker wraps its handler in `BackgroundJobTracker.run`, which writes progress and the
   * outcome onto the row; the feature's own poll route keeps working on the Bull id.
   *
   * Order: look for an identical run (the feature's own rule — same name and `dedupeKey`, still
   * queued or running) and join it; otherwise write the row, then add the Bull job carrying the
   * row's id, then record the Bull id on the row. A row whose add fails is FAILED at once, and the
   * error is thrown as before. Tracking never stands in the way of the work: if the row cannot be
   * written, the run is queued untracked and the failure logged.
   */
  async enqueueTracked<T extends QueuedJobEnvelope>(request: EnqueueTrackedRequest<T>): Promise<TrackedEnqueueResult> {
    const { queue, jobName, data } = request;
    const inFlight = await findInFlightDuplicate(queue, jobName, data.dedupeKey, this.logger);
    if (inFlight) {
      this.logger.log(`Joining in-flight ${jobName} job ${inFlight.id} rather than starting a duplicate.`);
      const existing = (inFlight.data as Partial<QueuedJobEnvelope> | undefined)?.backgroundJobId ?? null;
      return { jobId: String(inFlight.id), deduplicated: true, backgroundJobId: existing };
    }

    const total = typeof request.total === 'number' && request.total >= 0 ? request.total : null;
    let row: BackgroundJobEntity | null = null;
    try {
      const inserted = await this.store.insert({
        kind: request.kind,
        status: 'QUEUED',
        title: truncate(request.title || backgroundJobLabel(request.kind), 300),
        requestedBy: request.actor.userId,
        actor: request.actor,
        organizationId: request.actor.organizationId ?? null,
        scopeType: request.scope?.type ?? null,
        scopeId: request.scope?.id ?? null,
        regions: request.regions,
        params: request.params ?? {},
        progress: { processed: 0, total, percent: total !== null ? 0 : null, stage: 'Waiting to start', message: null },
        runnerQueue: queue.name,
        dedupeKey: null,
      });
      row = inserted.job;
    } catch (err) {
      this.logger.warn(`Could not record a tracked ${jobName} run; queuing it untracked: ${(err as Error).message}`);
    }

    let job;
    try {
      job = await queue.add(jobName, row ? { ...data, backgroundJobId: row.id } : data, request.options);
    } catch (err) {
      if (row) {
        const failed = await this.store.transition(row.id, ['QUEUED'], {
          status: 'FAILED',
          error: 'This could not be queued. Please try again in a minute.',
          finishedAt: new Date(),
        }).catch(() => null);
        if (failed) this.publish(failed);
      }
      throw err;
    }
    this.logger.log(`Enqueued ${jobName} job ${job.id}${row ? ` (tracked as ${row.id})` : ''}.`);

    if (row) {
      try {
        await this.store.setBullJobId(row.id, String(job.id));
        this.publish({ ...row, bullJobId: String(job.id) });
      } catch (err) {
        this.logger.warn(`Could not record Bull id ${job.id} on tracked job ${row.id}: ${(err as Error).message}`);
      }
    }
    return { jobId: String(job.id), deduplicated: false, backgroundJobId: row?.id ?? null };
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Reading
  // ───────────────────────────────────────────────────────────────────────────────────────────

  async list(reader: JobReader, query: JobListQuery): Promise<BackgroundJobList> {
    const include = new Set(query.include);
    const asAdmin = !!query.all && isAdministrator(reader);
    if (query.all && !asAdmin) throw new ForbiddenException('Only an administrator can see everybody\'s jobs.');

    const base = {
      requestedBy: asAdmin ? undefined : reader.userId,
      withinRegions: asAdmin ? reader.regions : undefined,
      organizationId: asAdmin ? reader.organizationId ?? null : undefined,
      kind: query.kind,
      scopeType: query.scopeType,
      scopeId: query.scopeId,
      limit: query.limit,
    };

    const [active, recent] = await Promise.all([
      include.has('active') ? this.store.list({ ...base, statuses: OPEN_STATUSES }) : Promise.resolve([]),
      include.has('recent')
        ? this.store.list({
            ...base,
            statuses: SETTLED_STATUSES,
            finishedAfter: new Date(Date.now() - RECENT_WINDOW_MS),
          })
        : Promise.resolve([]),
    ]);
    return { active: active.map((r) => this.toSummary(r)), recent: recent.map((r) => this.toSummary(r)) };
  }

  async get(reader: JobReader, id: string): Promise<BackgroundJobSummary> {
    return this.toSummary(await this.visibleRow(reader, id));
  }

  /** The stored report, for download. */
  async openResult(
    reader: JobReader,
    id: string,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    const row = await this.visibleRow(reader, id);
    if (!row.resultObjectKey) throw new NotFoundException('This job has no report to download.');
    return {
      stream: await this.storage.getFileStream(row.resultObjectKey),
      fileName: row.resultFileName ?? `${row.kind.toLowerCase()}-report`,
      mimeType: row.resultMimeType ?? 'application/octet-stream',
    };
  }

  /**
   * The row, if this reader may see it; otherwise the same 404 as a row that does not exist, so an
   * id is never confirmed to somebody it does not belong to.
   */
  async visibleRow(reader: JobReader, id: string): Promise<BackgroundJobEntity> {
    const row = UUID.test(id) ? await this.store.findById(id) : null;
    if (!row || !isVisibleTo(reader, row)) throw new NotFoundException(NOT_FOUND);
    return row;
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Stopping
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Stop a job.
   *
   *  - Waiting (QUEUED): cancelled at once; a worker that picks it up later finds nothing to do.
   *  - Running: flagged. The worker stops at its next chunk boundary and records how far it got —
   *    it is never killed mid-write.
   *  - Awaiting review: the rehearsal is discarded.
   *  - Finished: refused; there is nothing left to stop.
   */
  async cancel(reader: JobReader, id: string, attempt = 0): Promise<BackgroundJobSummary> {
    const row = await this.visibleRow(reader, id);
    // Each retry below follows a real status change, and a job changes status a handful of times
    // in its life; the bound only stops a pathological loop, it is never reached in practice.
    if (attempt > 3) return this.toSummary(row);

    // A run on a feature's own queue has no checkpoints the foundation can stop it at: it can be
    // taken off its queue while it waits, and otherwise finishes on its own.
    if (row.runnerQueue && row.status === 'RUNNING') {
      throw new ConflictException('This is already running and cannot be stopped part-way. It will finish on its own.');
    }

    if (row.status === 'QUEUED' || row.status === 'AWAITING_REVIEW') {
      const cancelled = await this.store.transition(row.id, [row.status], {
        status: 'CANCELLED',
        finishedAt: row.finishedAt ?? new Date(),
        cancelRequestedAt: new Date(),
        cancelRequestedBy: reader.userId,
        progress: {
          ...row.progress,
          stage: row.status === 'AWAITING_REVIEW' ? 'Discarded' : 'Cancelled before it started',
        },
      });
      if (cancelled) {
        if (row.status === 'QUEUED') await this.removeBullJob(row.bullJobId, row.runnerQueue);
        this.publish(cancelled);
        return this.toSummary(cancelled);
      }
      // It moved on while we were deciding — answer for where it is now.
      return this.cancel(reader, id, attempt + 1);
    }

    if (row.status === 'RUNNING') {
      if (row.cancelRequestedAt) return this.toSummary(row);
      const flagged = await this.store.requestCancel(row.id, reader.userId);
      if (flagged) {
        this.publish(flagged);
        return this.toSummary(flagged);
      }
      return this.cancel(reader, id, attempt + 1);
    }

    throw new ConflictException('This job has already finished.');
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Shared with the worker and the recovery sweep
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Put a row on the queue. The first Bull job for a row uses the row's own id; a deferral or a
   * restart needs a fresh one (Bull ignores an add whose id it still holds), and the row records
   * which Bull job currently carries it.
   */
  async enqueue(row: Pick<BackgroundJobEntity, 'id' | 'kind'>, opts: { delayMs?: number; fresh?: boolean } = {}): Promise<string> {
    const jobId = opts.fresh ? `${row.id}:${Date.now().toString(36)}` : row.id;
    const data: TrackedJobData = { backgroundJobId: row.id };
    const job = await this.queue.add(row.kind, data, {
      ...TRACKED_JOB_OPTIONS,
      jobId,
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    });
    const bullJobId = String(job.id ?? jobId);
    await this.store.setBullJobId(row.id, bullJobId);
    return bullJobId;
  }

  /** Push the row to its requester's screens. Best-effort: a missed push is caught by the poll. */
  publish(row: BackgroundJobEntity): void {
    try {
      this.events.publish(JOB_UPDATED_EVENT, {
        eventType: JOB_UPDATED_EVENT,
        requestedBy: row.requestedBy,
        job: this.toSummary(row),
      });
    } catch (err) {
      this.logger.warn(`Could not publish ${JOB_UPDATED_EVENT} for ${row.id}: ${(err as Error).message}`);
    }
  }

  toSummary(row: BackgroundJobEntity): BackgroundJobSummary {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      requestedBy: row.requestedBy,
      scopeType: row.scopeType ?? null,
      scopeId: row.scopeId ?? null,
      progress: row.progress ?? { processed: 0, total: null, percent: null, stage: 'Waiting to start' },
      result: row.result ?? null,
      error: row.error ?? null,
      inputFileName: row.inputFileName ?? null,
      inputSize: row.inputSize !== null && row.inputSize !== undefined ? Number(row.inputSize) : null,
      inputFileCount: row.inputObjects?.length ?? (row.inputObjectKey ? 1 : 0),
      parentJobId: row.parentJobId ?? null,
      cancelRequested: !!row.cancelRequestedAt && isBackgroundJobOpen(row.status),
      cancellable: isBackgroundJobOpen(row.status) && !(row.runnerQueue && row.status === 'RUNNING'),
      hasResultFile: !!row.resultObjectKey,
      resultFileName: row.resultFileName ?? null,
      createdAt: iso(row.createdAt)!,
      startedAt: iso(row.startedAt),
      finishedAt: iso(row.finishedAt),
      updatedAt: iso(row.updatedAt) ?? iso(row.createdAt)!,
    };
  }

  /** The Bull queue a row runs on: its feature's, for a tracked run; otherwise the foundation's. */
  queueFor(row: Pick<BackgroundJobEntity, 'runnerQueue'>): Queue | null {
    if (!row.runnerQueue) return this.queue;
    return this.queues?.get(row.runnerQueue) ?? null;
  }

  private async removeBullJob(bullJobId: string | null, runnerQueue: string | null = null): Promise<void> {
    if (!bullJobId) return;
    try {
      const queue = this.queueFor({ runnerQueue });
      const job = await queue?.getJob(bullJobId);
      await job?.remove();
    } catch {
      // A locked or already-gone job is fine: the row says CANCELLED, and the worker checks the row.
    }
  }

  private async discardObject(key: string): Promise<void> {
    try {
      await this.storage.deleteFile(key);
    } catch (err) {
      this.logger.warn(`Could not delete unused upload ${key}: ${(err as Error).message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rules, as plain functions so they can be tested without a service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** ADMIN, or anything that implies it (DEVELOPER). */
export function isAdministrator(reader: Pick<JobReader, 'roleNames'>): boolean {
  return expandRoles(reader.roleNames).includes(SystemRole.ADMIN);
}

/**
 * The requester always; an administrator when the job's captured regions all fall inside theirs
 * (an unrestricted administrator sees every job in their organisation). Nobody else.
 */
export function isVisibleTo(
  reader: JobReader,
  row: Pick<BackgroundJobEntity, 'requestedBy' | 'regions' | 'organizationId'>,
): boolean {
  if (row.requestedBy === reader.userId) return true;
  if (!isAdministrator(reader)) return false;
  if (reader.organizationId && row.organizationId && reader.organizationId !== row.organizationId) return false;
  if (reader.regions === null) return true;
  if (!row.regions || row.regions.length === 0) return false;
  return row.regions.every((r) => reader.regions!.includes(r));
}

export function parseListInclude(raw: string | undefined): JobListStatus[] {
  if (!raw) return ['active', 'recent'];
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid = parts.filter((p): p is JobListStatus => p === 'active' || p === 'recent');
  if (valid.length === 0) throw new BadRequestException('status must be "active", "recent", or both.');
  return valid;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultTitle(kind: BackgroundJobKind, fileName: string | null): string {
  return fileName ? `${backgroundJobLabel(kind)}: ${fileName}` : backgroundJobLabel(kind);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function sha256Of(file: IncomingJobFile): Promise<string> {
  const digest = createHash('sha256');
  if (file.buffer) return digest.update(file.buffer).digest('hex');
  if (!file.path) throw new BadRequestException('The uploaded file could not be read. Please re-upload it.');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file.path!)
      .on('data', (chunk) => digest.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return digest.digest('hex');
}

function preparedFile(file: IncomingJobFile, sha256: string): PreparedInputFile {
  return {
    originalName: file.originalName,
    mimeType: file.mimeType ?? null,
    size: file.size,
    sha256,
    read: async () => (file.buffer ? file.buffer : fsp.readFile(file.path!)),
    stream: () => (file.buffer ? Readable.from(file.buffer) : createReadStream(file.path!)),
  };
}
