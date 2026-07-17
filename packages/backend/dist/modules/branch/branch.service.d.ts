import { Repository } from 'typeorm';
import { BranchEntity } from './branch.entity';
import { ClientService } from '../client/client.service';
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
    latitude?: number;
    longitude?: number;
    clientId?: string;
}
export declare class BranchService {
    private readonly branchRepository;
    private readonly stateRepository;
    private readonly districtRepository;
    private readonly cityRepository;
    private readonly clientService;
    private readonly auditService;
    constructor(branchRepository: Repository<BranchEntity>, stateRepository: Repository<GeoStateEntity>, districtRepository: Repository<GeoDistrictEntity>, cityRepository: Repository<GeoCityEntity>, clientService: ClientService, auditService: AuditService);
    create(dto: CreateBranchDto, userId: string): Promise<BranchEntity>;
    findOne(id: string): Promise<BranchEntity>;
    findAll(page?: number, limit?: number, clientId?: string): Promise<{
        branches: BranchEntity[];
        total: number;
    }>;
    importExcel(fileBuffer: Buffer, clientId: string, userId: string): Promise<{
        importedCount: number;
        errors: string[];
    }>;
    private validateGeography;
}
