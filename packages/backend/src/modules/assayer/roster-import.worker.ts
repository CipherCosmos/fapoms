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

import { IMPORT_QUEUE, ROSTER_IMPORT_JOB } from '../import/import.constants';
import type { RosterImportJobData } from '../import/import-job.service';
import { RosterImportService, RosterImportSummary } from './roster-import.service';

@Injectable()
@Processor(IMPORT_QUEUE)
export class RosterImportWorker {
  private readonly logger = new Logger(RosterImportWorker.name);

  constructor(private readonly rosterImport: RosterImportService) {}

  /**
   * **The handler name matches what the producer adds.** Bull dispatches a named job only to a
   * handler registered under that exact name, and a mismatch fails silently — the job sits
   * unprocessed forever with no error anywhere. `ROSTER_IMPORT_JOB` is the single constant both
   * sides read.
   *
   * **`concurrency: 1` bounds the database work.** It does *not* stop this running alongside a
   * branch import: Bull's concurrency is per handler, so sharing the `import-jobs` queue does not
   * serialise the two. That is fine — `politely()` chains geocoder calls per host across the whole
   * process, so concurrent importers still produce one request per second at the provider. The slot
   * is here so one roster upload cannot run twice at once, each writing the same people.
   */
  @Process({ name: ROSTER_IMPORT_JOB, concurrency: 1 })
  async runRosterImport(job: Job<RosterImportJobData>): Promise<RosterImportSummary> {
    const { actorId, fileBase64, fileName, totalRows, sheetName } = job.data;
    const startedAt = Date.now();

    this.logger.log(`Roster import ${job.id} starting: ${totalRows} row(s) from ${fileName ?? 'an uploaded file'}.`);

    const summary = await this.rosterImport.importAssayerSheet(
      Buffer.from(fileBase64, 'base64'),
      actorId,
      // Never a rehearsal. A queued `dryRun` would spend the whole import writing nothing and then
      // report it to a page that has moved on — the rehearsal is the part the operator waits for,
      // so it stays in the request.
      { dryRun: false, sheetName: sheetName ?? undefined },
    );

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    this.logger.log(
      `Roster import ${job.id} finished in ${seconds}s: created=${summary.created} ` +
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
