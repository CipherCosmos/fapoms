import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerMasterVersionEntity } from './customer-master-version.entity';
import { CustomerRecordEntity } from './customer-record.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { CustomerMasterService } from './customer-master.service';
import { CustomerMasterController } from './customer-master.controller';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { ImportModule } from '../import/import.module';
import { CustomerMasterImportWorker } from './customer-master-import.worker';

@Module({
  imports: [
    // ProjectEntity is registered for one field: the upload's `projectId` is how the reconciler
    // learns which client's branches a SOL ID may match. See `uploadAndReconcile`.
    TypeOrmModule.forFeature([CustomerMasterVersionEntity, CustomerRecordEntity, BranchEntity, ProjectEntity]),
    // StorageModule provides the 'StorageEngine' token for customer master Excel uploads.
    StorageModule,
    // The shared import queue: reconciliation runs on the queue, not in the upload request.
    ImportModule,
  ],
  controllers: [CustomerMasterController],
  providers: [CustomerMasterService, CustomerMasterImportWorker],
  exports: [CustomerMasterService],
})
export class CustomerMasterModule {}
