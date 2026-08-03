import { AuditService } from './audit.service';
declare class StartAuditDto {
    assignmentId: string;
    assayerId: string;
    projectId: string;
    branchId: string;
    scheduledDate: string;
}
declare class CloseAuditDto {
    baseFee?: number;
    travelAllowance?: number;
}
export declare class AuditController {
    private readonly auditService;
    constructor(auditService: AuditService);
    startAudit(dto: StartAuditDto): Promise<{
        success: boolean;
        data: import("./audit.entity").AuditEntity;
    }>;
    closeAudit(id: string, dto: CloseAuditDto): Promise<{
        success: boolean;
        data: import("./audit.entity").AuditEntity;
    }>;
}
export {};
