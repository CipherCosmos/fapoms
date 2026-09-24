import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerMasterVersionEntity } from './customer-master-version.entity';
import { CustomerRecordEntity } from './customer-record.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { CustomerMasterService } from './customer-master.service';
import { CustomerMasterController } from './customer-master.controller';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { CustomerMasterImportJob } from './customer-master-import.job';

@Module({
  imports: [
    // ProjectEntity is registered for one field: the upload's `projectId` is how the reconciler
    // learns which client's branches a SOL ID may match. See `uploadAndReconcile`.
    TypeOrmModule.forFeature([CustomerMasterVersionEntity, CustomerRecordEntity, BranchEntity, ProjectEntity]),
    // StorageModule provides the 'StorageEngine' token for customer master Excel uploads.
    StorageModule,
  ],
  controllers: [CustomerMasterController],
  // CustomerMasterImportJob registers the CUSTOMER_MASTER_IMPORT background-job kind: the upload
  // route stores the file and answers 202, and the reconciliation runs in the worker. The foundation
  // (BackgroundJobsModule) is global, so nothing else needs importing for it.
  providers: [CustomerMasterService, CustomerMasterImportJob],
  exports: [CustomerMasterService],
})
export class CustomerMasterModule {}
