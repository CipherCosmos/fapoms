import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FieldVisitEntity, FieldVisitStatus } from './field-visit.entity';
import { FieldIncidentEntity, IncidentStatus, IncidentSeverity } from './field-incident.entity';

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
  ) {}

  /**
   * Initializes a new FieldVisit following operational package deployment.
   */
  async createFieldVisit(
    coveragePlanId: string,
    executionGroupId: string,
    branchId: string,
    assayerId: string,
    plannedDate: string
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
    });
    return this.visitRepository.save(visit);
  }

  /**
   * Transitions field visit execution states.
   */
  async transitionVisitStatus(visitId: string, targetStatus: FieldVisitStatus): Promise<FieldVisitEntity> {
    const visit = await this.visitRepository.findOne({ where: { id: visitId } });
    if (!visit) {
      throw new NotFoundException(`Field visit ${visitId} not found.`);
    }

    if (targetStatus === FieldVisitStatus.AUDIT_STARTED) {
      visit.actualStartTime = new Date();
    } else if (targetStatus === FieldVisitStatus.AUDIT_COMPLETED) {
      visit.actualEndTime = new Date();
    }

    visit.status = targetStatus;
    return this.visitRepository.save(visit);
  }

  /**
   * Logs a blocker or operational incident in the field.
   */
  async reportIncident(visitId: string, title: string, description: string, severity: IncidentSeverity): Promise<FieldIncidentEntity> {
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
    });
    return this.incidentRepository.save(incident);
  }

  /**
   * Resolves a logged field incident.
   */
  async resolveIncident(incidentId: string, details: string): Promise<FieldIncidentEntity> {
    const incident = await this.incidentRepository.findOne({ where: { id: incidentId } });
    if (!incident) {
      throw new NotFoundException(`Incident ${incidentId} not found.`);
    }

    incident.status = IncidentStatus.RESOLVED;
    incident.resolutionDetails = details;
    return this.incidentRepository.save(incident);
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
    const incidents = await this.incidentRepository.find();

    const inProgress = visits.filter((v) => v.status === FieldVisitStatus.AUDIT_STARTED || v.status === FieldVisitStatus.EVIDENCE_COLLECTION).length;
    const completed = visits.filter((v) => v.status === FieldVisitStatus.AUDIT_COMPLETED || v.status === FieldVisitStatus.SUBMITTED || v.status === FieldVisitStatus.HANDOVER_READY).length;

    const totalCount = visits.length;
    const completionPercentage = totalCount > 0 ? parseFloat(((completed / totalCount) * 100).toFixed(1)) : 0;

    const activeIncidents = incidents.filter((i) => i.status !== IncidentStatus.RESOLVED);
    const criticalIncidents = activeIncidents.filter((i) => i.severity === IncidentSeverity.CRITICAL || i.severity === IncidentSeverity.HIGH);

    return {
      visitsInProgress: inProgress,
      visitsDelayed: 0, // Mock delayed visits calculations
      awaitingSubmission: visits.filter((v) => v.status === FieldVisitStatus.AUDIT_COMPLETED).length,
      awaitingEvidence: visits.filter((v) => !v.evidenceReadiness.documentsCollected).length,
      activeIncidentsCount: activeIncidents.length,
      criticalIncidentsCount: criticalIncidents.length,
      completionPercentage,
    };
  }
}
