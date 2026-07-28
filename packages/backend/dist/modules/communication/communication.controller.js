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
exports.CommunicationController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const communication_service_1 = require("./communication.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
class CreateCommunicationRequestDto {
    assignmentId;
    type;
    content;
    recipientRef;
}
__decorate([
    (0, class_validator_1.IsUUID)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateCommunicationRequestDto.prototype, "assignmentId", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(shared_1.CommunicationType),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateCommunicationRequestDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateCommunicationRequestDto.prototype, "content", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCommunicationRequestDto.prototype, "recipientRef", void 0);
let CommunicationController = class CommunicationController {
    communicationService;
    constructor(communicationService) {
        this.communicationService = communicationService;
    }
    async create(dto, req) {
        const comm = await this.communicationService.create(dto, req.user.id);
        return {
            success: true,
            data: comm,
        };
    }
    async findByAssignment(assignmentId) {
        const history = await this.communicationService.findByAssignment(assignmentId);
        return {
            success: true,
            data: history,
        };
    }
};
exports.CommunicationController = CommunicationController;
__decorate([
    (0, common_1.Post)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, guards_1.RequirePermissions)('communication:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Log a communication record' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateCommunicationRequestDto, Object]),
    __metadata("design:returntype", Promise)
], CommunicationController.prototype, "create", null);
__decorate([
    (0, common_1.Get)('assignment/:assignmentId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get communication history for an assignment' }),
    __param(0, (0, common_1.Param)('assignmentId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], CommunicationController.prototype, "findByAssignment", null);
exports.CommunicationController = CommunicationController = __decorate([
    (0, swagger_1.ApiTags)('Communications'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard, guards_1.PermissionsGuard),
    (0, common_1.Controller)('communications'),
    __metadata("design:paramtypes", [communication_service_1.CommunicationService])
], CommunicationController);
//# sourceMappingURL=communication.controller.js.map