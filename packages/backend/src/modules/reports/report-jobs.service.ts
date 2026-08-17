/**
 * FAPOMS — Enqueue, poll and download side of the report export queue.
 *
 * The controller talks only to this. Same reasoning as `PlanningJobsService`: deduplication and
 * the "only its requester may read a job" rule are enforced in one place rather than repeated at
 * every route.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';

import {
  IN_FLIGHT_SCAN_LIMIT,
  QueuedJobEnvelope,
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';
import {
  REPORT_JOB,
  REPORT_JOB_OPTIONS,
  REPORT_QUEUE,
  ReportJobName,
  ReportJobResult,
  AssignmentsReportJobData,
  AssayerRosterReportJobData,
  BillingReportJobData,
  CommandCenterReportJobData,
} from './report-jobs.contract';
import { ReportFileStore } from './report-file.store';

export interface EnqueueResult {
  jobId: string;
  /** True when this joined a run already in flight instead of starting a duplicate. */
  deduplicated: boolean;
}

/**
 * The poll response for an export.
 *
 * Distinct from `QueuedJobStatus` in exactly two ways, both of which follow from the payload
 * being a file rather than JSON: `result` never carries the bytes (see `ReportJobResult`), and
 * `expiresInSeconds` reports how long the caller has left to fetch them.
 */
export interface ReportJobStatus extends QueuedJobStatus<ReportJobResult> {
  /**
   * Seconds until the produced file is deleted, or null when there is no file (still running,
   * failed, or already expired). Read from the file's own TTL, so it is what will actually
   * happen rather than an estimate.
   */
  expiresInSeconds: number | null;
}

@Injectable()
export class ReportJobsService {
  private readonly logger = new Logger(ReportJobsService.name);

  constructor(
    @InjectQueue(REPORT_QUEUE) private readonly queue: Queue,
    private readonly files: ReportFileStore,
  ) {}

  async enqueueAssignments(
    params: Omit<AssignmentsReportJobData, keyof QueuedJobEnvelope>,
    requestedBy: string,
  ): Promise<EnqueueResult> {
    return this.add<AssignmentsReportJobData>(REPORT_JOB.ASSIGNMENTS, params, requestedBy);
  }

  async enqueueBilling(
    params: Omit<BillingReportJobData, keyof QueuedJobEnvelope>,
    requestedBy: string,
  ): Promise<EnqueueResult> {
    return this.add<BillingReportJobData>(REPORT_JOB.BILLING, params, requestedBy);
  }

  async enqueueCommandCenter(
    params: Omit<CommandCenterReportJobData, keyof QueuedJobEnvelope>,
    requestedBy: string,
  ): Promise<EnqueueResult> {
    return this.add<CommandCenterReportJobData>(REPORT_JOB.COMMAND_CENTER, params, requestedBy);
  }

  async enqueueAssayerRoster(
    params: Omit<AssayerRosterReportJobData, keyof QueuedJobEnvelope>,
    requestedBy: string,
  ): Promise<EnqueueResult> {
    return this.add<AssayerRosterReportJobData>(REPORT_JOB.ASSAYER_ROSTER, params, requestedBy);
  }

  /**
   * Poll one export job.
   *
   * `includeResult: true` is safe here only because an export's result is metadata — filename,
   * MIME type and size. The bytes are fetched once, separately, by `download`.
   */
  async status(jobId: string, userId: string | undefined): Promise<ReportJobStatus> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    const base = await describeJob<ReportJobResult>(job, { includeResult: true });

    // Only ask Redis for the TTL when there is something to have a TTL. A poll while the job is
    // still running would otherwise spend a round trip confirming that a key nobody has written
    // does not exist.
    const expiresInSeconds = base.state === 'done' ? await this.files.secondsRemaining(String(job.id)) : null;

    return { ...base, expiresInSeconds };
  }

  /**
   * Fetches the produced workbook for download.
   *
   * The ownership check runs against the *job*, before the file is read, so the same rule that
   * governs polling governs downloading — otherwise the file key would be an unauthenticated
   * side door around it.
   *
   * The three "no file" cases are separated on purpose, because they need different actions from
   * whoever hit the link: wait, look at the error, or run it again.
   */
  async download(jobId: string, userId: string | undefined): Promise<{ buffer: Buffer; meta: ReportJobResult }> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    const status = await describeJob<ReportJobResult>(job, { includeResult: true });

    if (status.state === 'failed') {
      throw new NotFoundException(`This export failed and produced no file: ${status.error}`);
    }
    if (status.state !== 'done') {
      throw new NotFoundException('This export has not finished yet. Poll its status and try the download again once it reports "done".');
    }

    const buffer = await this.files.get(String(job.id));
    if (!buffer || !status.result) {
      throw new NotFoundException('This export has expired. Downloads are kept for a short time only — run the report again.');
    }

    return { buffer, meta: status.result };
  }

  private async add<T extends QueuedJobEnvelope>(
    name: ReportJobName,
    params: Omit<T, keyof QueuedJobEnvelope>,
    requestedBy: string,
  ): Promise<EnqueueResult> {
    const data = {
      ...params,
      requestedBy,
      dedupeKey: dedupeKeyFor(name, requestedBy, params),
    } as unknown as T;

    const inFlight = await this.findInFlight(name, data.dedupeKey);
    if (inFlight) {
      this.logger.log(`Joining in-flight ${name} export ${inFlight.id} rather than building the same workbook twice.`);
      return { jobId: String(inFlight.id), deduplicated: true };
    }

    const job = await this.queue.add(name, data, REPORT_JOB_OPTIONS);
    this.logger.log(`Enqueued ${name} export job ${job.id}.`);
    return { jobId: String(job.id), deduplicated: false };
  }

  /**
   * Finds an identical export that has not finished yet.
   *
   * Unfinished states only — matching a completed one would serve a stale workbook for the whole
   * retention window to an operator who changed a filter and re-ran deliberately.
   *
   * A scan failure never blocks the enqueue: the cost of skipping deduplication is one extra
   * workbook, whereas failing the request would turn a Redis list read into an outage of the
   * export endpoint.
   */
  private async findInFlight(name: ReportJobName, dedupeKey: string): Promise<Job | null> {
    try {
      const jobs = await this.queue.getJobs(['waiting', 'active', 'delayed'], 0, IN_FLIGHT_SCAN_LIMIT);
      return (
        jobs.find(
          (j) => j?.name === name && (j.data as Partial<QueuedJobEnvelope> | undefined)?.dedupeKey === dedupeKey,
        ) ?? null
      );
    } catch (err) {
      this.logger.warn(`Could not scan for an in-flight ${name} export (${(err as Error).message}); enqueuing anyway.`);
      return null;
    }
  }
}
