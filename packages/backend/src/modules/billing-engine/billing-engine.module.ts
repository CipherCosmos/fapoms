import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
import { BillingConflictEntity } from './conflict.entity';
import { BillingHistoryEntity } from './history.entity';
import { BillingEngineService } from './billing-engine.service';
import { BillingEngineController } from './billing-engine.controller';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    NotificationsModule,
    TypeOrmModule.forFeature([
      BillingEntryEntity,
      BillingInvoiceEntity,
      BillingPaymentEntity,
      AssayerPayableEntity,
      BillingConflictEntity,
      BillingHistoryEntity,
      AssignmentEntity,
      ProjectEntity,
    ]),
  ],
  controllers: [BillingEngineController],
  providers: [BillingEngineService],
  exports: [BillingEngineService],
})
export class BillingEngineModule {}
