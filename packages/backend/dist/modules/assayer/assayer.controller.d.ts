import { AssayerService, CreateAssayerDto, UpdateAssayerDto } from './assayer.service';
import { AssayerStatus } from '@fapoms/shared';
declare class CreateAssayerRequestDto implements CreateAssayerDto {
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
declare class UpdateAssayerRequestDto implements UpdateAssayerDto {
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
export declare class AssayerController {
    private readonly assayerService;
    constructor(assayerService: AssayerService);
    create(dto: CreateAssayerRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer.entity").AssayerEntity;
    }>;
    findAll(page?: number, limit?: number): Promise<{
        success: boolean;
        data: import("./assayer.entity").AssayerEntity[];
        meta: {
            pagination: {
                page: number;
                limit: number;
                total: number;
                totalPages: number;
                hasNext: boolean;
                hasPrevious: boolean;
            };
        };
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: import("./assayer.entity").AssayerEntity;
    }>;
    update(id: string, dto: UpdateAssayerRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer.entity").AssayerEntity;
    }>;
    remove(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    createCommercial(assayerId: string, dto: CreateCommercialProfileRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer-commercial-profile.entity").AssayerCommercialProfileEntity;
    }>;
    updateCommercial(id: string, dto: UpdateCommercialProfileRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer-commercial-profile.entity").AssayerCommercialProfileEntity;
    }>;
    getCommercials(assayerId: string): Promise<{
        success: boolean;
        data: import("./assayer-commercial-profile.entity").AssayerCommercialProfileEntity[];
    }>;
    getActiveCommercial(assayerId: string, dateStr?: string): Promise<{
        success: boolean;
        data: import("./assayer-commercial-profile.entity").AssayerCommercialProfileEntity | null;
    }>;
    addWorkforceAttribute(assayerId: string, dto: CreateWorkforceAttributeRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./workforce-attribute.entity").WorkforceAttributeEntity;
    }>;
    updateWorkforceAttribute(id: string, dto: UpdateWorkforceAttributeRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./workforce-attribute.entity").WorkforceAttributeEntity;
    }>;
    removeWorkforceAttribute(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    getWorkforceAttributes(assayerId: string, type?: string): Promise<{
        success: boolean;
        data: import("./workforce-attribute.entity").WorkforceAttributeEntity[];
    }>;
}
export declare class CreateWorkforceAttributeRequestDto {
    type: string;
    name: string;
    level?: string;
    expiryDate?: string;
    metadata?: Record<string, any>;
}
export declare class UpdateWorkforceAttributeRequestDto {
    name?: string;
    level?: string;
    expiryDate?: string | null;
    metadata?: Record<string, any>;
}
export declare class CreateCommercialProfileRequestDto {
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
export declare class UpdateCommercialProfileRequestDto {
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
export {};
