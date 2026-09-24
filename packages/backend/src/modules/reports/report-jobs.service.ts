/**
 * FAPOMS — Enqueue, poll and download side of the report export queue.
 *
 * The controller talks only to this. Same reasoning as `PlanningJobsService`: deduplication and
 * the "only its requester may read a job" rule are enforced in one place rather than repeated at
 * every route.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

import {
  QueuedJobEnvelope,
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';
import {
  REPORT_EXPORT_SCOPE,
  REPORT_EXPORT_TITLE,
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

/**
 * Who asked for an export, as the tracking row records it: the person (whose Jobs tray shows it)
 * and their assigned regions (null when unrestricted).
 */
export interface ReportRequester {
  actor: JobActor;
  regions: string[] | null;
}

export interface EnqueueResult {
  jobId: string;
  /** True when this joined a run already in flight instead of starting a duplicate. */
  deduplicated: boolean;
  /** The `background_jobs` row that lets the Jobs tray find this export after a refresh. */
  backgroundJobId: string | null;
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
  constructor(
    @InjectQueue(REPORT_QUEUE) private readonly queue: Queue,
    private readonly files: ReportFileStore,
    private readonly backgroundJobs: BackgroundJobsService,
  ) {}

  async enqueueAssignments(
    params: Omit<AssignmentsReportJobData, keyof QueuedJobEnvelope>,
    requester: ReportRequester,
  ): Promise<EnqueueResult> {
    return this.add<AssignmentsReportJobData>(REPORT_JOB.ASSIGNMENTS, params, requester, {
      status: params.status, projectBranchStatus: params.projectBranchStatus, priority: params.priority,
    });
  }

  async enqueueBilling(
    params: Omit<BillingReportJobData, keyof QueuedJobEnvelope>,
    requester: ReportRequester,
  ): Promise<EnqueueResult> {
    return this.add<BillingReportJobData>(REPORT_JOB.BILLING, params, requester, {
      clientId: params.clientId, projectId: params.projectId, assayerId: params.assayerId, state: params.state,
    });
  }

  async enqueueCommandCenter(
    params: Omit<CommandCenterReportJobData, keyof QueuedJobEnvelope>,
    requester: ReportRequester,
  ): Promise<EnqueueResult> {
    return this.add<CommandCenterReportJobData>(REPORT_JOB.COMMAND_CENTER, params, requester);
  }

  async enqueueAssayerRoster(
    params: Omit<AssayerRosterReportJobData, keyof QueuedJobEnvelope>,
    requester: ReportRequester,
  ): Promise<EnqueueResult> {
    return this.add<AssayerRosterReportJobData>(REPORT_JOB.ASSAYER_ROSTER, params, requester);
  }

  /** Same payload as the workbook twin above — only the renderer differs. */
  async enqueueAssayerRosterPdf(
    params: Omit<AssayerRosterReportJobData, keyof QueuedJobEnvelope>,
    requester: ReportRequester,
  ): Promise<EnqueueResult> {
    return this.add<AssayerRosterReportJobData>(REPORT_JOB.ASSAYER_ROSTER_PDF, params, requester);
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

  /**
   * Queues the export and records it as a `REPORT_EXPORT` row (`scopeType` = the report), so the
   * person's Jobs tray shows it — progress, then a download link while the file lasts — even after
   * a refresh.
   *
   * Deduplication is `enqueueTracked`'s, which is the rule this queue always had: an identical
   * export (same name, requester and filters) that is still waiting or running is joined, never a
   * finished one — matching a completed one would serve a stale workbook to an operator who
   * changed a filter and re-ran deliberately. A scan failure never blocks the enqueue.
   *
   * `filters` is what the row displays: the report's own small filter values, never the frozen
   * scope or the principal snapshot the worker needs.
   */
  private async add<T extends QueuedJobEnvelope>(
    name: ReportJobName,
    params: Omit<T, keyof QueuedJobEnvelope>,
    requester: ReportRequester,
    filters: Record<string, unknown> = {},
  ): Promise<EnqueueResult> {
    const requestedBy = requester.actor.userId;
    const data = {
      ...params,
      requestedBy,
      dedupeKey: dedupeKeyFor(name, requestedBy, params),
    } as unknown as T;

    const shown = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    return this.backgroundJobs.enqueueTracked({
      kind: 'REPORT_EXPORT',
      actor: requester.actor,
      regions: requester.regions,
      scope: { type: REPORT_EXPORT_SCOPE[name], id: null },
      title: REPORT_EXPORT_TITLE[name],
      params: shown,
      queue: this.queue,
      jobName: name,
      data,
      options: REPORT_JOB_OPTIONS,
    });
  }
}
