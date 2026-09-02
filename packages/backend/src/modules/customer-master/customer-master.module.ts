import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerMasterVersionEntity } from './customer-master-version.entity';
import { CustomerRecordEntity } from './customer-record.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { CustomerMasterService } from './customer-master.service';
import { CustomerMasterController } from './customer-master.controller';
import { StorageModule } from '../../infrastructure/storage/storage.module';

@Module({
  imports: [
    // ProjectEntity is registered for one field: the upload's `projectId` is how the reconciler
    // learns which client's branches a SOL ID may match. See `uploadAndReconcile`.
    TypeOrmModule.forFeature([CustomerMasterVersionEntity, CustomerRecordEntity, BranchEntity, ProjectEntity]),
    // StorageModule provides the 'StorageEngine' token for customer master Excel uploads.
    StorageModule,
  ],
  controllers: [CustomerMasterController],
  providers: [CustomerMasterService],
  exports: [CustomerMasterService],
})
export class CustomerMasterModule {}
