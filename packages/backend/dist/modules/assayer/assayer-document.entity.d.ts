import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';
export declare class AssayerDocumentEntity extends BaseEntity {
    assayerId: string;
    assayer: AssayerEntity;
    documentType: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType: string | null;
    docVersion: number;
    parentDocumentId: string | null;
    remarks: string | null;
}
