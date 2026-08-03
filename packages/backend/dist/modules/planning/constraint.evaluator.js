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
exports.ConstraintEvaluator = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const assignment_entity_1 = require("../assignment/assignment.entity");
const schedule_entity_1 = require("../scheduling/schedule.entity");
const holiday_service_1 = require("../holiday/holiday.service");
const shared_1 = require("@fapoms/shared");
let ConstraintEvaluator = class ConstraintEvaluator {
    assignmentRepository;
    scheduleRepository;
    holidayService;
    constructor(assignmentRepository, scheduleRepository, holidayService) {
        this.assignmentRepository = assignmentRepository;
        this.scheduleRepository = scheduleRepository;
        this.holidayService = holidayService;
    }
    async checkDoubleBooking(assayerId, scheduledDate) {
        const doubleBooked = await this.assignmentRepository.findOne({
            where: {
                assayerId,
                scheduledDate,
                status: (0, typeorm_2.In)([shared_1.AssignmentStatus.ACCEPTED]),
                isActive: true,
            },
        });
        if (doubleBooked) {
            return {
                passed: false,
                reason: `Assayer double booking: already committed to assignment ${doubleBooked.assignmentNumber} on ${scheduledDate.toISOString().split('T')[0]}.`,
            };
        }
        return { passed: true };
    }
    checkLeaves(assayer, scheduledDate) {
        if (assayer.leaves && assayer.leaves.length > 0) {
            const targetTime = scheduledDate.getTime();
            const onLeave = assayer.leaves.some((leave) => {
                const start = new Date(leave.startDate).getTime();
                const end = new Date(leave.endDate).getTime();
                return targetTime >= start && targetTime <= end;
            });
            if (onLeave) {
                return {
                    passed: false,
                    reason: `Assayer Unavailable: Assayer is on leave on ${scheduledDate.toISOString().split('T')[0]}.`,
                };
            }
        }
        return { passed: true };
    }
    checkProjectTimeline(project, scheduledDate) {
        const scheduledTime = scheduledDate.getTime();
        if (project.startDate) {
            const projectStart = new Date(project.startDate).getTime();
            if (scheduledTime < projectStart) {
                return {
                    passed: false,
                    reason: `Timeline Conflict: Scheduled date is before project start date ${project.startDate}.`,
                };
            }
        }
        if (project.endDate) {
            const projectEnd = new Date(project.endDate).getTime();
            if (scheduledTime > projectEnd) {
                return {
                    passed: false,
                    reason: `Timeline Conflict: Scheduled date is after project end date ${project.endDate}.`,
                };
            }
        }
        return { passed: true };
    }
    async checkHoliday(state, scheduledDate) {
        const isHoliday = await this.holidayService.isHoliday(scheduledDate, state);
        if (isHoliday) {
            return {
                passed: false,
                reason: `Holiday Conflict: Target date is a holiday in ${state}.`,
            };
        }
        return { passed: true };
    }
    checkSkillsAndCertifications(assayerEntity, project) {
        const assayer = assayerEntity;
        if (project.requiredSkills && project.requiredSkills.length > 0) {
            const assayerSkills = (assayer.skills || []).map((s) => s.trim().toLowerCase());
            const missingSkills = project.requiredSkills.filter((skill) => !assayerSkills.includes(skill.trim().toLowerCase()));
            if (missingSkills.length > 0) {
                return {
                    passed: false,
                    reason: `Assayer Qualification Conflict: Assayer lacks required skills: ${missingSkills.join(', ')}`,
                };
            }
        }
        if (project.requiredCertifications && project.requiredCertifications.length > 0) {
            const assayerCerts = (assayer.certifications || []).map((c) => c.name.trim().toLowerCase());
            const missingCerts = project.requiredCertifications.filter((cert) => !assayerCerts.includes(cert.trim().toLowerCase()));
            if (missingCerts.length > 0) {
                return {
                    passed: false,
                    reason: `Assayer Qualification Conflict: Assayer lacks required certifications: ${missingCerts.join(', ')}`,
                };
            }
        }
        return { passed: true };
    }
};
exports.ConstraintEvaluator = ConstraintEvaluator;
exports.ConstraintEvaluator = ConstraintEvaluator = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(schedule_entity_1.ScheduleEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        holiday_service_1.HolidayService])
], ConstraintEvaluator);
//# sourceMappingURL=constraint.evaluator.js.map