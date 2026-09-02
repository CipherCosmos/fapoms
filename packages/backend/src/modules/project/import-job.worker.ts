/**
 * FAPOMS — the consumer for `import-jobs`.
 *
 * See `ImportJobService` for why spreadsheet imports were moved off the request path at all.
 */

import { Processor, Process } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bull';

import { IMPORT_QUEUE, BRANCH_IMPORT_JOB } from '../import/import.constants';
import { BranchImportJobData, ImportJobService } from '../import/import-job.service';
import type { BranchImportOutcome } from '../import/import.contract';
import { ProjectService } from './project.service';

@Injectable()
@Processor(IMPORT_QUEUE)
export class ImportJobWorker {
  private readonly logger = new Logger(ImportJobWorker.name);

  constructor(private readonly projectService: ProjectService) {}

  /**
   * Import a project's branch list from an uploaded workbook.
   *
   * **The handler is named, and the name matches what the producer adds.** That is not
   * incidental: Bull dispatches a named job only to a handler registered under that exact name.
   * The shared `background-jobs` queue in `infrastructure/queue/` gets this wrong in the other
   * direction — `BullQueueManager` adds named jobs while `bull-processor.ts` declares a bare
   * `@Process()` — so every job on it stalls and is eventually dead-lettered, without an error
   * anywhere. `BRANCH_IMPORT_JOB` is the single constant both sides read, so the two cannot
   * drift apart.
   *
   * **`concurrency: 1` bounds the database work, not the geocoding.** `politely()` chains its
   * calls per *host* across the whole process, so however many importers are running, the provider
   * still sees one request per second — this slot is not what keeps the deployment inside
   * Nominatim's limit, and an earlier version of this comment claimed it was. What one slot buys is
   * that a single import cannot run two copies of itself, and that a re-upload queues behind the
   * first attempt instead of racing it into the same rows. Neither the slot nor `politely()` solves
   * the multi-replica case; see the note at the bottom of this file.
   */
  @Process({ name: BRANCH_IMPORT_JOB, concurrency: 1 })
  async runBranchImport(job: Job<BranchImportJobData>): Promise<BranchImportOutcome> {
    const { userId, fileBase64, totalRows, rowsNeedingGeocode } = job.data;
    const startedAt = Date.now();

    /**
     * Read through `scopeOf` rather than off the payload, so a job enqueued by the previous build
     * — which wrote `projectId` and no `scope` — still runs after a deploy instead of failing on a
     * field that moved. `attempts: 1` means nothing would re-create it.
     */
    const scope = ImportJobService.scopeOf(job.data);
    if (!scope) {
      throw new Error(
        `Branch import ${job.id} carries neither a scope nor a projectId, so there is nothing to ` +
          'import it into. This job cannot be run; re-upload the file.',
      );
    }

    this.logger.log(
      `Branch import ${job.id} starting: ${scope.kind.toLowerCase()}=${scope.id} ` +
        `rows=${totalRows} geocodes=${rowsNeedingGeocode}`,
    );

    const outcome = await this.projectService.runBranchImport(
      scope,
      Buffer.from(fileBase64, 'base64'),
      userId,
      /**
       * Published to Redis so the poll endpoint can answer "how far has it got?".
       *
       * Deliberately fire-and-forget with the rejection swallowed: `job.progress()` is a network
       * write, and a Redis hiccup while reporting progress must not abort an import that is
       * otherwise succeeding. The operator would rather have the branches and a stale progress
       * bar than neither. `ProjectService` already throttles how often this is called.
       */
      (progress) => {
        void job.progress(progress).catch((err: Error) => {
          this.logger.warn(`Branch import ${job.id}: could not publish progress — ${err?.message}`);
        });
      },
    );

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    this.logger.log(
      `Branch import ${job.id} finished in ${seconds}s: created=${outcome.created} ` +
        `updated=${outcome.updated} linked=${outcome.linked} ` +
        `skipped=${outcome.skipped.length} imprecise=${outcome.imprecise.length}`,
    );

    /**
     * Returned, not thrown, when rows failed.
     *
     * A file with 12 unusable rows out of 400 is a successful import with a report attached, not
     * a failed job — throwing would bury the 388 that landed behind a red "failed" state and,
     * with retries configured, would re-run the whole thing. The per-row reasons travel in the
     * result, which is what the operator actually needs to fix their sheet.
     */
    return outcome;
  }
}

/**
 * ## Known limitation: the provider rate limit is per-process, not global
 *
 * `politely()` (geo/osm-geocoder.ts) holds its per-host timestamps in module-level maps, so it
 * bounds one Node process. `concurrency: 1` above extends that to "one import at a time per
 * worker", which is sufficient for the current single-worker deployment. It is *not* sufficient
 * if the backend is ever scaled to several job-processing replicas: two workers would each
 * believe they are within Nominatim's 1 request/second, while the provider sees two — and the
 * providers enforce by IP, so the whole deployment shares one budget.
 *
 * Fixing it properly needs a token bucket in Redis (which this deployment already runs) checked
 * inside `politely()`. That cannot be done well from here: the geocoders are plain module
 * functions imported by services, workers and the standalone seed script alike, so giving them a
 * Redis dependency means either threading a client through every caller or introducing a global
 * singleton — a design decision that belongs with whoever owns the geo module's shape, not with
 * a change to the import path. Until then the operational rule is: run exactly one replica with
 * `PROCESS_ROLE` unset or `worker`, and keep every other replica on `PROCESS_ROLE=api`.
 */
