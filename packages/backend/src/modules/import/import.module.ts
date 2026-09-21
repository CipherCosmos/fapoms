import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';

import { IMPORT_QUEUE, ROSTER_IMPORT_QUEUE, CUSTOMER_MASTER_IMPORT_QUEUE } from './import.constants';
import { ImportJobService } from './import-job.service';

/**
 * FAPOMS — the queues every spreadsheet import goes through, one per import kind.
 *
 * ## Deliberately a leaf
 *
 * This module imports nothing but Bull, and that is the point. The queue used to be registered
 * inside `ProjectModule`, which meant only code that could already reach `ProjectService` was able
 * to enqueue an import — and `BranchModule` cannot, because `ProjectModule` imports *it*. So the
 * Branches page, which needed the queue most (its file is the 3,759-row one), was the one page
 * structurally unable to use it, and grew a second inline importer instead.
 *
 * Keeping this a leaf means any feature module can import it without thinking about cycles. The
 * consumers stay with whatever service actually knows how to run the rows — see
 * `project/import-job.worker.ts` — because the queues are what need sharing, not the work.
 *
 * ## Why three queues (see `import.constants.ts`)
 *
 * Bull's loops belong to a queue, not to a job name, so the only way each kind runs one at a time
 * is a queue per kind with a single `concurrency: 1` handler. They are registered in separate
 * `registerQueue` calls because `queue-registry.spec.ts` reads the first `name` of each call.
 *
 * ## What happens when a worker dies mid-import (Bull's stalled recovery)
 *
 * `attempts: 1` does not cover a worker that dies (deploy, out-of-memory) or whose lock lapses
 * mid-job: Bull recovers that as a *stalled* job on a separate counter, `maxStalledCount`, default
 * 1 — it puts the job back and runs it again from the top. Whether that is safe is a property of
 * what the import writes, so it is decided per queue:
 *
 * - **Branch imports keep the default.** Every row is found by SOL ID against a prefetch taken at
 *   the start of the run, then created or corrected; links and assessments are created only where
 *   missing. A second run from the top finds the first run's rows and converges on the same state.
 *   Re-running costs time, not correctness, and finishing an import the operator is watching beats
 *   leaving half a file behind a "stalled" failure.
 * - **Roster imports keep the default.** The rows are written in one transaction keyed on appraiser
 *   code (a death mid-write rolls all of it back); references, documents, empanelments and review
 *   issues are matched before they are written; lifecycle moves are only queued for people not
 *   already at the target. The importer was built to be re-run on a corrected file, and a restart
 *   is exactly that.
 * - **Customer-master imports are FAILED, not restarted (`maxStalledCount: 0`).** Every run
 *   registers a NEW version — the latest number plus one — and supersedes the active version for
 *   that audit date. It is not idempotent: if the first run's transaction committed before the
 *   worker died, or it is in fact still running after its lock lapsed, the re-run registers the same
 *   file a second time and supersedes the version the first run just made. A failed job instead
 *   tells the operator to check the versions list and decide (see
 *   `ImportJobService.getCustomerMasterImportStatus`).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: IMPORT_QUEUE }),
    BullModule.registerQueue({ name: ROSTER_IMPORT_QUEUE }),
    BullModule.registerQueue({
      name: CUSTOMER_MASTER_IMPORT_QUEUE,
      // Stalled means failed, never re-run — reconciliation registers a new version each time.
      settings: { maxStalledCount: 0 },
    }),
  ],
  providers: [ImportJobService],
  exports: [ImportJobService, BullModule],
})
export class ImportModule {}
