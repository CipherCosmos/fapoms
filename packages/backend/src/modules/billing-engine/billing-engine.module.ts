import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
import { BillingHistoryEntity } from './history.entity';
import { BillingEngineService } from './billing-engine.service';
import { BillingEngineController } from './billing-engine.controller';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { BILLING_QUEUE } from './billing-jobs.contract';
import { BillingJobsService } from './billing-jobs.service';
import { BillingJobsWorker } from './billing-jobs.worker';

@Module({
  imports: [
    NotificationsModule,
    /**
     * Its own queue, deliberately not 'background-jobs'.
     *
     * That queue adds *named* jobs through `BullQueueManager` while `BullProcessor` declares a
     * bare `@Process()`, which in Bull handles only jobs added with no name — so anything routed
     * through it dead-letters. The processor here registers `@Process({ name })` handlers whose
     * names come from the same constants the enqueue side reads, which is what stops the same
     * mistake recurring.
     */
    BullModule.registerQueue({ name: BILLING_QUEUE }),
    TypeOrmModule.forFeature([
      BillingEntryEntity,
      BillingInvoiceEntity,
      BillingPaymentEntity,
      AssayerPayableEntity,
      BillingHistoryEntity,
      AssignmentEntity,
      ProjectEntity,
      // Read-only here, for the payout bank file, the TDS report and the assayer's PAN on the
      // statement — the three finance outputs that need bank/PAN details the transformer decrypts.
      AssayerEntity,
    ]),
  ],
  controllers: [BillingEngineController],
  providers: [BillingEngineService, BillingJobsService, BillingJobsWorker],
  exports: [BillingEngineService, BillingJobsService],
})
export class BillingEngineModule {}
