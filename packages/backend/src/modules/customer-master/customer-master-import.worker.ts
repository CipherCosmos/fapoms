/**
 * FAPOMS — the consumer for queued customer-master imports.
 *
 * See `ImportJobService` for why spreadsheet imports were moved off the request path at all. This
 * was the last one still running inside the request: a daily customer-master file is reconciled
 * row by row against the client's branches by SOL ID and then registered as a version, so on a
 * real file the operator watched a spinner for as long as that took — and a socket timeout made a
 * still-running import look like a failed one, inviting a second upload of the same file.
 */

import { Processor, Process } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bull';

import { IMPORT_QUEUE, CUSTOMER_MASTER_IMPORT_JOB } from '../import/import.constants';
import type { CustomerMasterImportJobData } from '../import/import-job.service';
import { CustomerMasterService } from './customer-master.service';

type ReconciliationReport = Awaited<ReturnType<CustomerMasterService['uploadAndReconcile']>>;

@Injectable()
@Processor(IMPORT_QUEUE)
export class CustomerMasterImportWorker {
  private readonly logger = new Logger(CustomerMasterImportWorker.name);

  constructor(private readonly customerMaster: CustomerMasterService) {}

  /**
   * **The handler name must match what the producer adds.** Bull routes a named job only to a
   * handler registered under that exact name, and a mismatch fails silently — the job would sit
   * unprocessed forever with no error anywhere. `CUSTOMER_MASTER_IMPORT_JOB` is the one constant
   * both sides read.
   *
   * `concurrency: 1` so two uploads for the same project cannot reconcile and register versions
   * at the same time, each unaware of the other's version number.
   */
  @Process({ name: CUSTOMER_MASTER_IMPORT_JOB, concurrency: 1 })
  async runCustomerMasterImport(job: Job<CustomerMasterImportJobData>): Promise<ReconciliationReport> {
    const { actorId, projectId, fileBase64, fileName, savedPath, auditDate } = job.data;
    const startedAt = Date.now();

    this.logger.log(`Customer-master import ${job.id} starting for project ${projectId} (${fileName}).`);

    const report = await this.customerMaster.uploadAndReconcile(
      projectId,
      fileName,
      // The path the upload was already persisted to, so the version records where the file
      // actually lives rather than anything reconstructed here.
      savedPath,
      Buffer.from(fileBase64, 'base64'),
      actorId,
      auditDate ?? undefined,
    );

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    this.logger.log(`Customer-master import ${job.id} finished in ${seconds}s.`);

    /**
     * Returned, not thrown, when rows could not be matched.
     *
     * A file with unmatched SOL IDs is a successful reconciliation with a report attached, not a
     * failed job — throwing would bury every row that did match behind a red "failed" state. The
     * unmatched rows are in the report, which is where they get worked.
     */
    return report;
  }
}
