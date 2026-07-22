import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';
export declare class AssayerRemarkEntity extends BaseEntity {
    assayerId: string;
    assayer: AssayerEntity;
    authorId: string;
    authorName: string;
    content: string;
    category: string;
    visibility: string;
    attachmentPaths: string[];
}
