export declare class AuditEventEntity {
    id: string;
    category: string;
    eventType: string;
    entityType: string;
    entityId: string;
    previousState: string | null;
    newState: string | null;
    userId: string | null;
    userDisplayName: string | null;
    ipAddress: string | null;
    remarks: string | null;
    metadata: Record<string, unknown> | null;
    occurredAt: Date;
}
