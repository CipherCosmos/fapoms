import { BaseEntity } from '../../core/entities/base.entity';
export declare enum IncidentSeverity {
    LOW = "LOW",
    MEDIUM = "MEDIUM",
    HIGH = "HIGH",
    CRITICAL = "CRITICAL"
}
export declare enum IncidentStatus {
    REPORTED = "REPORTED",
    INVESTIGATING = "INVESTIGATING",
    RESOLVED = "RESOLVED",
    ESCALATED = "ESCALATED"
}
export declare class FieldIncidentEntity extends BaseEntity {
    visitId: string;
    title: string;
    description: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    resolutionDetails: string | null;
}
