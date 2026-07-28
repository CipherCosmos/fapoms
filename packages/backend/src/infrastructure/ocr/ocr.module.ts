import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { OcrProcessingService } from './ocr-processing.service';
import { OcrBoundaryController } from './ocr-boundary.controller';
import { OcrJobEntity } from './ocr-job.entity';
import { DocumentEntity } from '../../modules/document/document.entity';
import { ValidationModule } from '../../modules/validation/validation.module';
import { OcrWorker } from '../../workers/ocr.worker';

@Module({
  imports: [
    TypeOrmModule.forFeature([OcrJobEntity, DocumentEntity]),
    BullModule.registerQueue({ name: 'ocr' }),
    ValidationModule,
  ],
  controllers: [OcrBoundaryController],
  providers: [OcrProcessingService, OcrWorker],
  exports: [OcrProcessingService],
})
export class OcrModule {}
