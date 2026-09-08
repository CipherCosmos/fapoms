import { Injectable, Logger } from '@nestjs/common';
import { businessTodayDateKey } from '@fapoms/shared';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { SecurityIncidentService } from './security-incident.service';
import { DataRightsRequestService } from './data-rights-request.service';

/**
 * Statutory-clock escalation for the compliance register, run from the existing 15-minute SLA
 * scanner — the same mechanism FeedbackEscalationService and DeskEscalationService already use.
 *
 * Without this, a security incident's CERT-In (6h) or DPDP Board (72h) deadline, or a DPDP
 * rights request's response SLA, could pass with nobody told: the register only answers "is
 * anything overdue" to someone who opens /admin/compliance and looks. One reminder per breach
 * per day (day-bucketed dedupe), reusing each service's own `list()` — which already computes
 * the live clocks — rather than re-deriving the deadline arithmetic here.
 *
 * Only OPEN/CONTAINED incidents escalate. An overdue clock ignores status by design (a breach
 * stays reportable after closure), so without this gate a resolved-but-never-reported row —
 * typically a QA probe closed without filing anything — re-alerted every day forever, training
 * everyone to ignore the channel that carries real breaches. Closure is the clerk's sign-off
 * that the reporting question was dealt with; the count of skipped settled rows is logged, so
 * silence here is observable rather than silent.
 */
@Injectable()
export class ComplianceEscalationService {
  private readonly logger = new Logger(ComplianceEscalationService.name);

  constructor(
    private readonly incidents: SecurityIncidentService,
    private readonly rightsRequests: DataRightsRequestService,
    private readonly notificationDispatch: NotificationDispatchService,
  ) {}

  async scan(): Promise<void> {
    const day = businessTodayDateKey();
    let incidentBreaches = 0;
    let rightsBreaches = 0;
    let settledSkipped = 0;

    const incidents = await this.incidents.list();
    for (const inc of incidents) {
      // No status on very old fixtures means "unknown" — escalate rather than assume settled.
      if (inc.status && inc.status !== 'OPEN' && inc.status !== 'CONTAINED') {
        if (inc.clocks.certIn.overdue || inc.clocks.dpdpBoard.overdue) settledSkipped++;
        continue;
      }
      if (inc.clocks.certIn.overdue) {
        incidentBreaches++;
        this.notificationDispatch.emitSafe({
          type: 'SECURITY_INCIDENT_CLOCK_BREACHED',
          entityType: 'SECURITY_INCIDENT',
          entityId: inc.id,
          dedupeKey: `SECURITY_INCIDENT_CLOCK_BREACHED:${inc.id}:certIn:${day}`,
          payload: { title: inc.title, clockName: 'CERT-In 6-hour' },
        });
      }
      if (inc.clocks.dpdpBoard.overdue) {
        incidentBreaches++;
        this.notificationDispatch.emitSafe({
          type: 'SECURITY_INCIDENT_CLOCK_BREACHED',
          entityType: 'SECURITY_INCIDENT',
          entityId: inc.id,
          dedupeKey: `SECURITY_INCIDENT_CLOCK_BREACHED:${inc.id}:dpdpBoard:${day}`,
          payload: { title: inc.title, clockName: 'DPDP Board 72-hour report' },
        });
      }
    }

    const requests = await this.rightsRequests.list();
    for (const r of requests) {
      if (r.sla.overdue) {
        rightsBreaches++;
        this.notificationDispatch.emitSafe({
          type: 'DATA_RIGHTS_REQUEST_SLA_BREACH',
          entityType: 'DATA_RIGHTS_REQUEST',
          entityId: r.id,
          dedupeKey: `DATA_RIGHTS_REQUEST_SLA_BREACH:${r.id}:${day}`,
          payload: { requestType: r.requestType, days: Math.abs(Math.round(r.sla.daysRemaining ?? 0)) },
        });
      }
    }

    if (incidentBreaches > 0 || rightsBreaches > 0 || settledSkipped > 0) {
      this.logger.warn(`Compliance escalation scan: ${incidentBreaches} incident clock breach(es), ${rightsBreaches} rights-request SLA breach(es), ${settledSkipped} settled incident(s) with breached clocks skipped.`);
    }
  }
}
