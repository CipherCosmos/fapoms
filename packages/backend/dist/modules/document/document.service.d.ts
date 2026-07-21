import { Repository } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DocumentStatus, DocumentType } from '@fapoms/shared';
export interface CreateDocumentDto {
    projectBranchId: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType?: string;
    type: DocumentType;
}
export declare class DocumentService {
    private readonly documentRepository;
    private readonly projectBranchRepository;
    private readonly auditService;
    constructor(documentRepository: Repository<DocumentEntity>, projectBranchRepository: Repository<ProjectBranchEntity>, auditService: AuditService);
    create(dto: CreateDocumentDto, userId: string): Promise<DocumentEntity>;
    findOne(id: string): Promise<DocumentEntity>;
    updateStatus(id: string, status: DocumentStatus, userId: string): Promise<DocumentEntity>;
    findByProjectBranch(projectBranchId: string): Promise<DocumentEntity[]>;
}
