export declare class AuditLogEntity {
    id: string;
    tenantId: string | null;
    userId: string;
    action: string;
    beforeState: any;
    afterState: any;
    justification: string | null;
    ipAddress: string | null;
    correlationId: string | null;
    createdAt: Date;
}
