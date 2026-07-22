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
exports.AssignmentController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const assignment_service_1 = require("./assignment.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
let AssignmentController = class AssignmentController {
    assignmentService;
    constructor(assignmentService) {
        this.assignmentService = assignmentService;
    }
    async create(dto, req) {
        const assignment = await this.assignmentService.create(dto, req.user.id);
        return {
            success: true,
            data: assignment,
        };
    }
    async findAll(page, limit) {
        const result = await this.assignmentService.findAll(page ? Number(page) : 1, limit ? Number(limit) : 50);
        return {
            success: true,
            data: result.assignments,
            meta: {
                pagination: {
                    page: page ? Number(page) : 1,
                    limit: limit ? Number(limit) : 50,
                    total: result.total,
                },
            },
        };
    }
    async getDashboardSummary() {
        const summary = await this.assignmentService.getDashboardSummary();
        return {
            success: true,
            data: summary,
        };
    }
    async findOne(id) {
        const assignment = await this.assignmentService.findOne(id);
        return {
            success: true,
            data: assignment,
        };
    }
    async update(id, dto, req) {
        const assignment = await this.assignmentService.update(id, dto, req.user.id);
        return {
            success: true,
            data: assignment,
        };
    }
    async transition(id, dto, req) {
        const assignment = await this.assignmentService.transition(id, dto.targetStatus, req.user.id, dto.remarks, dto.reason, dto.fee, dto.scheduledDate);
        return {
            success: true,
            data: assignment,
        };
    }
    async getTimeline(id) {
        const timeline = await this.assignmentService.getTimeline(id);
        return {
            success: true,
            data: timeline,
        };
    }
    async addComment(id, body, req) {
        const userName = req.user.displayName || req.user.email || 'System User';
        const comment = await this.assignmentService.addComment(id, body.comment, req.user.id, userName);
        return {
            success: true,
            data: comment,
        };
    }
};
exports.AssignmentController = AssignmentController;
__decorate([
    (0, common_1.Post)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new assignment in CREATED status' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all assignments' }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)('dashboard/summary'),
    (0, swagger_1.ApiOperation)({ summary: 'Get assignment status and SLA statistics summary' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "getDashboardSummary", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get details for a single assignment by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "findOne", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Update assignment details' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "update", null);
__decorate([
    (0, common_1.Post)(':id/transition'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Transition assignment to a new state' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "transition", null);
__decorate([
    (0, common_1.Get)(':id/timeline'),
    (0, swagger_1.ApiOperation)({ summary: 'Get unified activity timeline for an assignment' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "getTimeline", null);
__decorate([
    (0, common_1.Post)(':id/comments'),
    (0, swagger_1.ApiOperation)({ summary: 'Post a comment to an assignment' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "addComment", null);
exports.AssignmentController = AssignmentController = __decorate([
    (0, swagger_1.ApiTags)('Assignments'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('assignments'),
    __metadata("design:paramtypes", [assignment_service_1.AssignmentService])
], AssignmentController);
//# sourceMappingURL=assignment.controller.js.map