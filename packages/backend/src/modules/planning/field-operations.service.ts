import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { FieldVisitEntity, FieldVisitStatus } from './field-visit.entity';
import { FieldIncidentEntity, IncidentStatus, IncidentSeverity } from './field-incident.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';

export interface HandoverPackage {
  visitId: string;
  branchId: string;
  assayerId: string;
  timestamp: string;
  evidenceMetadata: {
    hasFormPayload: boolean;
    totalImageAttachments: number;
  };
  ocrDeliveryTarget: string;
}

export interface FieldDashboardSummary {
  visitsInProgress: number;
  visitsDelayed: number;
  awaitingSubmission: number;
  awaitingEvidence: number;
  activeIncidentsCount: number;
  criticalIncidentsCount: number;
  completionPercentage: number;
}

@Injectable()
export class FieldOperationsService {
  constructor(
    @InjectRepository(FieldVisitEntity)
    private readonly visitRepository: Repository<FieldVisitEntity>,
    @InjectRepository(FieldIncidentEntity)
    private readonly incidentRepository: Repository<FieldIncidentEntity>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Initializes a new FieldVisit following operational package deployment.
   */
  async createFieldVisit(
    coveragePlanId: string,
    executionGroupId: string,
    branchId: string,
    assayerId: string,
    plannedDate: string,
    userId?: string,
  ): Promise<FieldVisitEntity> {
    const visit = this.visitRepository.create({
      coveragePlanId,
      executionGroupId,
      branchId,
      assayerId,
      plannedDate,
      status: FieldVisitStatus.READY,
      evidenceReadiness: {
        documentsCollected: false,
        photosCollected: false,
        formsCompleted: false,
        missingEvidenceList: ['Mandatory Form 1A', 'Store Front Photo'],
      },
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.visitRepository.save(visit);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'FIELD_VISIT_CREATED',
      entityType: 'FIELD_VISIT',
      entityId: saved.id,
      newState: FieldVisitStatus.READY,
      userId,
      remarks: `Field visit planned for ${plannedDate}.`,
      metadata: { coveragePlanId, executionGroupId, branchId, assayerId, plannedDate },
    });

    return saved;
  }

  /**
   * Transitions field visit execution states.
   */
  async transitionVisitStatus(visitId: string, targetStatus: FieldVisitStatus, userId?: string): Promise<FieldVisitEntity> {
    const visit = await this.visitRepository.findOne({ where: { id: visitId } });
    if (!visit) {
      throw new NotFoundException(`Field visit ${visitId} not found.`);
    }

    if (targetStatus === FieldVisitStatus.AUDIT_STARTED) {
      visit.actualStartTime = new Date();
    } else if (targetStatus === FieldVisitStatus.AUDIT_COMPLETED) {
      visit.actualEndTime = new Date();
    }

    const previousStatus = visit.status;
    visit.status = targetStatus;
    visit.updatedBy = userId ?? visit.updatedBy;
    const saved = await this.visitRepository.save(visit);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'FIELD_VISIT_STATUS_CHANGED',
      entityType: 'FIELD_VISIT',
      entityId: saved.id,
      previousState: previousStatus,
      newState: targetStatus,
      userId,
      remarks: `Field visit moved ${previousStatus} → ${targetStatus}.`,
      metadata: {
        branchId: saved.branchId,
        assayerId: saved.assayerId,
        actualStartTime: saved.actualStartTime ?? null,
        actualEndTime: saved.actualEndTime ?? null,
      },
    });

    return saved;
  }

  /**
   * Logs a blocker or operational incident in the field.
   */
  async reportIncident(visitId: string, title: string, description: string, severity: IncidentSeverity, userId?: string): Promise<FieldIncidentEntity> {
    const visit = await this.visitRepository.findOne({ where: { id: visitId } });
    if (!visit) {
      throw new NotFoundException(`Field visit ${visitId} not found.`);
    }

    const incident = this.incidentRepository.create({
      visitId,
      title,
      description,
      severity,
      status: IncidentStatus.REPORTED,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.incidentRepository.save(incident);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'FIELD_INCIDENT_REPORTED',
      entityType: 'FIELD_INCIDENT',
      entityId: saved.id,
      newState: IncidentStatus.REPORTED,
      userId,
      remarks: `${severity} incident on visit ${visitId}: ${title}`,
      metadata: { visitId, branchId: visit.branchId, assayerId: visit.assayerId, severity, title, description },
    });

    return saved;
  }

  /**
   * Resolves a logged field incident.
   */
  async resolveIncident(incidentId: string, details: string, userId?: string): Promise<FieldIncidentEntity> {
    const incident = await this.incidentRepository.findOne({ where: { id: incidentId } });
    if (!incident) {
      throw new NotFoundException(`Incident ${incidentId} not found.`);
    }

    const previousStatus = incident.status;
    incident.status = IncidentStatus.RESOLVED;
    incident.resolutionDetails = details;
    incident.updatedBy = userId ?? incident.updatedBy;
    const saved = await this.incidentRepository.save(incident);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'FIELD_INCIDENT_RESOLVED',
      entityType: 'FIELD_INCIDENT',
      entityId: saved.id,
      previousState: previousStatus,
      newState: IncidentStatus.RESOLVED,
      userId,
      remarks: `Resolved "${saved.title}": ${details}`,
      metadata: { visitId: saved.visitId, severity: saved.severity, resolutionDetails: details },
    });

    return saved;
  }

  /**
   * Generates the handover package schema contract for OCR pipelines.
   */
  async generateHandoverPackage(visitId: string): Promise<HandoverPackage> {
    const visit = await this.visitRepository.findOne({ where: { id: visitId } });
    if (!visit) {
      throw new NotFoundException(`Field visit ${visitId} not found.`);
    }

    if (visit.status !== FieldVisitStatus.SUBMITTED && visit.status !== FieldVisitStatus.HANDOVER_READY) {
      throw new BadRequestException('Handover package can only be built for completed/submitted visits.');
    }

    return {
      visitId: visit.id,
      branchId: visit.branchId,
      assayerId: visit.assayerId,
      timestamp: new Date().toISOString(),
      evidenceMetadata: {
        hasFormPayload: visit.evidenceReadiness.formsCompleted,
        totalImageAttachments: visit.evidenceReadiness.photosCollected ? 3 : 0,
      },
      ocrDeliveryTarget: `/ocr-processing/incoming/${visit.id}`,
    };
  }

  /**
   * Compiles the field dashboard parameters.
   */
  async getFieldOperationsDashboard(coveragePlanId: string): Promise<FieldDashboardSummary> {
    const visits = await this.visitRepository.find({ where: { coveragePlanId } });

    // Incidents belong to this coverage plan through its visits. Scope to those
    // visit ids instead of scanning every incident ever recorded, order newest
    // first, and cap the result so this ever-growing, never-pruned table can't
    // turn the dashboard into an unbounded full-table load.
    const visitIds = visits.map((v) => v.id);
    const incidents = visitIds.length
      ? await this.incidentRepository.find({
          where: { visitId: In(visitIds) },
          order: { createdAt: 'DESC' },
          take: 200,
        })
      : [];

    const inProgress = visits.filter((v) => v.status === FieldVisitStatus.AUDIT_STARTED || v.status === FieldVisitStatus.EVIDENCE_COLLECTION).length;
    const completed = visits.filter((v) => v.status === FieldVisitStatus.AUDIT_COMPLETED || v.status === FieldVisitStatus.SUBMITTED || v.status === FieldVisitStatus.HANDOVER_READY).length;

    const totalCount = visits.length;
    const completionPercentage = totalCount > 0 ? parseFloat(((completed / totalCount) * 100).toFixed(1)) : 0;

    const activeIncidents = incidents.filter((i) => i.status !== IncidentStatus.RESOLVED);
    const criticalIncidents = activeIncidents.filter((i) => i.severity === IncidentSeverity.CRITICAL || i.severity === IncidentSeverity.HIGH);

    return {
      visitsInProgress: inProgress,
      // A visit whose planned date has passed without reaching a completed state. This was
      // hardcoded to 0, so the operations dashboard reported "no delays" no matter how many
      // visits had slipped — the one number on this panel that should prompt action never
      // could. `plannedDate` is a date column, so the comparison is date-only: a visit planned
      // for today is not late until today is over.
      visitsDelayed: visits.filter((v) => {
        const terminal = [
          FieldVisitStatus.AUDIT_COMPLETED,
          FieldVisitStatus.SUBMITTED,
          FieldVisitStatus.HANDOVER_READY,
        ].includes(v.status);
        if (terminal || !v.plannedDate) return false;
        return String(v.plannedDate).slice(0, 10) < new Date().toISOString().slice(0, 10);
      }).length,
      awaitingSubmission: visits.filter((v) => v.status === FieldVisitStatus.AUDIT_COMPLETED).length,
      awaitingEvidence: visits.filter((v) => !v.evidenceReadiness.documentsCollected).length,
      activeIncidentsCount: activeIncidents.length,
      criticalIncidentsCount: criticalIncidents.length,
      completionPercentage,
    };
  }
}
