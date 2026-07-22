import { OrganizationService, CreateOrganizationDto, UpdateOrganizationDto } from './organization.service';
declare class CreateOrganizationRequestDto implements CreateOrganizationDto {
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
declare class UpdateOrganizationRequestDto implements UpdateOrganizationDto {
    name?: string;
    displayName?: string;
    address?: string;
    contactEmail?: string;
    contactPhone?: string;
}
export declare class OrganizationController {
    private readonly organizationService;
    constructor(organizationService: OrganizationService);
    create(dto: CreateOrganizationRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./organization.entity").OrganizationEntity;
    }>;
    findAll(page?: number, limit?: number): Promise<{
        success: boolean;
        data: import("./organization.entity").OrganizationEntity[];
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
        data: import("./organization.entity").OrganizationEntity;
    }>;
    update(id: string, dto: UpdateOrganizationRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./organization.entity").OrganizationEntity;
    }>;
    remove(id: string, req: any): Promise<void>;
}
export {};
