import { Repository } from 'typeorm';
import { AuditEventEntity } from './audit-event.entity';
import { EventCategory } from '@fapoms/shared';
export interface CreateAuditEventDto {
    category: EventCategory;
    eventType: string;
    entityType: string;
    entityId: string;
    previousState?: string;
    newState?: string;
    userId?: string;
    userDisplayName?: string;
    ipAddress?: string;
    remarks?: string;
    metadata?: Record<string, unknown>;
}
export declare class AuditService {
    private readonly auditRepository;
    constructor(auditRepository: Repository<AuditEventEntity>);
    recordEvent(dto: CreateAuditEventDto): Promise<AuditEventEntity>;
    getEntityHistory(entityType: string, entityId: string, limit?: number, offset?: number): Promise<{
        events: AuditEventEntity[];
        total: number;
    }>;
    getUserActivity(userId: string, limit?: number, offset?: number): Promise<{
        events: AuditEventEntity[];
        total: number;
    }>;
}
