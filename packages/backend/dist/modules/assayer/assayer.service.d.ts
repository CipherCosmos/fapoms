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
    employmentType?: string;
    skills?: string[];
    certifications?: {
        name: string;
        expiryDate: string;
    }[];
    languages?: string[];
    preferredRegions?: string[];
    specializations?: string[];
    experienceYears?: number;
    performanceRating?: number;
    leaves?: {
        startDate: string;
        endDate: string;
    }[];
    workingHours?: {
        start: string;
        end: string;
    };
    maxDailyWorkload?: number;
    maxWeeklyWorkload?: number;
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
    employmentType?: string;
    skills?: string[];
    certifications?: {
        name: string;
        expiryDate: string;
    }[];
    languages?: string[];
    preferredRegions?: string[];
    specializations?: string[];
    experienceYears?: number;
    performanceRating?: number;
    leaves?: {
        startDate: string;
        endDate: string;
    }[];
    workingHours?: {
        start: string;
        end: string;
    };
    maxDailyWorkload?: number;
    maxWeeklyWorkload?: number;
}
export interface CreateCommercialProfileDto {
    baseFee: number;
    hourlyRate: number;
    dailyRate: number;
    travelReimbursement: number;
    accommodationAllowance: number;
    mealAllowance: number;
    currency?: string;
    effectiveStartDate: string;
    effectiveEndDate?: string | null;
}
export interface UpdateCommercialProfileDto {
    baseFee?: number;
    hourlyRate?: number;
    dailyRate?: number;
    travelReimbursement?: number;
    accommodationAllowance?: number;
    mealAllowance?: number;
    currency?: string;
    effectiveStartDate?: string;
    effectiveEndDate?: string | null;
}
export interface CreateWorkforceAttributeDto {
    type: string;
    name: string;
    level?: string;
    expiryDate?: string;
    metadata?: Record<string, any>;
}
export interface UpdateWorkforceAttributeDto {
    name?: string;
    level?: string;
    expiryDate?: string | null;
    metadata?: Record<string, any>;
}
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
export declare class AssayerService {
    private readonly assayerRepository;
    private readonly commercialRepository;
    private readonly workforceAttributeRepository;
    private readonly auditService;
    constructor(assayerRepository: Repository<AssayerEntity>, commercialRepository: Repository<AssayerCommercialProfileEntity>, workforceAttributeRepository: Repository<WorkforceAttributeEntity>, auditService: AuditService);
    findAll(page?: number, limit?: number): Promise<{
        assayers: AssayerEntity[];
        total: number;
    }>;
    findOne(id: string): Promise<AssayerEntity>;
    create(dto: CreateAssayerDto, userId: string): Promise<AssayerEntity>;
    update(id: string, dto: UpdateAssayerDto, userId: string): Promise<AssayerEntity>;
    remove(id: string, userId: string): Promise<void>;
    createCommercialProfile(assayerId: string, dto: CreateCommercialProfileDto, userId: string): Promise<AssayerCommercialProfileEntity>;
    updateCommercialProfile(profileId: string, dto: UpdateCommercialProfileDto, userId: string): Promise<AssayerCommercialProfileEntity>;
    getCommercialProfiles(assayerId: string): Promise<AssayerCommercialProfileEntity[]>;
    getActiveCommercialProfile(assayerId: string, date?: Date): Promise<AssayerCommercialProfileEntity | null>;
    addWorkforceAttribute(assayerId: string, dto: CreateWorkforceAttributeDto, userId: string): Promise<WorkforceAttributeEntity>;
    updateWorkforceAttribute(attributeId: string, dto: UpdateWorkforceAttributeDto, userId: string): Promise<WorkforceAttributeEntity>;
    removeWorkforceAttribute(attributeId: string, userId: string): Promise<void>;
    getWorkforceAttributes(assayerId: string, type?: string): Promise<WorkforceAttributeEntity[]>;
}
