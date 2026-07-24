import { Repository } from 'typeorm';
import { AuditHistoryRecord } from './audit-history.entity';
import { AuditEvidence } from './audit-evidence.entity';
export declare class AuditHistoryService {
    private readonly historyRepository;
    private readonly evidenceRepository;
    constructor(historyRepository: Repository<AuditHistoryRecord>, evidenceRepository: Repository<AuditEvidence>);
    createRecord(dto: Partial<AuditHistoryRecord>): Promise<AuditHistoryRecord>;
    addEvidence(dto: Partial<AuditEvidence>): Promise<AuditEvidence>;
    getAssayerAudits(assayerId: string): Promise<AuditHistoryRecord[]>;
    getAuditEvidence(auditId: string): Promise<AuditEvidence[]>;
}
