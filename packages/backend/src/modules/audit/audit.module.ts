import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEntity } from './audit.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from './audit.service';
import { BillingModule } from '../billing/billing.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuditHistoryModule } from '../audit-history/audit-history.module';

import { AuditController } from './audit.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditEntity, AssignmentEntity]),
    BillingModule,
    LedgerModule,
    AuditHistoryModule,
  ],
  controllers: [AuditController],
  providers: [{ provide: 'AuditPlatformService', useClass: AuditService }, AuditService],
  exports: ['AuditPlatformService', AuditService],
})
export class AuditPlatformModule {}
