"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchedulingService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const schedule_entity_1 = require("./schedule.entity");
const assignment_service_1 = require("../assignment/assignment.service");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const constraint_evaluator_1 = require("../planning/constraint.evaluator");
const shared_1 = require("@fapoms/shared");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
let SchedulingService = class SchedulingService {
    scheduleRepository;
    assignmentService;
    holidayService;
    auditService;
    constraintEvaluator;
    eventPublisher;
    constructor(scheduleRepository, assignmentService, holidayService, auditService, constraintEvaluator, eventPublisher) {
        this.scheduleRepository = scheduleRepository;
        this.assignmentService = assignmentService;
        this.holidayService = holidayService;
        this.auditService = auditService;
        this.constraintEvaluator = constraintEvaluator;
        this.eventPublisher = eventPublisher;
    }
    async create(dto, userId) {
        const assignment = await this.assignmentService.findOne(dto.assignmentId);
        if (!assignment) {
            throw new common_1.NotFoundException(`Assignment ${dto.assignmentId} not found.`);
        }
        if (assignment.projectBranch?.status !== shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED) {
            throw new common_1.BadRequestException(`Cannot schedule assignment: branch status must be ASSIGNMENT_CONFIRMED, got ${assignment.projectBranch?.status}.`);
        }
        const scheduledDateObj = new Date(dto.scheduledDate);
        if (assignment.assayer) {
            const leavesCheck = this.constraintEvaluator.checkLeaves(assignment.assayer, scheduledDateObj);
            if (!leavesCheck.passed) {
                throw new common_1.BadRequestException(leavesCheck.reason);
            }
        }
        if (assignment.project) {
            const timelineCheck = this.constraintEvaluator.checkProjectTimeline(assignment.project, scheduledDateObj);
            if (!timelineCheck.passed) {
                throw new common_1.BadRequestException(timelineCheck.reason);
            }
        }
        const stateCode = assignment.projectBranch?.branch?.state ?? 'MH';
        const holidayCheck = await this.constraintEvaluator.checkHoliday(stateCode, scheduledDateObj);
        if (!holidayCheck.passed) {
            throw new common_1.BadRequestException(holidayCheck.reason);
        }
        const existingSchedule = await this.scheduleRepository.findOne({
            where: { assignmentId: assignment.id, isActive: true },
        }).catch(() => null);
        if (existingSchedule) {
            existingSchedule.scheduledDate = scheduledDateObj;
            if (dto.remarks)
                existingSchedule.remarks = dto.remarks;
            existingSchedule.updatedBy = userId;
            const updated = await this.scheduleRepository.save(existingSchedule);
            await this.assignmentService.scheduleAudit(assignment.id, userId, dto.scheduledDate).catch(() => { });
            return updated;
        }
        const schedule = this.scheduleRepository.create({
            assignmentId: assignment.id,
            projectId: assignment.projectId,
            assayerId: assignment.assayerId,
            scheduledDate: scheduledDateObj,
            status: shared_1.ScheduleStatus.CONFIRMED,
            remarks: dto.remarks ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.scheduleRepository.save(schedule);
        await this.assignmentService.scheduleAudit(assignment.id, userId, dto.scheduledDate);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'SCHEDULE_CONFIRMED',
            entityType: 'SCHEDULE',
            entityId: saved.id,
            userId,
            remarks: `Confirmed schedule for assignment ${assignment.assignmentNumber} on ${dto.scheduledDate}.`,
        });
        try {
            this.eventPublisher.publish('schedule:created', {
                eventType: 'schedule:created',
                scheduleId: saved.id,
                assignmentId: saved.assignmentId,
                assayerId: saved.assayerId,
                organizationId: assignment.projectBranch?.project?.organizationId,
                scheduledDate: saved.scheduledDate,
                status: saved.status,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish schedule:created event:', err);
        }
        return saved;
    }
    async findOne(id) {
        const schedule = await this.scheduleRepository.findOne({
            where: { id, isActive: true },
            relations: ['assignment', 'assignment.projectBranch', 'assignment.projectBranch.branch', 'project', 'assayer'],
        });
        if (!schedule) {
            throw new common_1.NotFoundException(`Schedule ${id} not found.`);
        }
        return schedule;
    }
    async findAll(page = 1, limit = 50, status, dateFrom, dateTo) {
        const where = { isActive: true };
        if (status)
            where.status = status;
        if (dateFrom || dateTo) {
            where.scheduledDate = {};
            if (dateFrom)
                where.scheduledDate.gte = new Date(dateFrom);
            if (dateTo)
                where.scheduledDate.lte = new Date(dateTo);
        }
        const [schedules, total] = await this.scheduleRepository.findAndCount({
            where,
            relations: ['assignment', 'assignment.projectBranch', 'assignment.projectBranch.branch', 'assayer', 'project'],
            order: { scheduledDate: 'ASC' },
            take: limit,
            skip: (page - 1) * limit,
        });
        const reconciledSchedules = schedules.map((sch) => {
            const asnStatus = sch.assignment?.status;
            const pbStatus = sch.assignment?.projectBranch?.status;
            const isParentCompleted = asnStatus === 'COMPLETED' ||
                ['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'].includes(pbStatus);
            if (isParentCompleted && sch.status !== shared_1.ScheduleStatus.COMPLETED) {
                return {
                    ...sch,
                    status: shared_1.ScheduleStatus.COMPLETED,
                    completedAt: sch.completedAt || sch.updatedAt,
                };
            }
            return sch;
        });
        return { schedules: reconciledSchedules, total };
    }
    async transition(id, targetStatus, userId, remarks, newScheduledDate) {
        const schedule = await this.findOne(id);
        const prevStatus = schedule.status;
        if (schedule.assignment?.projectBranch) {
            const pbStatus = schedule.assignment.projectBranch.status;
            if (['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'].includes(pbStatus) || schedule.assignment.status === 'COMPLETED' || prevStatus === shared_1.ScheduleStatus.COMPLETED) {
                throw new common_1.BadRequestException('Cannot reschedule an audit that has already been completed or is under validation review.');
            }
        }
        if (!(0, shared_1.isValidTransition)(shared_1.SCHEDULE_TRANSITIONS, prevStatus, targetStatus)) {
            throw new common_1.BadRequestException(`Invalid Transition: Cannot transition schedule from ${prevStatus} to ${targetStatus}.`);
        }
        schedule.status = targetStatus;
        if (remarks)
            schedule.remarks = remarks;
        if (newScheduledDate) {
            schedule.scheduledDate = new Date(newScheduledDate);
            if (schedule.assignmentId) {
                await this.assignmentService.scheduleAudit(schedule.assignmentId, userId, newScheduledDate);
            }
        }
        if (targetStatus === shared_1.ScheduleStatus.COMPLETED) {
            schedule.completedAt = new Date();
            if (schedule.assignmentId) {
                try {
                    await this.assignmentService.completeAssignment(schedule.assignmentId, userId, 'Completed via schedule dispatch');
                }
                catch (err) {
                    console.warn('Assignment completion cascade skipped:', err.message);
                }
            }
        }
        schedule.updatedBy = userId;
        const saved = await this.scheduleRepository.save(schedule);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: `SCHEDULE_${targetStatus}`,
            entityType: 'SCHEDULE',
            entityId: saved.id,
            previousState: prevStatus,
            newState: targetStatus,
            userId,
            remarks: remarks ?? `Transitioned schedule to ${targetStatus}`,
        });
        try {
            this.eventPublisher.publish('schedule:updated', {
                eventType: 'schedule:updated',
                scheduleId: saved.id,
                assignmentId: saved.assignmentId,
                assayerId: saved.assayerId,
                scheduledDate: saved.scheduledDate,
                status: saved.status,
                previousStatus: prevStatus,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish schedule:updated event:', err);
        }
        return saved;
    }
    async getAssayerWorkloadInRange(assayerId, from, to) {
        const schedules = await this.scheduleRepository.find({
            where: {
                assayerId,
                isActive: true,
                scheduledDate: { gte: from, lte: to },
            },
            relations: ['assignment', 'project'],
            order: { scheduledDate: 'ASC' },
        });
        return {
            count: schedules.length,
            schedules: schedules.map(s => ({
                id: s.id,
                scheduledDate: s.scheduledDate,
                status: s.status,
                projectName: s.project?.name,
                assignmentNumber: s.assignment?.assignmentNumber,
            })),
        };
    }
    async getTimeline(scheduleId) {
        const schedule = await this.findOne(scheduleId);
        const { events } = await this.auditService.getEntityHistory('SCHEDULE', schedule.id, 100);
        const timelineEvents = [];
        for (const e of events) {
            timelineEvents.push({
                id: e.id,
                type: 'SYSTEM_EVENT',
                title: e.eventType,
                description: e.remarks,
                timestamp: e.occurredAt,
                user: e.userDisplayName || e.userId,
            });
        }
        return timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
};
exports.SchedulingService = SchedulingService;
exports.SchedulingService = SchedulingService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(schedule_entity_1.ScheduleEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        assignment_service_1.AssignmentService,
        holiday_service_1.HolidayService,
        audit_service_1.AuditService,
        constraint_evaluator_1.ConstraintEvaluator,
        domain_event_publisher_1.DomainEventPublisher])
], SchedulingService);
//# sourceMappingURL=scheduling.service.js.map