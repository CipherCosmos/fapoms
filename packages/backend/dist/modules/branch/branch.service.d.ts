import { Repository } from 'typeorm';
import { BranchEntity } from './branch.entity';
import { BranchContactEntity } from './branch-contact.entity';
import { BranchDocumentEntity } from './branch-document.entity';
import { ClientService } from '../client/client.service';
import { ZoneEntity } from '../zone/zone.entity';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../geo/geo.entities';
import { AuditService } from '../../core/audit/audit.service';
export interface CreateBranchDto {
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
    operatingHours?: Record<string, any>;
    latitude?: number;
    longitude?: number;
    clientId?: string;
    riskScore?: number;
    riskCategory?: string;
    complexity?: string;
    estimatedDurationHours?: number;
    requiredCompetencies?: string[];
}
export interface UpdateBranchDto {
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
    operatingHours?: Record<string, any>;
    latitude?: number;
    longitude?: number;
    clientId?: string;
    riskScore?: number;
    riskCategory?: string;
    complexity?: string;
    estimatedDurationHours?: number;
    requiredCompetencies?: string[];
}
export interface CreateContactDto {
    name: string;
    email: string;
    phone: string;
    designation: string;
    department?: string;
    isPrimary?: boolean;
    notes?: string;
}
export interface UpdateContactDto {
    name?: string;
    email?: string;
    phone?: string;
    designation?: string;
    department?: string;
    isPrimary?: boolean;
    notes?: string;
}
export interface CreateDocumentDto {
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType?: string;
    category: string;
    remarks?: string;
}
export declare class BranchService {
    private readonly branchRepository;
    private readonly contactRepository;
    private readonly documentRepository;
    private readonly zoneRepository;
    private readonly stateRepository;
    private readonly districtRepository;
    private readonly cityRepository;
    private readonly clientService;
    private readonly auditService;
    constructor(branchRepository: Repository<BranchEntity>, contactRepository: Repository<BranchContactEntity>, documentRepository: Repository<BranchDocumentEntity>, zoneRepository: Repository<ZoneEntity>, stateRepository: Repository<GeoStateEntity>, districtRepository: Repository<GeoDistrictEntity>, cityRepository: Repository<GeoCityEntity>, clientService: ClientService, auditService: AuditService);
    create(dto: CreateBranchDto, userId: string): Promise<BranchEntity>;
    findOne(id: string): Promise<BranchEntity>;
    findAll(page?: number, limit?: number, clientId?: string, region?: string, zoneId?: string): Promise<{
        branches: BranchEntity[];
        total: number;
    }>;
    update(id: string, dto: UpdateBranchDto, userId: string): Promise<BranchEntity>;
    remove(id: string, userId: string): Promise<void>;
    findContacts(branchId: string): Promise<BranchContactEntity[]>;
    addContact(branchId: string, dto: CreateContactDto, userId: string): Promise<BranchContactEntity>;
    updateContact(contactId: string, dto: UpdateContactDto, userId: string): Promise<BranchContactEntity>;
    removeContact(contactId: string, userId: string): Promise<void>;
    findDocuments(branchId: string): Promise<BranchDocumentEntity[]>;
    addDocument(branchId: string, dto: CreateDocumentDto, userId: string): Promise<BranchDocumentEntity>;
    removeDocument(documentId: string, userId: string): Promise<void>;
    importExcel(fileBuffer: Buffer, clientId: string, userId: string): Promise<{
        importedCount: number;
        errors: string[];
    }>;
    private validateGeography;
}
