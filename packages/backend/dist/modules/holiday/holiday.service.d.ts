import { Repository } from 'typeorm';
import { HolidayEntity } from './holiday.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
export interface CreateHolidayDto {
    name: string;
    date: string | Date;
    type: string;
    applicableStates?: string[];
    clientId?: string | null;
}
export declare class HolidayService {
    private readonly holidayRepository;
    private readonly auditService;
    private readonly eventPublisher;
    constructor(holidayRepository: Repository<HolidayEntity>, auditService: AuditService, eventPublisher: DomainEventPublisher);
    create(dto: CreateHolidayDto, userId: string): Promise<HolidayEntity>;
    findOne(id: string): Promise<HolidayEntity>;
    update(id: string, dto: Partial<CreateHolidayDto>, userId: string): Promise<HolidayEntity>;
    findAll(page?: number, limit?: number, year?: number, clientId?: string): Promise<{
        holidays: HolidayEntity[];
        total: number;
    }>;
    isHoliday(date: Date, stateCode?: string, clientId?: string): Promise<boolean>;
    remove(id: string, userId: string): Promise<void>;
}
