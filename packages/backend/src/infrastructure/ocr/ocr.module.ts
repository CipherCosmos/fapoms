import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OcrProcessingService } from './ocr-processing.service';
import { OcrBoundaryController } from './ocr-boundary.controller';
import { OcrJobEntity } from './ocr-job.entity';
import { DocumentEntity } from '../../modules/document/document.entity';
import { ValidationModule } from '../../modules/validation/validation.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([OcrJobEntity, DocumentEntity]),
    ValidationModule,
  ],
  controllers: [OcrBoundaryController],
  providers: [OcrProcessingService],
  exports: [OcrProcessingService],
})
export class OcrModule {}
