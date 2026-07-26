import { Repository } from 'typeorm';
import { ScheduleEntity } from './schedule.entity';
import { AssignmentService } from '../assignment/assignment.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
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
    private readonly assignmentService;
    private readonly holidayService;
    private readonly auditService;
    private readonly constraintEvaluator;
    constructor(scheduleRepository: Repository<ScheduleEntity>, assignmentService: AssignmentService, holidayService: HolidayService, auditService: AuditService, constraintEvaluator: ConstraintEvaluator);
    create(dto: CreateScheduleDto, userId: string): Promise<ScheduleEntity>;
    findOne(id: string): Promise<ScheduleEntity>;
    findAll(page?: number, limit?: number): Promise<{
        schedules: ScheduleEntity[];
        total: number;
    }>;
    transition(id: string, targetStatus: ScheduleStatus, userId: string, remarks?: string, newScheduledDate?: string): Promise<ScheduleEntity>;
    getTimeline(scheduleId: string): Promise<any[]>;
}
