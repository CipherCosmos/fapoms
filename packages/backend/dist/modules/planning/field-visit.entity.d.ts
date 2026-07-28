import { BaseEntity } from '../../core/entities/base.entity';
export declare enum FieldVisitStatus {
    READY = "READY",
    DISPATCHED = "DISPATCHED",
    TRAVELLING = "TRAVELLING",
    ARRIVED = "ARRIVED",
    AUDIT_STARTED = "AUDIT_STARTED",
    EVIDENCE_COLLECTION = "EVIDENCE_COLLECTION",
    AUDIT_COMPLETED = "AUDIT_COMPLETED",
    DELIVERABLE_PREPARATION = "DELIVERABLE_PREPARATION",
    SUBMITTED = "SUBMITTED",
    HANDOVER_READY = "HANDOVER_READY"
}
export declare class FieldVisitEntity extends BaseEntity {
    coveragePlanId: string;
    executionGroupId: string;
    branchId: string;
    assayerId: string;
    plannedDate: string;
    status: FieldVisitStatus;
    actualStartTime: Date | null;
    actualEndTime: Date | null;
    evidenceReadiness: {
        documentsCollected: boolean;
        photosCollected: boolean;
        formsCompleted: boolean;
        missingEvidenceList: string[];
    };
    completionSummary: string | null;
}
