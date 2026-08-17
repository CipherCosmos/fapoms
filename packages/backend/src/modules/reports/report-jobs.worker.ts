/**
 * FAPOMS — Execute side of the report export queue.
 *
 * Each handler is the queued twin of a synchronous `GET /reports/*` route that still exists and
 * still works. It calls the same `ReportsService` method with the same arguments, so a queued
 * export and a synchronous one of the same request produce byte-identical workbooks; what moves
 * is where the seconds and the CPU are spent, and where the finished bytes go.
 */

import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import { EXCEL_MIME } from './excel-export';
import { ReportsService } from './reports.service';
import { ReportFileStore } from './report-file.store';
import { progressReporter, ProgressCallback } from '../../infrastructure/queue/queued-job';
import {
  REPORT_JOB,
  REPORT_QUEUE,
  ReportJobResult,
  AssignmentsReportJobData,
  AssayerRosterReportJobData,
  BillingReportJobData,
  CommandCenterReportJobData,
} from './report-jobs.contract';

/**
 * Why exports run one at a time.
 *
 * `buildWorkbook` ends in `xlsx.write`, which is synchronous and has no yield point: while it
 * runs, this process serves nothing — not another request, not a health check, not the socket
 * heartbeat. Two large exports in parallel double that blackout rather than halving the wait, so
 * concurrency here is not a throughput dial and 1 is not a conservative setting, it is the only
 * correct one until exports move to a separate worker process (or to a streaming writer).
 */
const ONE_AT_A_TIME = 1;

@Processor(REPORT_QUEUE)
export class ReportJobsWorker {
  private readonly logger = new Logger(ReportJobsWorker.name);

  constructor(
    private readonly reportsService: ReportsService,
    private readonly files: ReportFileStore,
  ) {}

  @Process({ name: REPORT_JOB.ASSIGNMENTS, concurrency: ONE_AT_A_TIME })
  async assignments(job: Job<AssignmentsReportJobData>): Promise<ReportJobResult> {
    const { status, projectBranchStatus, priority, scope } = job.data;
    return this.produce(job, `assignments_${job.id}.xlsx`, (onProgress) =>
      this.reportsService.assignments(
        { status, projectBranchStatus, priority, scope: scope ?? undefined },
        onProgress,
      ),
    );
  }

  @Process({ name: REPORT_JOB.BILLING, concurrency: ONE_AT_A_TIME })
  async billing(job: Job<BillingReportJobData>): Promise<ReportJobResult> {
    const { clientId, projectId, assayerId, state } = job.data;
    return this.produce(job, `billing_${job.id}.xlsx`, (onProgress) =>
      this.reportsService.billing({ clientId, projectId, assayerId, state }, onProgress),
    );
  }

  @Process({ name: REPORT_JOB.COMMAND_CENTER, concurrency: ONE_AT_A_TIME })
  async commandCenter(job: Job<CommandCenterReportJobData>): Promise<ReportJobResult> {
    return this.produce(job, `command_center_${job.id}.xlsx`, (onProgress) =>
      this.reportsService.commandCenter(job.data.scope ?? {}, onProgress),
    );
  }

  @Process({ name: REPORT_JOB.ASSAYER_ROSTER, concurrency: ONE_AT_A_TIME })
  async assayerRoster(job: Job<AssayerRosterReportJobData>): Promise<ReportJobResult> {
    const { principal, scope } = job.data;
    return this.produce(job, `assayer_roster_${job.id}.xlsx`, (onProgress) =>
      // The `{ id, roles }` snapshot, not a user record — see PrincipalSnapshot. `rolesOf` reads
      // nothing else, and this is what decides whether PAN and bank columns appear in the sheet.
      this.reportsService.assayerRoster(principal, { scope: scope ?? undefined }, onProgress),
    );
  }

  /**
   * The half of every export that is the same: build, store, describe.
   *
   * Filenames are keyed on the job id rather than `Date.now()` (which the synchronous routes
   * use). The synchronous routes need only a name that is unique in a downloads folder; here the
   * name has to survive the round trip through the poll response and identify one export
   * unambiguously when an operator has three of them open, and the job id is the thing that
   * already means exactly that.
   *
   * Nothing is caught. A failure — including the file being over the size cap, which throws
   * `ReportTooLargeError` with wording aimed at the operator — is recorded by Bull as the job's
   * `failedReason` and surfaced verbatim by the poll endpoint. Swallowing it here would produce
   * a job that reports success and a download that 404s.
   */
  private async produce(
    job: Job,
    filename: string,
    build: (onProgress: ProgressCallback) => Promise<Buffer>,
  ): Promise<ReportJobResult> {
    this.logger.log(`Export job ${job.id} (${job.name}) starting.`);

    const buffer = await build(progressReporter(job));
    await this.files.put(String(job.id), buffer);

    this.logger.log(`Export job ${job.id} (${job.name}) produced ${filename} — ${(buffer.length / 1024).toFixed(0)} KB.`);
    return { filename, mimeType: EXCEL_MIME, sizeBytes: buffer.length };
  }
}
