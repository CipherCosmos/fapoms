import { Module, forwardRef, OnModuleInit, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { DocumentDispatchWorker } from './document-dispatch.worker';
import { DocumentAccessTokenService } from './document-access-token.service';
import { ChunkedUploadService } from './chunked-upload.service';
import { DocumentEntity } from './document.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { OcrModule } from '../../infrastructure/ocr/ocr.module';

import { ValidationModule } from '../validation/validation.module';
import { AssignmentModule } from '../assignment/assignment.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DocumentEntity, AssessmentEntity, ProjectBranchEntity, AssignmentEntity]),
    BullModule.registerQueue({ name: 'document-dispatch' }),
    NotificationsModule,
    StorageModule,
    OcrModule,
    ValidationModule,
    forwardRef(() => AssignmentModule),
  ],
  controllers: [DocumentController],
  providers: [DocumentService, DocumentDispatchWorker, DocumentAccessTokenService, ChunkedUploadService],
  exports: [DocumentService, DocumentAccessTokenService],
})
export class DocumentModule implements OnModuleInit {
  private readonly logger = new Logger(DocumentModule.name);

  constructor(@InjectQueue('document-dispatch') private readonly dispatchQueue: Queue) {}

  // Hourly rather than once a day. The worker dispatches anything whose audit date is on or
  // before tomorrow (spec §12.6), so an hourly sweep still honours the "1 day before" rule
  // while also picking up pre-field PDFs uploaded partway through the day, instead of making
  // them wait for the next daily tick. It is idempotent: only UPLOADED documents are eligible,
  // and dispatching moves them to DISPATCHED, so a document is never sent twice.
  private static readonly CRON = '0 * * * *';

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;

    // DocumentDispatchWorker has existed and been correct for some time, but nothing ever
    // enqueued to this queue — so auto-dispatch had never once run. This is the missing
    // producer.
    //
    // Same stale-schedule cleanup as SlaScannerModule: Bull keys repeatable jobs by cron
    // string, so changing CRON would otherwise add a second schedule rather than replace the
    // first, leaving both firing forever.
    const existing = await this.dispatchQueue.getRepeatableJobs();
    for (const job of existing) {
      if (job.name === 'auto-dispatch' && job.cron !== DocumentModule.CRON) {
        await this.dispatchQueue.removeRepeatableByKey(job.key);
        this.logger.warn(`Removed stale auto-dispatch schedule: ${job.cron}`);
      }
    }

    await this.dispatchQueue.add(
      'auto-dispatch',
      {},
      { repeat: { cron: DocumentModule.CRON }, removeOnComplete: true, removeOnFail: false },
    );
    this.logger.log('Document auto-dispatch repeatable job registered (hourly)');
  }
}
