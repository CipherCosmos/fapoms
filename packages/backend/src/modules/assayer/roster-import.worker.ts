/**
 * FAPOMS — the consumer for queued appraiser-roster imports.
 *
 * See `ImportJobService` for why spreadsheet imports were moved off the request path at all. The
 * roster is the sharpest case: one row becomes a person plus their references, background checks,
 * onboarding documents and client empanelments, and the home address is geocoded. The web client
 * had compensated by giving the upload a **fifteen-minute** timeout — a page held open for a
 * quarter of an hour with nothing to look at, which is indistinguishable from a hung server and
 * invites the operator to upload the file a second time.
 */

import { Processor, Process } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bull';

import { ROSTER_IMPORT_QUEUE, ROSTER_IMPORT_JOB } from '../import/import.constants';
import type { RosterImportJobData } from '../import/import-job.service';
import { RosterImportService, RosterImportSummary } from './roster-import.service';

@Injectable()
@Processor(ROSTER_IMPORT_QUEUE)
export class RosterImportWorker {
  private readonly logger = new Logger(RosterImportWorker.name);

  constructor(private readonly rosterImport: RosterImportService) {}

  /**
   * **The handler name matches what the producer adds.** Bull dispatches a named job only to a
   * handler registered under that exact name, and a mismatch fails silently — the job sits
   * unprocessed forever with no error anywhere. `ROSTER_IMPORT_JOB` is the single constant both
   * sides read.
   *
   * **`concurrency: 1` on a queue of its own is what makes roster imports one at a time.** This
   * used to sit on the shared `import-jobs` queue, where it did not: Bull's loops belong to the
   * queue and take a job of any name, so the three import handlers there were three shared loops,
   * and two roster uploads could run side by side writing the same people. On
   * `ROSTER_IMPORT_QUEUE`, with this the only handler, the second upload waits for the first.
   *
   * It still runs alongside a branch or customer-master import, which is fine — `politely()` chains
   * geocoder calls per host across the whole process, so concurrent importers still produce one
   * request per second at the provider.
   *
   * A rehearsal (`dryRun`) comes through this same handler, so it queues behind a real import
   * rather than beside it — see `ImportJobService.enqueueRosterImport` for why that matters. A
   * separate handler for it would have been a second loop on this queue.
   *
   * A worker that dies mid-import is re-run from the top (Bull's default stalled recovery), which
   * this import tolerates by design — see `import.module.ts`.
   */
  @Process({ name: ROSTER_IMPORT_JOB, concurrency: 1 })
  async runRosterImport(job: Job<RosterImportJobData>): Promise<RosterImportSummary> {
    const { actorId, fileBase64, fileName, totalRows, sheetName, overwrite } = job.data;
    // Only an explicit `true` rehearses. A job queued before rehearsals were queued has no field,
    // and it was a real import; anything looser would quietly turn one into a rehearsal.
    const dryRun = job.data.dryRun === true;
    const what = dryRun ? 'rehearsal' : 'import';
    const startedAt = Date.now();

    this.logger.log(`Roster ${what} ${job.id} starting: ${totalRows} row(s) from ${fileName ?? 'an uploaded file'}.`);

    const summary = await this.rosterImport.importAssayerSheet(
      Buffer.from(fileBase64, 'base64'),
      actorId,
      // A rehearsal when the job says so. It used to stay in the request on the belief that it was
      // a quick look; it is the whole import inside a transaction that is rolled back — minutes for
      // a real roster — so it is queued like the import, and the page polls it the same way. The
      // web asks for the rehearsal, waits for its answer, and only then offers the real run.
      //
      // `fileName` and `overwrite` used to stop at `job.data` and never reach the importer, so
      // every queued run's `ROSTER_IMPORT_APPLIED` audit row said "an uploaded file" regardless
      // of what was actually uploaded, and no queued run could ever opt into overwriting a
      // disagreeing stored value — both silently defaulted, one to a wrong label, one to the
      // safe behavior with no way to choose otherwise.
      {
        dryRun, sheetName: sheetName ?? undefined,
        fileName: fileName ?? undefined, overwrite: overwrite ?? false,
      },
    );

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    this.logger.log(
      `Roster ${what} ${job.id} finished in ${seconds}s: created=${summary.created} ` +
        `updated=${summary.updated} skipped=${summary.skipped} issues=${summary.issues}`,
    );

    /**
     * Returned, not thrown, when rows failed.
     *
     * A roster with 12 unusable rows out of 700 is a successful import with a report attached, not
     * a failed job — throwing would bury the 688 that landed behind a red "failed" state. The
     * per-row reasons are already in the import-issues queue, which is where they get worked.
     */
    return summary;
  }
}
