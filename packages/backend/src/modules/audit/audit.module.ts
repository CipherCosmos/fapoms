import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEntity } from './audit.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from './audit.service';
import { BillingEngineModule } from '../billing-engine/billing-engine.module';
import { AuditHistoryModule } from '../audit-history/audit-history.module';

import { AuditController } from './audit.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditEntity, AssignmentEntity]),
    BillingEngineModule,
    AuditHistoryModule,
  ],
  controllers: [AuditController],
  providers: [{ provide: 'AuditPlatformService', useClass: AuditService }, AuditService],
  exports: ['AuditPlatformService', AuditService],
})
export class AuditPlatformModule {}
