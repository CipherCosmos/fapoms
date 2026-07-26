import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerMasterVersionEntity } from './customer-master-version.entity';
import { CustomerRecordEntity } from './customer-record.entity';
import { BranchEntity } from '../branch/branch.entity';
import { CustomerMasterService } from './customer-master.service';
import { CustomerMasterController } from './customer-master.controller';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CustomerMasterVersionEntity, CustomerRecordEntity, BranchEntity]),
  ],
  controllers: [CustomerMasterController],
  providers: [CustomerMasterService, LocalStorageService],
  exports: [CustomerMasterService],
})
export class CustomerMasterModule {}
