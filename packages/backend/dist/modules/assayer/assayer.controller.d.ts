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
}
export {};
