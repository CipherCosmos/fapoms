/**
 * FAPOMS — the client's daily customer-master file, reconciled in the background.
 *
 * `POST /customer-master/upload` stores the file and answers 202 with the job; this reconciles it
 * in the worker. Reconciling walks every row against the client's branches by SOL ID and then
 * registers a version — on a real daily file thousands of lookups, which used to happen inside the
 * request (a socket timeout made a still-running import look failed and invited a second upload of
 * the same file). The job, its progress and its report live on a `background_jobs` row, so a
 * refresh or a hard refresh of the Daily Run page finds them again (`GET /jobs`).
 *
 * ## Why it is never re-run
 *
 * Reconciling registers a NEW version every time, so running the same file twice registers it twice.
 * A worker that dies mid-run leaves the row RUNNING; the runner then fails it with
 * `CUSTOMER_MASTER_INTERRUPTED` — which sends the operator to the versions list, where the answer
 * to "did it land?" is — rather than guessing.
 *
 * ## The file the version keeps
 *
 * The job's own copy of the upload is deleted by retention after 30 days; a version lives far
 * longer. So the run saves the bytes under their OWN key and records that key on the version, as
 * the route used to (`savedPath`). The job's input key is never written onto a domain record.
 */

import { BadRequestException, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { BackgroundJobResult } from '@fapoms/shared';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import { succeed, type RunContext } from '../../infrastructure/background-jobs/background-jobs.contract';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { assertUploadAllowed, SPREADSHEET_UPLOAD_TYPES } from '../document/upload-validation';
import {
  CustomerMasterService,
  type CustomerMasterReconciliationReportDto,
} from './customer-master.service';

export const CUSTOMER_MASTER_IMPORT_KIND = 'CUSTOMER_MASTER_IMPORT' as const;

/** What the route puts on the job; read back by `run`. */
export interface CustomerMasterImportParams {
  projectId: string;
  /** The audit date the batch covers (YYYY-MM-DD), or null for an undated upload. */
  auditDate: string | null;
}

/**
 * What the operator reads when a run is interrupted. It cannot say whether the batch landed — the
 * worker may have died before its transaction committed or just after — so it sends them to where
 * the answer is, rather than inviting a blind re-upload that could register the same file twice.
 * (The same sentence the Bull-queue import used, kept word for word.)
 */
export const CUSTOMER_MASTER_INTERRUPTED =
  'This import was interrupted before it could report back (usually a server restart), and was not ' +
  'run again automatically because reconciling the same file twice registers it twice. Check this ' +
  "project's customer-master versions for the file before uploading it again.";

/** The type the version's own copy is stored as — what the route always stored it as. */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The parameters as the route received them, checked; a 400 a person can read otherwise. */
export function validCustomerMasterParams(raw: Partial<Record<keyof CustomerMasterImportParams, unknown>>): CustomerMasterImportParams {
  const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  if (!UUID.test(projectId)) throw new BadRequestException('Choose the project this client file belongs to.');
  const rawDate = typeof raw.auditDate === 'string' ? raw.auditDate.trim() : '';
  if (rawDate && (!ISO_DATE.test(rawDate) || Number.isNaN(new Date(`${rawDate}T00:00:00Z`).getTime()))) {
    throw new BadRequestException(`"${rawDate}" is not a date. Pick the audit date this file covers.`);
  }
  return { projectId, auditDate: rawDate || null };
}

const counted = (n: number, word: string) => `${n.toLocaleString('en-IN')} ${word}${n === 1 ? '' : 's'}`;

/** The one sentence the Jobs tray shows for a finished reconciliation. */
export function describeReconciliation(report: CustomerMasterReconciliationReportDto): BackgroundJobResult {
  const summary = report.accepted
    ? `Accepted as v${report.versionNumber}: ${counted(report.uniqueAccountsCount, 'account')}` +
      (report.unmatchedCount > 0 ? `, ${counted(report.unmatchedCount, 'row')} matched no branch.` : '.')
    : `Rejected. ${report.blockReason ?? 'The batch could not be reconciled.'}`;
  return {
    summary,
    counts: {
      rows: report.totalRowsProcessed,
      accounts: report.uniqueAccountsCount,
      duplicates: report.duplicateAccountsCount,
      unmatched: report.unmatchedCount,
      branches: report.coveredBranchCount,
    },
    // The report the Daily Run panel draws. Small by construction: the unmatched rows are capped
    // at 100 samples in the service (`unmatchedCount` carries the true total).
    details: report,
  };
}

@Injectable()
export class CustomerMasterImportJob implements OnModuleInit {
  constructor(
    private readonly registry: BackgroundJobRegistry,
    private readonly customerMaster: CustomerMasterService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
  ) {}

  onModuleInit(): void {
    this.registry.register<CustomerMasterImportParams>({
      kind: CUSTOMER_MASTER_IMPORT_KIND,
      input: 'required',
      idempotent: false,
      interruptedMessage: CUSTOMER_MASTER_INTERRUPTED,
      // One at a time, system-wide — what the old queue of its own with one loop guaranteed, so two
      // uploads can never reconcile and number versions at the same time.
      exclusive: 'kind',
      prepare: async ({ params, file, globalScope }) => {
        const { projectId, auditDate } = validCustomerMasterParams(params);
        if (!file) throw new BadRequestException('No file was uploaded. Choose the client file and try again.');
        // Narrower than the default allow-list on purpose: this route's whole job is "read an Excel
        // file", so a PDF or a photo is exactly as wrong here as an executable is.
        assertUploadAllowed({
          contentType: file.mimeType,
          size: file.size,
          fileName: file.originalName,
          allowed: SPREADSHEET_UPLOAD_TYPES,
        });
        await this.customerMaster.assertUploadTarget(projectId, globalScope);
        return {
          title: auditDate ? `Client file for ${auditDate}: ${file.originalName}` : `Client file: ${file.originalName}`,
        };
      },
      run: (ctx) => this.run(ctx),
    });
  }

  async run(ctx: RunContext<CustomerMasterImportParams>) {
    const { projectId, auditDate } = validCustomerMasterParams(ctx.params);
    const fileName = ctx.job.inputFileName ?? 'customer-master.xlsx';

    await ctx.stage('Reading the file');
    const buffer = await ctx.readInput();
    // The last point a cancel is honoured: from here the run registers a version, and stopping
    // half-way through that is what the transaction exists to prevent.
    await ctx.throwIfCancelled();

    // The version's own copy — see the header on why it is not the job's input key.
    const savedPath = await this.storage.saveFile(fileName, buffer, XLSX_MIME);
    let report: CustomerMasterReconciliationReportDto;
    try {
      report = await this.customerMaster.uploadAndReconcile(
        projectId,
        fileName,
        savedPath,
        buffer,
        ctx.actor.userId,
        auditDate ?? undefined,
        (done, total, stage) => ctx.progress(done, total, stage),
      );
    } catch (err) {
      // Nothing was registered (the version is written in one transaction), so its copy is unused.
      await this.storage.deleteFile(savedPath).catch(() => undefined);
      throw err;
    }

    // A rejected batch is still a finished reconciliation with a report — not a failed job, which
    // would bury every row that did match behind a red "failed". The report says it was rejected.
    return succeed(describeReconciliation(report));
  }
}
