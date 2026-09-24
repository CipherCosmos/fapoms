import { Module, forwardRef, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { DocumentDispatchWorker } from './document-dispatch.worker';
import { DocumentAccessTokenService } from './document-access-token.service';
import { ChunkedUploadService } from './chunked-upload.service';
import { DocumentDispatchJobsService } from './document-dispatch-jobs.service';
import { GeneratedDocumentBatchJob } from './generated-document-batch.job';
import { DOCUMENT_DISPATCH_JOB, DOCUMENT_DISPATCH_QUEUE } from './document-dispatch-jobs.contract';
import { ensureRepeatableSchedules } from '../../infrastructure/queue/repeatable-schedules';
import { DocumentEntity } from './document.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { BranchEntity } from '../branch/branch.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { OcrModule } from '../../infrastructure/ocr/ocr.module';

import { ValidationModule } from '../validation/validation.module';
import { AssignmentModule } from '../assignment/assignment.module';

@Module({
  imports: [
    // BranchEntity: dispatching to a branch writes the address back so the desk types it once.
    TypeOrmModule.forFeature([DocumentEntity, AssessmentEntity, ProjectBranchEntity, AssignmentEntity, BranchEntity]),
    BullModule.registerQueue({
      name: DOCUMENT_DISPATCH_QUEUE,
      /*
        A job whose worker died mid-run (deploy, out-of-memory, lost lock) is FAILED, not restarted.
        Bull's default re-runs a stalled job once from the top, and a batch restarted from the top
        re-sends whatever mail had gone out before the status write that would have stopped it.
        `attempts: 1` alone does not stop that — stalled recovery is a separate counter. The hourly
        auto-dispatch loses nothing by it: the next tick re-scans everything still UPLOADED.
      */
      settings: { maxStalledCount: 0 },
    }),
    NotificationsModule,
    StorageModule,
    OcrModule,
    ValidationModule,
    forwardRef(() => AssignmentModule),
  ],
  controllers: [DocumentController],
  providers: [
    DocumentService,
    DocumentDispatchWorker,
    DocumentDispatchJobsService,
    // Registers GENERATED_DOCUMENT_BATCH: a day's packets, stored by the upload route and filed
    // (scanned, typed, matched, recorded) in the background worker.
    GeneratedDocumentBatchJob,
    DocumentAccessTokenService,
    ChunkedUploadService,
  ],
  exports: [DocumentService, DocumentAccessTokenService],
})
export class DocumentModule implements OnModuleInit {
  private readonly logger = new Logger(DocumentModule.name);

  constructor(@InjectQueue(DOCUMENT_DISPATCH_QUEUE) private readonly dispatchQueue: Queue) {}

  // Hourly rather than once a day. The worker dispatches anything whose audit date is on or
  // before tomorrow (spec §12.6), so an hourly sweep still honours the "1 day before" rule
  // while also picking up pre-field PDFs uploaded partway through the day, instead of making
  // them wait for the next daily tick. It is idempotent: only UPLOADED documents are eligible,
  // and dispatching moves them to DISPATCHED, so a document is never sent twice.
  private static readonly CRON = '0 * * * *';

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;

    // DocumentDispatchWorker has existed and been correct for some time, but nothing ever
    // enqueued to this queue — so auto-dispatch had never once run. This is the missing
    // producer. Non-blocking and non-fatal: see ensureRepeatableSchedules.
    ensureRepeatableSchedules(this.dispatchQueue, [{ name: DOCUMENT_DISPATCH_JOB.AUTO_DISPATCH, cron: DocumentModule.CRON }], this.logger);
  }
}
