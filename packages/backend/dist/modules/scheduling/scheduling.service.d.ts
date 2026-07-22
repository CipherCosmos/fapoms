import { Repository } from 'typeorm';
import { ScheduleEntity } from './schedule.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { ScheduleStatus } from '@fapoms/shared';
export interface CreateScheduleDto {
    assignmentId: string;
    scheduledDate: string;
    remarks?: string;
}
export interface UpdateScheduleDto {
    scheduledDate?: string;
    remarks?: string;
}
export declare class SchedulingService {
    private readonly scheduleRepository;
    private readonly assignmentRepository;
    private readonly holidayService;
    private readonly auditService;
    constructor(scheduleRepository: Repository<ScheduleEntity>, assignmentRepository: Repository<AssignmentEntity>, holidayService: HolidayService, auditService: AuditService);
    create(dto: CreateScheduleDto, userId: string): Promise<ScheduleEntity>;
    findOne(id: string): Promise<ScheduleEntity>;
    findAll(page?: number, limit?: number): Promise<{
        schedules: ScheduleEntity[];
        total: number;
    }>;
    transition(id: string, targetStatus: ScheduleStatus, userId: string, remarks?: string, newScheduledDate?: string): Promise<ScheduleEntity>;
    getTimeline(scheduleId: string): Promise<any[]>;
}
