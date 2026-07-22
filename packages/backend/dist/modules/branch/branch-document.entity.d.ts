import { BaseEntity } from '../../core/entities/base.entity';
import type { BranchEntity } from './branch.entity';
export declare class BranchDocumentEntity extends BaseEntity {
    branchId: string;
    branch: BranchEntity;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType: string | null;
    category: string;
    remarks: string | null;
}
