import { Repository } from 'typeorm';
import { ZoneEntity } from './zone.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
export interface CreateZoneDto {
    name: string;
    description?: string;
    clientId?: string;
    states?: string[];
    districts?: string[];
}
export interface UpdateZoneDto {
    name?: string;
    description?: string;
    states?: string[];
    districts?: string[];
}
export declare class ZoneService {
    private readonly zoneRepository;
    private readonly auditService;
    private readonly eventPublisher;
    constructor(zoneRepository: Repository<ZoneEntity>, auditService: AuditService, eventPublisher: DomainEventPublisher);
    create(dto: CreateZoneDto, userId: string): Promise<ZoneEntity>;
    findOne(id: string): Promise<ZoneEntity>;
    findAll(page?: number, limit?: number, clientId?: string): Promise<{
        zones: ZoneEntity[];
        total: number;
    }>;
    update(id: string, dto: UpdateZoneDto, userId: string): Promise<ZoneEntity>;
    remove(id: string, userId: string): Promise<void>;
}
