import { ClientService, CreateClientDto, UpdateClientDto } from './client.service';
declare class CreateClientConfigDto {
    importMapping?: Record<string, string>;
    workingDays?: number[];
    defaultRadius?: number;
    slaRules?: Record<string, any>;
}
declare class CreateClientRequestDto implements CreateClientDto {
    clientCode: string;
    name: string;
    displayName: string;
    contactPerson?: string;
    contactEmail?: string;
    contactPhone?: string;
    address?: string;
    configuration?: CreateClientConfigDto;
}
declare class UpdateClientRequestDto implements UpdateClientDto {
    name?: string;
    displayName?: string;
    contactPerson?: string;
    contactEmail?: string;
    contactPhone?: string;
    address?: string;
    configuration?: CreateClientConfigDto;
}
export declare class ClientController {
    private readonly clientService;
    constructor(clientService: ClientService);
    create(dto: CreateClientRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./client.entity").ClientEntity;
    }>;
    findAll(page?: number, limit?: number): Promise<{
        success: boolean;
        data: import("./client.entity").ClientEntity[];
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
        data: import("./client.entity").ClientEntity;
    }>;
    update(id: string, dto: UpdateClientRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./client.entity").ClientEntity;
    }>;
    remove(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
}
export {};
