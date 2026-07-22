import { Repository } from 'typeorm';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerGovernmentDocumentEntity } from './assayer-government-document.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AuditService } from '../../core/audit/audit.service';
export interface CreateAssayerDto {
    assayerCode: string;
    employeeId?: string;
    employeeCode?: string;
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
    organizationId?: string;
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
    eligibleClients?: string[];
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
    organizationId?: string;
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
    eligibleClients?: string[];
}
export interface CreateGovernmentDocumentDto {
    documentType: string;
    documentNumber: string;
    expiryDate?: string;
    filePaths?: string[];
    remarks?: string;
}
export interface UpdateGovernmentDocumentDto {
    documentNumber?: string;
    expiryDate?: string | null;
    verificationStatus?: string;
    verifiedBy?: string;
    filePaths?: string[];
    remarks?: string;
}
export interface CreateAssayerDocumentDto {
    documentType: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType?: string;
    parentDocumentId?: string;
    remarks?: string;
}
export interface CreateRemarkDto {
    content: string;
    category: string;
    visibility: string;
    attachmentPaths?: string[];
    rating?: number;
}
export interface UpdateRemarkDto {
    content?: string;
    category?: string;
    visibility?: string;
    attachmentPaths?: string[];
    rating?: number;
}
export interface UpdateAssayerDocumentDto {
    documentType?: string;
    fileName?: string;
    filePath?: string;
    fileSize?: number;
    mimeType?: string;
    remarks?: string;
}
export declare class AssayerService {
    private readonly assayerRepository;
    private readonly commercialRepository;
    private readonly workforceAttributeRepository;
    private readonly govDocRepository;
    private readonly assayerDocRepository;
    private readonly remarkRepository;
    private readonly activityRepository;
    private readonly auditService;
    constructor(assayerRepository: Repository<AssayerEntity>, commercialRepository: Repository<AssayerCommercialProfileEntity>, workforceAttributeRepository: Repository<WorkforceAttributeEntity>, govDocRepository: Repository<AssayerGovernmentDocumentEntity>, assayerDocRepository: Repository<AssayerDocumentEntity>, remarkRepository: Repository<AssayerRemarkEntity>, activityRepository: Repository<AssayerActivityEntity>, auditService: AuditService);
    findAll(page?: number, limit?: number): Promise<{
        assayers: AssayerEntity[];
        total: number;
    }>;
    findOne(id: string): Promise<AssayerEntity>;
    create(dto: CreateAssayerDto, userId: string): Promise<AssayerEntity>;
    update(id: string, dto: UpdateAssayerDto, userId: string): Promise<AssayerEntity>;
    remove(id: string, userId: string): Promise<void>;
    transitionLifecycle(id: string, targetStatus: string, userId: string, reason?: string): Promise<AssayerEntity>;
    addGovernmentDocument(assayerId: string, dto: CreateGovernmentDocumentDto, userId: string): Promise<AssayerGovernmentDocumentEntity>;
    updateGovernmentDocument(docId: string, dto: UpdateGovernmentDocumentDto, userId: string): Promise<AssayerGovernmentDocumentEntity>;
    getGovernmentDocuments(assayerId: string): Promise<AssayerGovernmentDocumentEntity[]>;
    removeGovernmentDocument(docId: string, userId: string): Promise<void>;
    addAssayerDocument(assayerId: string, dto: CreateAssayerDocumentDto, userId: string): Promise<AssayerDocumentEntity>;
    getAssayerDocuments(assayerId: string): Promise<AssayerDocumentEntity[]>;
    updateAssayerDocument(docId: string, dto: UpdateAssayerDocumentDto, userId: string): Promise<AssayerDocumentEntity>;
    removeAssayerDocument(docId: string, userId: string): Promise<void>;
    addRemark(assayerId: string, dto: CreateRemarkDto, userId: string, userName: string): Promise<AssayerRemarkEntity>;
    updateRemark(remarkId: string, dto: UpdateRemarkDto, userId: string): Promise<AssayerRemarkEntity>;
    removeRemark(remarkId: string, userId: string): Promise<void>;
    getRemarks(assayerId: string, visibility?: string, page?: number, limit?: number): Promise<{
        remarks: AssayerRemarkEntity[];
        total: number;
    }>;
    recomputeAverageRating(assayerId: string): Promise<void>;
    updateAssayerStats(assayerId: string): Promise<void>;
    getProfile(assayerId: string): Promise<AssayerEntity>;
    private recordActivity;
    getActivityTimeline(assayerId: string, page?: number, limit?: number): Promise<{
        activities: AssayerActivityEntity[];
        total: number;
    }>;
    createCommercialProfile(assayerId: string, dto: any, userId: string): Promise<AssayerCommercialProfileEntity>;
    updateCommercialProfile(profileId: string, dto: any, userId: string): Promise<AssayerCommercialProfileEntity>;
    getCommercialProfiles(assayerId: string): Promise<AssayerCommercialProfileEntity[]>;
    getActiveCommercialProfile(assayerId: string, date?: Date): Promise<AssayerCommercialProfileEntity | null>;
    addWorkforceAttribute(assayerId: string, dto: any, userId: string): Promise<WorkforceAttributeEntity>;
    updateWorkforceAttribute(attributeId: string, dto: any, userId: string): Promise<WorkforceAttributeEntity>;
    removeWorkforceAttribute(attributeId: string, userId: string): Promise<void>;
    getWorkforceAttributes(assayerId: string, type?: string): Promise<WorkforceAttributeEntity[]>;
}
