import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { DocumentStatus, DocumentType } from '@fapoms/shared';
export declare class DocumentEntity extends BaseEntity {
    projectBranchId: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType: string | null;
    type: DocumentType;
    status: DocumentStatus;
    docVersion: number;
    projectBranch: ProjectBranchEntity;
}
