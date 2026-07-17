import { BranchService, CreateBranchDto } from './branch.service';
declare class CreateBranchRequestDto implements CreateBranchDto {
    branchCode: string;
    solId?: string;
    name: string;
    address: string;
    state: string;
    district: string;
    city: string;
    pincode?: string;
    latitude?: number;
    longitude?: number;
    clientId?: string;
}
export declare class BranchController {
    private readonly branchService;
    constructor(branchService: BranchService);
    create(dto: CreateBranchRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./branch.entity").BranchEntity;
    }>;
    findAll(page?: number, limit?: number, clientId?: string): Promise<{
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
