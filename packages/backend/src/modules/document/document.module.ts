import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { DocumentDispatchWorker } from './document-dispatch.worker';
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
    AssignmentModule,
  ],
  controllers: [DocumentController],
  providers: [DocumentService, DocumentDispatchWorker],
  exports: [DocumentService],
})
export class DocumentModule {}
