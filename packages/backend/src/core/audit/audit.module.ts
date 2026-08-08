/**
 * FAPOMS — Audit Module
 *
 * Provides the AuditService globally to all modules.
 */

import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEventEntity } from './audit-event.entity';
import { AuditService } from './audit.service';
import { UnifiedAuditService } from './unified-audit.service';
import { AuditLogController } from './audit.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditEventEntity])],
  controllers: [AuditLogController],
  providers: [AuditService, UnifiedAuditService],
  exports: [AuditService, UnifiedAuditService],
})
export class AuditModule {}
