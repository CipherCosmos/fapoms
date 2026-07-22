import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';
export declare class AssayerGovernmentDocumentEntity extends BaseEntity {
    assayerId: string;
    assayer: AssayerEntity;
    documentType: string;
    documentNumber: string;
    expiryDate: Date | null;
    verificationStatus: string;
    verifiedAt: Date | null;
    verifiedBy: string | null;
    filePaths: string[];
    remarks: string | null;
}
