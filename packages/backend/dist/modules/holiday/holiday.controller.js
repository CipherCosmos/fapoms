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
exports.HolidayController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const holiday_service_1 = require("./holiday.service");
const guards_1 = require("../auth/guards");
const staff_roles_1 = require("../auth/staff-roles");
const shared_1 = require("@fapoms/shared");
class CreateHolidayRequestDto {
    name;
    date;
    type;
    applicableStates;
    clientId;
}
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateHolidayRequestDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", Object)
], CreateHolidayRequestDto.prototype, "date", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateHolidayRequestDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateHolidayRequestDto.prototype, "applicableStates", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateHolidayRequestDto.prototype, "clientId", void 0);
class UpdateHolidayRequestDto {
    name;
    date;
    type;
    applicableStates;
    clientId;
}
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateHolidayRequestDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", Object)
], UpdateHolidayRequestDto.prototype, "date", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateHolidayRequestDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateHolidayRequestDto.prototype, "applicableStates", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateHolidayRequestDto.prototype, "clientId", void 0);
let HolidayController = class HolidayController {
    holidayService;
    constructor(holidayService) {
        this.holidayService = holidayService;
    }
    async create(dto, req) {
        const holiday = await this.holidayService.create(dto, req.user.id);
        return {
            success: true,
            data: holiday,
        };
    }
    async findAll(page = 1, limit = 50, year, clientId) {
        const { holidays, total } = await this.holidayService.findAll(page, limit, year, clientId);
        return {
            success: true,
            data: holidays,
            meta: {
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNext: page * limit < total,
                    hasPrevious: page > 1,
                },
            },
        };
    }
    async checkHoliday(dateString, stateCode, clientId) {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
            return { success: false, error: 'Invalid date parameter' };
        }
        const isHoliday = await this.holidayService.isHoliday(date, stateCode, clientId);
        return {
            success: true,
            data: { isHoliday },
        };
    }
    async update(id, dto, req) {
        const holiday = await this.holidayService.update(id, dto, req.user.id);
        return {
            success: true,
            data: holiday,
        };
    }
    async remove(id, req) {
        await this.holidayService.remove(id, req.user.id);
        return {
            success: true,
            data: { message: 'Holiday deleted successfully' },
        };
    }
};
exports.HolidayController = HolidayController;
__decorate([
    (0, common_1.Post)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('holiday:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Register a national or regional holiday' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateHolidayRequestDto, Object]),
    __metadata("design:returntype", Promise)
], HolidayController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List and filter holiday records' }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __param(2, (0, common_1.Query)('year')),
    __param(3, (0, common_1.Query)('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Number, String]),
    __metadata("design:returntype", Promise)
], HolidayController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)('check'),
    (0, swagger_1.ApiOperation)({ summary: 'Verify if a date is a holiday' }),
    __param(0, (0, common_1.Query)('date')),
    __param(1, (0, common_1.Query)('stateCode')),
    __param(2, (0, common_1.Query)('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], HolidayController.prototype, "checkHoliday", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('holiday:edit:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Update holiday record details' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, UpdateHolidayRequestDto, Object]),
    __metadata("design:returntype", Promise)
], HolidayController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('holiday:delete:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Soft delete holiday record' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], HolidayController.prototype, "remove", null);
exports.HolidayController = HolidayController = __decorate([
    (0, swagger_1.ApiTags)('Holidays'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard, guards_1.PermissionsGuard),
    (0, guards_1.Roles)(...staff_roles_1.STAFF_ROLES),
    (0, common_1.Controller)('holidays'),
    __metadata("design:paramtypes", [holiday_service_1.HolidayService])
], HolidayController);
//# sourceMappingURL=holiday.controller.js.map