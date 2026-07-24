import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditHistoryRecord } from './audit-history.entity';
import { AuditEvidence } from './audit-evidence.entity';
import { AuditHistoryService } from './audit-history.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuditHistoryRecord, AuditEvidence])],
  providers: [AuditHistoryService],
  exports: [AuditHistoryService],
})
export class AuditHistoryModule {}
