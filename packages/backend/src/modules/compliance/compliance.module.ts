import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SecurityIncidentEntity } from './security-incident.entity';
import { SecurityIncidentService } from './security-incident.service';
import { DataRightsRequestEntity } from './data-rights-request.entity';
import { DataRightsRequestService } from './data-rights-request.service';
import { ComplianceController } from './compliance.controller';

/**
 * Compliance operations — the security-incident register and the compliance-health summary.
 *
 * AuditService (for auditing incident changes) and AuditSealService (for the sealing backlog in the
 * health summary) both come from the global AuditModule, so nothing here imports them.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SecurityIncidentEntity, DataRightsRequestEntity])],
  controllers: [ComplianceController],
  providers: [SecurityIncidentService, DataRightsRequestService],
})
export class ComplianceModule {}
