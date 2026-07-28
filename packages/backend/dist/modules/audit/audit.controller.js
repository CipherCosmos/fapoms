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
exports.AuditController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const audit_service_1 = require("./audit.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
class StartAuditDto {
    assignmentId;
    assayerId;
    projectId;
    branchId;
    scheduledDate;
}
__decorate([
    (0, class_validator_1.IsUUID)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], StartAuditDto.prototype, "assignmentId", void 0);
__decorate([
    (0, class_validator_1.IsUUID)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], StartAuditDto.prototype, "assayerId", void 0);
__decorate([
    (0, class_validator_1.IsUUID)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], StartAuditDto.prototype, "projectId", void 0);
__decorate([
    (0, class_validator_1.IsUUID)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], StartAuditDto.prototype, "branchId", void 0);
__decorate([
    (0, class_validator_1.IsDateString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], StartAuditDto.prototype, "scheduledDate", void 0);
class CloseAuditDto {
    baseFee;
    travelAllowance;
}
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], CloseAuditDto.prototype, "baseFee", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], CloseAuditDto.prototype, "travelAllowance", void 0);
let AuditController = class AuditController {
    auditService;
    constructor(auditService) {
        this.auditService = auditService;
    }
    async startAudit(dto) {
        const audit = await this.auditService.startAudit(dto.assignmentId, dto.assayerId, dto.projectId, dto.branchId, new Date(dto.scheduledDate));
        return {
            success: true,
            data: audit,
        };
    }
    async closeAudit(id, dto) {
        const audit = await this.auditService.closeAudit(id, dto.baseFee, dto.travelAllowance);
        return {
            success: true,
            data: audit,
        };
    }
};
exports.AuditController = AuditController;
__decorate([
    (0, common_1.Post)('start'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.ASSAYER),
    (0, guards_1.RequirePermissions)('audit:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Start a field audit' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [StartAuditDto]),
    __metadata("design:returntype", Promise)
], AuditController.prototype, "startAudit", null);
__decorate([
    (0, common_1.Post)(':id/close'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('audit:update:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Close a field audit and trigger billing and ledger credits' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, CloseAuditDto]),
    __metadata("design:returntype", Promise)
], AuditController.prototype, "closeAudit", null);
exports.AuditController = AuditController = __decorate([
    (0, swagger_1.ApiTags)('Audit Operations'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard, guards_1.PermissionsGuard),
    (0, common_1.Controller)('audits'),
    __metadata("design:paramtypes", [audit_service_1.AuditService])
], AuditController);
//# sourceMappingURL=audit.controller.js.map