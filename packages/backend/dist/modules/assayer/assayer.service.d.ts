import { Repository } from 'typeorm';
import { AssayerEntity } from './assayer.entity';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerStatus } from '@fapoms/shared';
export interface CreateAssayerDto {
    assayerCode: string;
    firstName: string;
    lastName: string;
    email?: string;
    phone: string;
    alternatePhone?: string;
    address: string;
    state: string;
    district: string;
    city: string;
    pincode?: string;
    latitude?: number;
    longitude?: number;
    panNumber?: string;
    bankAccountNumber?: string;
    ifscCode?: string;
    notes?: string;
}
export interface UpdateAssayerDto {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    alternatePhone?: string;
    address?: string;
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    latitude?: number;
    longitude?: number;
    status?: AssayerStatus;
    panNumber?: string;
    bankAccountNumber?: string;
    ifscCode?: string;
    notes?: string;
}
export declare class AssayerService {
    private readonly assayerRepository;
    private readonly auditService;
    constructor(assayerRepository: Repository<AssayerEntity>, auditService: AuditService);
    create(dto: CreateAssayerDto, userId: string): Promise<AssayerEntity>;
    findOne(id: string): Promise<AssayerEntity>;
    findAll(page?: number, limit?: number): Promise<{
        assayers: AssayerEntity[];
        total: number;
    }>;
    update(id: string, dto: UpdateAssayerDto, userId: string): Promise<AssayerEntity>;
    remove(id: string, userId: string): Promise<void>;
}
