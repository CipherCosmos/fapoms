/**
 * FAPOMS — a day's generated pre-field audit packets, filed in the background.
 *
 * The external application returns one PDF per branch for the whole day's run, and the desk uploads
 * them together (up to 100). `POST /documents/upload-generated-batch` stores the set and answers 202
 * with the job; this files it in the worker: match each file to its branch by filename, then per
 * file scan it, type-check it, copy it to its own storage key and record the document. Progress is
 * per file, and the job — with which packets were filed, which could not be placed and why — lives
 * on a `background_jobs` row, so a refresh of the Daily Run page finds it again.
 *
 * ## Every file is scanned here, before it is stored as a document
 *
 * The route does not scan in the request (that is the wait this move removes — see
 * `DiskUploadCleanupInterceptor`). So `fileOne` runs `FileScanService.scanOrThrow` — the malware
 * scan AND the byte-level content gate every upload path has — on each file's bytes before anything
 * is written. An infected or refused file lands in `failed` with the reason; the rest are filed.
 * `upload-scan-parity.spec.ts` pins the call and its position.
 *
 * ## Not re-run after an interruption
 *
 * Filing creates documents, so a run started again from the top would file the packets it had
 * already filed a second time. `idempotent: false`: an interrupted run is FAILED with a sentence
 * that sends the desk to the day's board — which shows exactly which branches already have their
 * packet — rather than guessing. (Making re-runs skip what this job filed would need a record of
 * the job on the document; the board already answers the question, so that was not added.)
 *
 * ## The documents keep their own copies
 *
 * The job's input objects are deleted by retention after 30 days; a document lives for years. Each
 * filed packet is copied to its own storage key, and that key — never the job's — is what the
 * document records.
 */

import { BadRequestException, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DocumentType, type BackgroundJobResult } from '@fapoms/shared';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import {
  BackgroundJobCancelledError,
  succeed,
  type RunContext,
  type RunInputFile,
} from '../../infrastructure/background-jobs/background-jobs.contract';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { FileScanService } from '../../infrastructure/security/file-scan.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import type { GlobalScope } from '../../infrastructure/scope/global-scope';
import { DocumentService } from './document.service';
import { assertUploadAllowed, SCAN_UPLOAD_TYPES } from './upload-validation';
import { deriveFileIntegrity } from './document-integrity';

export const GENERATED_DOCUMENT_BATCH_KIND = 'GENERATED_DOCUMENT_BATCH' as const;

export interface GeneratedDocumentBatchParams {
  projectId: string;
  auditDate: string;
  /** The client batch the packets were generated from, when there is one. */
  customerMasterVersionId: string | null;
}

export interface GeneratedBatchOutcome {
  auditDate: string;
  created: Array<{ documentId: string; fileName: string; branchName: string }>;
  /** Files matched to no branch, or to several (ambiguous) — the reason says which. */
  unmatched: Array<{ fileName: string; reason: string }>;
  /** Files that matched a branch but were not filed: infected, refused by type, or failed to store. */
  failed: Array<{ fileName: string; reason: string }>;
  /** Scheduled branches the upload did not cover (capped; the true total is `branchesWithoutFileCount`). */
  branchesWithoutFile: Array<{ projectBranchId: string; branchName: string; solId: string | null }>;
  branchesWithoutFileCount: number;
}

/** Keeps `result` far under the foundation's 64 KB: a day rarely has this many branches unfiled. */
const BRANCHES_WITHOUT_FILE_LIMIT = 200;

export const GENERATED_BATCH_INTERRUPTED =
  'This batch was interrupted part-way (usually a server restart) and was not run again ' +
  'automatically, because filing the same packets twice files them twice. Check the day\'s board ' +
  'for the branches that already have their packet, then upload only the rest.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The parameters as the route received them, checked; a 400 a person can read otherwise. */
export function validBatchParams(raw: Partial<Record<keyof GeneratedDocumentBatchParams, unknown>>): GeneratedDocumentBatchParams {
  const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  if (!UUID.test(projectId)) throw new BadRequestException('Choose the project these packets belong to.');
  const auditDate = typeof raw.auditDate === 'string' ? raw.auditDate.trim() : '';
  if (!auditDate) throw new BadRequestException('auditDate is required.');
  if (!ISO_DATE.test(auditDate) || Number.isNaN(new Date(`${auditDate}T00:00:00Z`).getTime())) {
    throw new BadRequestException(`"${auditDate}" is not a date. Pick the audit date these packets are for.`);
  }
  const rawVersion = typeof raw.customerMasterVersionId === 'string' ? raw.customerMasterVersionId.trim() : '';
  if (rawVersion && !UUID.test(rawVersion)) throw new BadRequestException('customerMasterVersionId must be a UUID.');
  return { projectId, auditDate, customerMasterVersionId: rawVersion || null };
}

/** The sentence the desk reads — the same one the synchronous route answered with. */
export function describeBatch(outcome: GeneratedBatchOutcome, fileCount: number): BackgroundJobResult {
  const summary =
    `Filed ${outcome.created.length} of ${fileCount} packet(s).` +
    (outcome.unmatched.length ? ` ${outcome.unmatched.length} could not be matched to a branch.` : '') +
    (outcome.failed.length ? ` ${outcome.failed.length} could not be filed.` : '') +
    (outcome.branchesWithoutFileCount ? ` ${outcome.branchesWithoutFileCount} scheduled branch(es) still have no packet.` : '');
  return {
    summary,
    counts: {
      files: fileCount,
      created: outcome.created.length,
      unmatched: outcome.unmatched.length,
      failed: outcome.failed.length,
      branchesWithoutFile: outcome.branchesWithoutFileCount,
    },
    details: outcome,
  };
}

@Injectable()
export class GeneratedDocumentBatchJob implements OnModuleInit {
  constructor(
    private readonly registry: BackgroundJobRegistry,
    private readonly documentService: DocumentService,
    private readonly fileScanner: FileScanService,
    private readonly regionGuard: RegionGuardService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
  ) {}

  onModuleInit(): void {
    this.registry.register<GeneratedDocumentBatchParams>({
      kind: GENERATED_DOCUMENT_BATCH_KIND,
      input: 'files',
      idempotent: false,
      interruptedMessage: GENERATED_BATCH_INTERRUPTED,
      // One batch per project at a time, so two uploads of the same day cannot each file a packet
      // against the same branch at the same moment.
      exclusive: 'scope',
      prepare: async ({ params, files }) => {
        const { auditDate } = validBatchParams(params);
        if (files.length === 0) throw new BadRequestException('No files received.');
        return {
          title: `${files.length} audit packet${files.length === 1 ? '' : 's'} for ${auditDate}`,
          total: files.length,
        };
      },
      run: (ctx) => this.run(ctx),
    });
  }

  async run(ctx: RunContext<GeneratedDocumentBatchParams>) {
    const params = validBatchParams(ctx.params);
    const files = ctx.inputFiles;
    const total = files.length;

    await ctx.stage('Matching files to branches');
    const { matches, unmatched, branchesWithoutFile } = await this.documentService.matchPdfsToBranches(
      params.projectId,
      params.auditDate,
      files.map((f) => f.fileName),
    );

    // The region ceiling, per matched branch, before the first file is filed — as the route
    // enforced it in the request. Checked again here against the regions captured with the job,
    // because a branch can move region, or a person lose one, between the upload and the run.
    for (const m of matches) {
      const region = await this.documentService.resolveProjectBranchRegion(m.projectBranchId);
      await this.regionGuard.assertRegionAllowedStaged(region, { regions: ctx.regions as GlobalScope['regions'] }, 'document:uploadGeneratedBatch');
    }

    // Two files with one name are two files; each match takes the next one of its name.
    const byName = new Map<string, RunInputFile[]>();
    for (const f of files) byName.set(f.fileName, [...(byName.get(f.fileName) ?? []), f]);

    const outcome: GeneratedBatchOutcome = {
      auditDate: params.auditDate,
      created: [],
      unmatched,
      failed: [],
      branchesWithoutFile: branchesWithoutFile.slice(0, BRANCHES_WITHOUT_FILE_LIMIT),
      branchesWithoutFileCount: branchesWithoutFile.length,
    };
    let processed = unmatched.length;
    await ctx.progress(processed, total, 'Filing packets');

    // Only files that matched exactly one branch are stored. An unmatched file is returned to the
    // operator rather than filed against a guessed branch — a misfiled packet sends one branch's
    // customers to another branch's assayer.
    for (const m of matches) {
      const file = byName.get(m.fileName)?.shift();
      if (!file) continue;
      if (await ctx.isCancelRequested()) {
        throw new BackgroundJobCancelledError(describeBatch(outcome, total));
      }
      try {
        const documentId = await this.fileOne(file, m.projectBranchId, params, ctx.actor.userId);
        outcome.created.push({ documentId, fileName: file.fileName, branchName: m.branchName });
      } catch (err) {
        // One bad packet is a line in `failed`, never the end of the batch.
        outcome.failed.push({ fileName: file.fileName, reason: (err as Error).message });
      }
      processed++;
      await ctx.progress(processed, total, 'Filing packets');
    }

    return succeed(describeBatch(outcome, total));
  }

  /**
   * One packet: scan it, type-check it, copy it to its own key, record the document. Scanning comes
   * FIRST and is not optional — this is the only scan these bytes get (the route defers it here).
   * Returns the new document's id; throws a sentence for the desk when the packet is refused.
   */
  async fileOne(
    file: RunInputFile,
    projectBranchId: string,
    params: GeneratedDocumentBatchParams,
    userId: string,
  ): Promise<string> {
    const bytes = await file.read();
    // Malware scan + the byte-level content gate (`assertUploadContent`), on the real bytes.
    await this.fileScanner.scanOrThrow(bytes, file.fileName, file.mimeType);
    // What a generated audit packet can actually be — the route's own narrower type gate.
    assertUploadAllowed({
      contentType: file.mimeType,
      size: file.size,
      fileName: file.fileName,
      allowed: SCAN_UPLOAD_TYPES,
    });
    const integrity = deriveFileIntegrity(bytes, file.mimeType);
    const key = await this.storage.saveFile(file.fileName, bytes, file.mimeType ?? undefined, file.size);
    try {
      const doc = await this.documentService.create({
        assessmentId: projectBranchId,
        fileName: file.fileName,
        filePath: key,
        fileSize: file.size,
        mimeType: file.mimeType ?? undefined,
        type: DocumentType.PRE_FIELD_AUDIT_PDF,
        customerMasterVersionId: params.customerMasterVersionId ?? undefined,
        integrity,
      }, userId);
      return doc.id;
    } catch (err) {
      // No document points at it, so the copy is an orphan; leave nothing behind.
      await this.storage.deleteFile(key).catch(() => undefined);
      throw err;
    }
  }
}
