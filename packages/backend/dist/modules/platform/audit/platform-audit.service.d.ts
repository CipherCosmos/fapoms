import { Repository } from 'typeorm';
import { AuditLogEntity } from './audit-log.entity';
export declare class PlatformAuditService {
    private readonly auditRepository;
    constructor(auditRepository: Repository<AuditLogEntity>);
    logAction(params: {
        tenantId: string | null;
        userId: string;
        action: string;
        beforeState?: any;
        afterState?: any;
        justification?: string;
        ipAddress?: string;
        correlationId?: string;
    }): Promise<AuditLogEntity>;
}
