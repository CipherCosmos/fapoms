import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';

import { IMPORT_QUEUE } from './import.constants';
import { ImportJobService } from './import-job.service';

/**
 * FAPOMS — the one queue every spreadsheet import goes through.
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
 * consumer stays with whatever service actually knows how to run the rows — see
 * `project/import-job.worker.ts` — because the queue is what needs sharing, not the work.
 */
@Module({
  imports: [BullModule.registerQueue({ name: IMPORT_QUEUE })],
  providers: [ImportJobService],
  exports: [ImportJobService, BullModule],
})
export class ImportModule {}
