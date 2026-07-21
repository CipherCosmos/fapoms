import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { DocumentEntity } from './document.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';

import { StorageModule } from '../../infrastructure/storage/storage.module';
import { OcrModule } from '../../infrastructure/ocr/ocr.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DocumentEntity, ProjectBranchEntity]),
    StorageModule,
    OcrModule,
  ],
  controllers: [DocumentController],
  providers: [DocumentService],
  exports: [DocumentService],
})
export class DocumentModule {}
