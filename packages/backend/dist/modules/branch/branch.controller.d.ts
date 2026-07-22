import { BranchService, CreateBranchDto, UpdateBranchDto, CreateContactDto, UpdateContactDto, CreateDocumentDto } from './branch.service';
declare class CreateBranchRequestDto implements CreateBranchDto {
    branchCode: string;
    solId?: string;
    name: string;
    address: string;
    state: string;
    district: string;
    city: string;
    pincode?: string;
    region?: string;
    territory?: string;
    zoneId?: string;
    branchType?: string;
    phone?: string;
    email?: string;
    managerName?: string;
    openingDate?: string;
    lastAuditDate?: string;
    latitude?: number;
    longitude?: number;
    clientId?: string;
    riskScore?: number;
    riskCategory?: string;
    complexity?: string;
    estimatedDurationHours?: number;
    requiredCompetencies?: string[];
}
declare class UpdateBranchRequestDto implements UpdateBranchDto {
    branchCode?: string;
    solId?: string;
    name?: string;
    address?: string;
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    region?: string;
    territory?: string;
    zoneId?: string;
    branchType?: string;
    phone?: string;
    email?: string;
    managerName?: string;
    openingDate?: string;
    lastAuditDate?: string;
    latitude?: number;
    longitude?: number;
    clientId?: string;
    riskScore?: number;
    riskCategory?: string;
    complexity?: string;
    estimatedDurationHours?: number;
    requiredCompetencies?: string[];
}
declare class CreateContactRequestDto implements CreateContactDto {
    name: string;
    email: string;
    phone: string;
    designation: string;
    department?: string;
    isPrimary?: boolean;
    notes?: string;
}
declare class UpdateContactRequestDto implements UpdateContactDto {
    name?: string;
    email?: string;
    phone?: string;
    designation?: string;
    department?: string;
    isPrimary?: boolean;
    notes?: string;
}
declare class CreateDocumentRequestDto implements CreateDocumentDto {
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType?: string;
    category: string;
    remarks?: string;
}
export declare class BranchController {
    private readonly branchService;
    constructor(branchService: BranchService);
    create(dto: CreateBranchRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./branch.entity").BranchEntity;
    }>;
    findAll(page?: number, limit?: number, clientId?: string, region?: string, zoneId?: string): Promise<{
        success: boolean;
        data: import("./branch.entity").BranchEntity[];
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
        data: import("./branch.entity").BranchEntity;
    }>;
    update(id: string, dto: UpdateBranchRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./branch.entity").BranchEntity;
    }>;
    remove(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    findContacts(id: string): Promise<{
        success: boolean;
        data: import("./branch-contact.entity").BranchContactEntity[];
    }>;
    addContact(id: string, dto: CreateContactRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./branch-contact.entity").BranchContactEntity;
    }>;
    updateContact(contactId: string, dto: UpdateContactRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./branch-contact.entity").BranchContactEntity;
    }>;
    removeContact(contactId: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    findDocuments(id: string): Promise<{
        success: boolean;
        data: import("./branch-document.entity").BranchDocumentEntity[];
    }>;
    addDocument(id: string, dto: CreateDocumentRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./branch-document.entity").BranchDocumentEntity;
    }>;
    removeDocument(documentId: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    importExcel(clientId: string, file: Express.Multer.File, req: any): Promise<{
        success: boolean;
        error: string;
        data?: undefined;
    } | {
        success: boolean;
        data: {
            importedCount: number;
            errors: string[];
        };
        error?: undefined;
    }>;
}
export {};
