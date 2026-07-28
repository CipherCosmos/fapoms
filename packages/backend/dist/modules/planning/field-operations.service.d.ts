import { Repository } from 'typeorm';
import { FieldVisitEntity, FieldVisitStatus } from './field-visit.entity';
import { FieldIncidentEntity, IncidentSeverity } from './field-incident.entity';
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
export declare class FieldOperationsService {
    private readonly visitRepository;
    private readonly incidentRepository;
    constructor(visitRepository: Repository<FieldVisitEntity>, incidentRepository: Repository<FieldIncidentEntity>);
    createFieldVisit(coveragePlanId: string, executionGroupId: string, branchId: string, assayerId: string, plannedDate: string): Promise<FieldVisitEntity>;
    transitionVisitStatus(visitId: string, targetStatus: FieldVisitStatus): Promise<FieldVisitEntity>;
    reportIncident(visitId: string, title: string, description: string, severity: IncidentSeverity): Promise<FieldIncidentEntity>;
    resolveIncident(incidentId: string, details: string): Promise<FieldIncidentEntity>;
    generateHandoverPackage(visitId: string): Promise<HandoverPackage>;
    getFieldOperationsDashboard(coveragePlanId: string): Promise<FieldDashboardSummary>;
}
