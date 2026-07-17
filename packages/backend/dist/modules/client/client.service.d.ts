import { Repository } from 'typeorm';
import { ClientEntity } from './client.entity';
import { ClientConfigurationEntity } from './client-configuration.entity';
import { AuditService } from '../../core/audit/audit.service';
export interface CreateClientDto {
    clientCode: string;
    name: string;
    displayName: string;
    contactPerson?: string;
    contactEmail?: string;
    contactPhone?: string;
    address?: string;
    configuration?: {
        importMapping?: Record<string, string>;
        workingDays?: number[];
        defaultRadius?: number;
        slaRules?: Record<string, any>;
    };
}
export interface UpdateClientDto {
    name?: string;
    displayName?: string;
    contactPerson?: string;
    contactEmail?: string;
    contactPhone?: string;
    address?: string;
    configuration?: {
        importMapping?: Record<string, string>;
        workingDays?: number[];
        defaultRadius?: number;
        slaRules?: Record<string, any>;
        effectiveTo?: Date;
    };
}
export declare class ClientService {
    private readonly clientRepository;
    private readonly configRepository;
    private readonly auditService;
    constructor(clientRepository: Repository<ClientEntity>, configRepository: Repository<ClientConfigurationEntity>, auditService: AuditService);
    create(dto: CreateClientDto, userId: string): Promise<ClientEntity>;
    findOne(id: string): Promise<ClientEntity>;
    findAll(page?: number, limit?: number): Promise<{
        clients: ClientEntity[];
        total: number;
    }>;
    update(id: string, dto: UpdateClientDto, userId: string): Promise<ClientEntity>;
    remove(id: string, userId: string): Promise<void>;
}
