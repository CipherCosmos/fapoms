import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { DocumentStatus, DocumentType, DispatchMethod } from '@fapoms/shared';
export declare class DocumentEntity extends BaseEntity {
    projectBranchId: string | null;
    assessmentId: string | null;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType: string | null;
    type: DocumentType;
    status: DocumentStatus;
    docVersion: number;
    customerMasterVersionId: string | null;
    dispatchedAt: Date | null;
    dispatchMethod: DispatchMethod | null;
    dispatchedBy: string | null;
    receivedAt: Date | null;
    assignedToUserId: string | null;
    assignedAt: Date | null;
    assignedBy: string | null;
    dataEntryCompletedAt: Date | null;
    sentToDataEntryAt: Date | null;
    sentToExternalOcrAt: Date | null;
    projectBranch: ProjectBranchEntity | null;
    assessment: AssessmentEntity | null;
}
