import { ZoneService, CreateZoneDto, UpdateZoneDto } from './zone.service';
declare class CreateZoneRequestDto implements CreateZoneDto {
    name: string;
    description?: string;
    clientId?: string;
    states?: string[];
    districts?: string[];
}
declare class UpdateZoneRequestDto implements UpdateZoneDto {
    name?: string;
    description?: string;
    states?: string[];
    districts?: string[];
}
export declare class ZoneController {
    private readonly zoneService;
    constructor(zoneService: ZoneService);
    create(dto: CreateZoneRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./zone.entity").ZoneEntity;
    }>;
    findAll(page?: number, limit?: number, clientId?: string): Promise<{
        success: boolean;
        data: import("./zone.entity").ZoneEntity[];
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
        data: import("./zone.entity").ZoneEntity;
    }>;
    update(id: string, dto: UpdateZoneRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./zone.entity").ZoneEntity;
    }>;
    remove(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
}
export {};
