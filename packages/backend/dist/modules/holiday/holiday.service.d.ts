import { Repository } from 'typeorm';
import { HolidayEntity } from './holiday.entity';
import { AuditService } from '../../core/audit/audit.service';
export interface CreateHolidayDto {
    name: string;
    date: Date;
    type: string;
    applicableStates?: string[];
}
export declare class HolidayService {
    private readonly holidayRepository;
    private readonly auditService;
    constructor(holidayRepository: Repository<HolidayEntity>, auditService: AuditService);
    create(dto: CreateHolidayDto, userId: string): Promise<HolidayEntity>;
    findOne(id: string): Promise<HolidayEntity>;
    findAll(page?: number, limit?: number, year?: number): Promise<{
        holidays: HolidayEntity[];
        total: number;
    }>;
    isHoliday(date: Date, stateCode?: string): Promise<boolean>;
    remove(id: string, userId: string): Promise<void>;
}
