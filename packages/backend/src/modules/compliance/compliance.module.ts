import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SecurityIncidentEntity } from './security-incident.entity';
import { SecurityIncidentService } from './security-incident.service';
import { DataRightsRequestEntity } from './data-rights-request.entity';
import { DataRightsRequestService } from './data-rights-request.service';
import { ComplianceEscalationService } from './compliance-escalation.service';
import { ComplianceController } from './compliance.controller';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Compliance operations — the security-incident register and the compliance-health summary.
 *
 * AuditService (for auditing incident changes) and AuditSealService (for the sealing backlog in the
 * health summary) both come from the global AuditModule, so nothing here imports them.
 *
 * NotificationsModule provides NotificationDispatchService: raising an incident or logging a rights
 * request notifies ADMIN/AUDITOR, and ComplianceEscalationService (run from the SLA scanner, see
 * SlaScannerModule) chases a statutory clock or rights-request SLA that has actually breached.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SecurityIncidentEntity, DataRightsRequestEntity]), NotificationsModule],
  controllers: [ComplianceController],
  providers: [SecurityIncidentService, DataRightsRequestService, ComplianceEscalationService],
  exports: [SecurityIncidentService, DataRightsRequestService, ComplianceEscalationService],
})
export class ComplianceModule {}
