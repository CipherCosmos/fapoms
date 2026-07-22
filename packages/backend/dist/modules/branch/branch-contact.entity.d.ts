import { BaseEntity } from '../../core/entities/base.entity';
import type { BranchEntity } from './branch.entity';
export declare class BranchContactEntity extends BaseEntity {
    branchId: string;
    branch: BranchEntity;
    name: string;
    email: string;
    phone: string;
    designation: string;
    department: string | null;
    isPrimary: boolean;
    notes: string | null;
}
