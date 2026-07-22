import { AssayerService, CreateAssayerDto, UpdateAssayerDto } from './assayer.service';
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
    joiningDate?: string;
    managerId?: string;
    department?: string;
    region?: string;
    emergencyContactName?: string;
    emergencyContactPhone?: string;
    emergencyContactRelation?: string;
    employeeId?: string;
    employeeCode?: string;
    photograph?: string;
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
    panNumber?: string;
    bankAccountNumber?: string;
    ifscCode?: string;
    notes?: string;
    employmentType?: string;
    joiningDate?: string;
    exitDate?: string;
    terminationDate?: string;
    managerId?: string;
    department?: string;
    region?: string;
    emergencyContactName?: string;
    emergencyContactPhone?: string;
    emergencyContactRelation?: string;
    employeeId?: string;
    employeeCode?: string;
    photograph?: string;
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
export declare class TransitionLifecycleDto {
    targetStatus: string;
    reason?: string;
}
export declare class CreateGovernmentDocumentRequestDto {
    documentType: string;
    documentNumber: string;
    expiryDate?: string;
    filePaths?: string[];
    remarks?: string;
}
export declare class UpdateGovernmentDocumentRequestDto {
    documentNumber?: string;
    expiryDate?: string | null;
    verificationStatus?: string;
    verifiedBy?: string;
    filePaths?: string[];
    remarks?: string;
}
export declare class CreateAssayerDocumentRequestDto {
    documentType: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType?: string;
    parentDocumentId?: string;
    remarks?: string;
}
export declare class CreateRemarkRequestDto {
    content: string;
    category: string;
    visibility: string;
    attachmentPaths?: string[];
}
export declare class UpdateRemarkRequestDto {
    content?: string;
    category?: string;
    visibility?: string;
    attachmentPaths?: string[];
}
export declare class UpdateAssayerDocumentRequestDto {
    documentType?: string;
    fileName?: string;
    filePath?: string;
    fileSize?: number;
    mimeType?: string;
    remarks?: string;
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
    remove(id: string, req: any): Promise<void>;
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
    transitionLifecycle(id: string, dto: TransitionLifecycleDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer.entity").AssayerEntity;
    }>;
    addGovernmentDocument(assayerId: string, dto: CreateGovernmentDocumentRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer-government-document.entity").AssayerGovernmentDocumentEntity;
    }>;
    updateGovernmentDocument(id: string, dto: UpdateGovernmentDocumentRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer-government-document.entity").AssayerGovernmentDocumentEntity;
    }>;
    getGovernmentDocuments(assayerId: string): Promise<{
        success: boolean;
        data: import("./assayer-government-document.entity").AssayerGovernmentDocumentEntity[];
    }>;
    removeGovernmentDocument(id: string, req: any): Promise<void>;
    addAssayerDocument(assayerId: string, dto: CreateAssayerDocumentRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer-document.entity").AssayerDocumentEntity;
    }>;
    updateAssayerDocument(assayerId: string, docId: string, dto: UpdateAssayerDocumentRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer-document.entity").AssayerDocumentEntity;
    }>;
    getAssayerDocuments(assayerId: string): Promise<{
        success: boolean;
        data: import("./assayer-document.entity").AssayerDocumentEntity[];
    }>;
    removeAssayerDocument(id: string, req: any): Promise<void>;
    addRemark(assayerId: string, dto: CreateRemarkRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer-remark.entity").AssayerRemarkEntity;
    }>;
    updateRemark(assayerId: string, remarkId: string, dto: UpdateRemarkRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./assayer-remark.entity").AssayerRemarkEntity;
    }>;
    removeRemark(assayerId: string, remarkId: string, req: any): Promise<void>;
    getRemarks(assayerId: string, visibility?: string, page?: number, limit?: number): Promise<{
        success: boolean;
        data: import("./assayer-remark.entity").AssayerRemarkEntity[];
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
    getActivityTimeline(assayerId: string, page?: number, limit?: number): Promise<{
        success: boolean;
        data: import("./assayer-activity.entity").AssayerActivityEntity[];
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
}
export {};
