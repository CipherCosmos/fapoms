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
const assignment_entity_1 = require("../assignment/assignment.entity");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let SchedulingService = class SchedulingService {
    scheduleRepository;
    assignmentRepository;
    holidayService;
    auditService;
    constructor(scheduleRepository, assignmentRepository, holidayService, auditService) {
        this.scheduleRepository = scheduleRepository;
        this.assignmentRepository = assignmentRepository;
        this.holidayService = holidayService;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const assignment = await this.assignmentRepository.findOne({
            where: { id: dto.assignmentId, isActive: true },
            relations: ['projectBranch', 'projectBranch.branch', 'project', 'assayer'],
        });
        if (!assignment) {
            throw new common_1.NotFoundException(`Assignment ${dto.assignmentId} not found.`);
        }
        if (assignment.status !== shared_1.AssignmentStatus.ACCEPTED) {
            throw new common_1.BadRequestException(`Cannot schedule assignment. Current status must be ACCEPTED (got ${assignment.status}).`);
        }
        const scheduledDateObj = new Date(dto.scheduledDate);
        if (assignment.assayer && assignment.assayer.leaves && assignment.assayer.leaves.length > 0) {
            const targetTime = scheduledDateObj.getTime();
            const onLeave = assignment.assayer.leaves.some((leave) => {
                const start = new Date(leave.startDate).getTime();
                const end = new Date(leave.endDate).getTime();
                return targetTime >= start && targetTime <= end;
            });
            if (onLeave) {
                throw new common_1.BadRequestException(`Assayer Unavailable: Assayer is on leave on ${dto.scheduledDate}.`);
            }
        }
        if (assignment.project) {
            const scheduledTime = scheduledDateObj.getTime();
            if (assignment.project.startDate) {
                const projectStart = new Date(assignment.project.startDate).getTime();
                if (scheduledTime < projectStart) {
                    throw new common_1.BadRequestException(`Timeline Conflict: Scheduled date ${dto.scheduledDate} is before project start date ${assignment.project.startDate}.`);
                }
            }
            if (assignment.project.endDate) {
                const projectEnd = new Date(assignment.project.endDate).getTime();
                if (scheduledTime > projectEnd) {
                    throw new common_1.BadRequestException(`Timeline Conflict: Scheduled date ${dto.scheduledDate} is after project end date ${assignment.project.endDate}.`);
                }
            }
        }
        const isHoliday = await this.holidayService.isHoliday(scheduledDateObj, assignment.projectBranch.branch.state);
        if (isHoliday) {
            throw new common_1.BadRequestException(`Holiday Conflict: ${dto.scheduledDate} is a holiday in ${assignment.projectBranch.branch.state}.`);
        }
        const doubleBooked = await this.scheduleRepository.findOne({
            where: {
                assayerId: assignment.assayerId,
                scheduledDate: scheduledDateObj,
                status: (0, typeorm_2.In)([shared_1.ScheduleStatus.CONFIRMED]),
                isActive: true,
            },
        });
        if (doubleBooked) {
            throw new common_1.ConflictException(`Assayer double booking: already scheduled on ${dto.scheduledDate}.`);
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
        assignment.status = shared_1.AssignmentStatus.SCHEDULED;
        assignment.scheduledDate = scheduledDateObj;
        assignment.projectBranch.status = shared_1.ProjectBranchStatus.SCHEDULED;
        assignment.projectBranch.scheduledDate = scheduledDateObj;
        await this.assignmentRepository.save(assignment);
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
            relations: ['assignment', 'project', 'assayer'],
        });
        if (!schedule) {
            throw new common_1.NotFoundException(`Schedule ${id} not found.`);
        }
        return schedule;
    }
    async findAll(page = 1, limit = 50) {
        const [schedules, total] = await this.scheduleRepository.findAndCount({
            where: { isActive: true },
            relations: ['assignment', 'assayer', 'project'],
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
                const assignment = await this.assignmentRepository.findOne({ where: { id: schedule.assignmentId } });
                if (assignment) {
                    assignment.scheduledDate = new Date(newScheduledDate);
                    await this.assignmentRepository.save(assignment);
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
    __param(1, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        holiday_service_1.HolidayService,
        audit_service_1.AuditService])
], SchedulingService);
//# sourceMappingURL=scheduling.service.js.map