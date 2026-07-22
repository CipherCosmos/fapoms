import { Repository } from 'typeorm';
import { OrganizationEntity } from './organization.entity';
import { AuditService } from '../../core/audit/audit.service';
export interface CreateOrganizationDto {
    code: string;
    name: string;
    displayName?: string;
    description?: string;
    address?: string;
    contactEmail?: string;
    contactPhone?: string;
    taxId?: string;
    registrationNumber?: string;
}
export interface UpdateOrganizationDto {
    name?: string;
    displayName?: string;
    address?: string;
    contactEmail?: string;
    contactPhone?: string;
}
export declare class OrganizationService {
    private readonly organizationRepository;
    private readonly auditService;
    constructor(organizationRepository: Repository<OrganizationEntity>, auditService: AuditService);
    create(dto: CreateOrganizationDto, userId: string): Promise<OrganizationEntity>;
    findAll(page?: number, limit?: number): Promise<{
        organizations: OrganizationEntity[];
        total: number;
    }>;
    findOne(id: string): Promise<OrganizationEntity>;
    update(id: string, dto: UpdateOrganizationDto, userId: string): Promise<OrganizationEntity>;
    remove(id: string, userId: string): Promise<void>;
}
