import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ExpenseEntity } from './expense.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
// Read-only: the approval rules ask what state the bill carrying the job's pay is in.
import { AssayerInvoiceEntity } from '../billing-engine/assayer-invoice.entity';
import { ExpenseService } from './expense.service';
import { ExpenseController } from './expense.controller';
// AuditService comes from the @Global AuditModule, so it needs no import here.
import { NotificationsModule } from '../notifications/notifications.module';
// Approved claims are reimbursed through the existing payables mechanism rather than a second
// payout path of their own — see ExpenseService.review.
import { BillingEngineModule } from '../billing-engine/billing-engine.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExpenseEntity, AssignmentEntity, AssayerInvoiceEntity]),
    NotificationsModule,
    BillingEngineModule,
  ],
  controllers: [ExpenseController],
  providers: [ExpenseService],
  exports: [ExpenseService],
})
export class ExpenseModule {}
