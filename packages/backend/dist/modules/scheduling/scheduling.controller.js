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
exports.SchedulingController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const scheduling_service_1 = require("./scheduling.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
class CreateScheduleRequestDto {
    assignmentId;
    scheduledDate;
    remarks;
}
__decorate([
    (0, class_validator_1.IsUUID)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateScheduleRequestDto.prototype, "assignmentId", void 0);
__decorate([
    (0, class_validator_1.IsDateString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateScheduleRequestDto.prototype, "scheduledDate", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], CreateScheduleRequestDto.prototype, "remarks", void 0);
class TransitionScheduleRequestDto {
    targetStatus;
    remarks;
    scheduledDate;
}
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], TransitionScheduleRequestDto.prototype, "targetStatus", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], TransitionScheduleRequestDto.prototype, "remarks", void 0);
__decorate([
    (0, class_validator_1.IsDateString)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], TransitionScheduleRequestDto.prototype, "scheduledDate", void 0);
let SchedulingController = class SchedulingController {
    schedulingService;
    constructor(schedulingService) {
        this.schedulingService = schedulingService;
    }
    async create(dto, req) {
        const schedule = await this.schedulingService.create(dto, req.user.id);
        return {
            success: true,
            data: schedule,
        };
    }
    async findAll(page = 1, limit = 50) {
        const { schedules, total } = await this.schedulingService.findAll(Number(page), Number(limit));
        return {
            success: true,
            data: schedules,
            meta: {
                pagination: {
                    page: Number(page),
                    limit: Number(limit),
                    total,
                },
            },
        };
    }
    async findOne(id) {
        const schedule = await this.schedulingService.findOne(id);
        return {
            success: true,
            data: schedule,
        };
    }
    async transition(id, dto, req) {
        const schedule = await this.schedulingService.transition(id, dto.targetStatus, req.user.id, dto.remarks, dto.scheduledDate);
        return {
            success: true,
            data: schedule,
        };
    }
    async getTimeline(id) {
        const timeline = await this.schedulingService.getTimeline(id);
        return {
            success: true,
            data: timeline,
        };
    }
};
exports.SchedulingController = SchedulingController;
__decorate([
    (0, common_1.Post)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Create a confirmed schedule from an accepted assignment' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateScheduleRequestDto, Object]),
    __metadata("design:returntype", Promise)
], SchedulingController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all active schedules' }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], SchedulingController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get details for a single schedule by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SchedulingController.prototype, "findOne", null);
__decorate([
    (0, common_1.Post)(':id/transition'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Transition schedule state' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, TransitionScheduleRequestDto, Object]),
    __metadata("design:returntype", Promise)
], SchedulingController.prototype, "transition", null);
__decorate([
    (0, common_1.Get)(':id/timeline'),
    (0, swagger_1.ApiOperation)({ summary: 'Get unified activity timeline for a schedule' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SchedulingController.prototype, "getTimeline", null);
exports.SchedulingController = SchedulingController = __decorate([
    (0, swagger_1.ApiTags)('Scheduling'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('schedules'),
    __metadata("design:paramtypes", [scheduling_service_1.SchedulingService])
], SchedulingController);
//# sourceMappingURL=scheduling.controller.js.map