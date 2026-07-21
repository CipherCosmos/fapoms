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
exports.ValidationController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const validation_service_1 = require("./validation.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
class CreateValidationCaseRequestDto {
    projectBranchId;
}
class AssignReviewerDto {
    reviewerId;
}
class TransitionValidationCaseDto {
    targetStatus;
    remarks;
    notes;
    ocrResult;
}
let ValidationController = class ValidationController {
    validationService;
    constructor(validationService) {
        this.validationService = validationService;
    }
    async create(dto, req) {
        const vCase = await this.validationService.create(dto, req.user.id);
        return {
            success: true,
            data: vCase,
        };
    }
    async findAll(page = 1, limit = 50) {
        const { validationCases, total } = await this.validationService.findAll(Number(page), Number(limit));
        return {
            success: true,
            data: validationCases,
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
        const vCase = await this.validationService.findOne(id);
        return {
            success: true,
            data: vCase,
        };
    }
    async assign(id, dto, req) {
        const vCase = await this.validationService.assign(id, dto.reviewerId, req.user.id);
        return {
            success: true,
            data: vCase,
        };
    }
    async transition(id, dto, req) {
        const vCase = await this.validationService.transition(id, dto.targetStatus, req.user.id, dto.remarks, dto.notes, dto.ocrResult);
        return {
            success: true,
            data: vCase,
        };
    }
};
exports.ValidationController = ValidationController;
__decorate([
    (0, common_1.Post)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.VALIDATION_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Register a project branch for document validation' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateValidationCaseRequestDto, Object]),
    __metadata("design:returntype", Promise)
], ValidationController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all validation queue cases' }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ValidationController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get details for a validation case by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ValidationController.prototype, "findOne", null);
__decorate([
    (0, common_1.Post)(':id/assign'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.VALIDATION_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Assign a validation case to a validator reviewer' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, AssignReviewerDto, Object]),
    __metadata("design:returntype", Promise)
], ValidationController.prototype, "assign", null);
__decorate([
    (0, common_1.Post)(':id/transition'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.VALIDATION_MANAGER, shared_1.SystemRole.VALIDATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Transition validation case status' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, TransitionValidationCaseDto, Object]),
    __metadata("design:returntype", Promise)
], ValidationController.prototype, "transition", null);
exports.ValidationController = ValidationController = __decorate([
    (0, swagger_1.ApiTags)('Validation'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('validation'),
    __metadata("design:paramtypes", [validation_service_1.ValidationService])
], ValidationController);
//# sourceMappingURL=validation.controller.js.map