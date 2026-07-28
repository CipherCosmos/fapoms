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
let SchedulingService = class SchedulingService {
    scheduleRepository;
    assignmentService;
    holidayService;
    auditService;
    constraintEvaluator;
    constructor(scheduleRepository, assignmentService, holidayService, auditService, constraintEvaluator) {
        this.scheduleRepository = scheduleRepository;
        this.assignmentService = assignmentService;
        this.holidayService = holidayService;
        this.auditService = auditService;
        this.constraintEvaluator = constraintEvaluator;
    }
    async create(dto, userId) {
        const assignment = await this.assignmentService.findOne(dto.assignmentId);
        if (!assignment) {
            throw new common_1.NotFoundException(`Assignment ${dto.assignmentId} not found.`);
        }
        if (assignment.status !== shared_1.AssignmentStatus.ACCEPTED) {
            throw new common_1.BadRequestException(`Cannot schedule assignment. Current status must be ACCEPTED (got ${assignment.status}).`);
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
        const holidayCheck = await this.constraintEvaluator.checkHoliday(assignment.projectBranch.branch.state, scheduledDateObj);
        if (!holidayCheck.passed) {
            throw new common_1.BadRequestException(holidayCheck.reason);
        }
        const doubleBookedCheck = await this.constraintEvaluator.checkDoubleBooking(assignment.assayerId, scheduledDateObj);
        if (!doubleBookedCheck.passed) {
            throw new common_1.ConflictException(doubleBookedCheck.reason);
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
    async findAll(page = 1, limit = 50) {
        const [schedules, total] = await this.scheduleRepository.findAndCount({
            where: { isActive: true },
            relations: ['assignment', 'assignment.projectBranch', 'assignment.projectBranch.branch', 'assayer', 'project'],
            order: { scheduledDate: 'ASC' },
            take: limit,
            skip: (page - 1) * limit,
        });
        return { schedules, total };
    }
    async transition(id, targetStatus, userId, remarks, newScheduledDate) {
        const schedule = await this.findOne(id);
        const prevStatus = schedule.status;
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
        return saved;
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
        constraint_evaluator_1.ConstraintEvaluator])
], SchedulingService);
//# sourceMappingURL=scheduling.service.js.map