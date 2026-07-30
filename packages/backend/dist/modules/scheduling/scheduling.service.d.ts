import { Repository } from 'typeorm';
import { ScheduleEntity } from './schedule.entity';
import { AssignmentService } from '../assignment/assignment.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { ScheduleStatus } from '@fapoms/shared';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
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
    private readonly eventPublisher;
    constructor(scheduleRepository: Repository<ScheduleEntity>, assignmentService: AssignmentService, holidayService: HolidayService, auditService: AuditService, constraintEvaluator: ConstraintEvaluator, eventPublisher: DomainEventPublisher);
    create(dto: CreateScheduleDto, userId: string): Promise<ScheduleEntity>;
    findOne(id: string): Promise<ScheduleEntity>;
    findAll(page?: number, limit?: number, status?: ScheduleStatus, dateFrom?: string, dateTo?: string): Promise<{
        schedules: ScheduleEntity[];
        total: number;
    }>;
    transition(id: string, targetStatus: ScheduleStatus, userId: string, remarks?: string, newScheduledDate?: string): Promise<ScheduleEntity>;
    getAssayerWorkloadInRange(assayerId: string, from: Date, to: Date): Promise<{
        count: number;
        schedules: any[];
    }>;
    getTimeline(scheduleId: string): Promise<any[]>;
}
