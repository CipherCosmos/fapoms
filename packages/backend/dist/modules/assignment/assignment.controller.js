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
const shared_1 = require("@fapoms/shared");
const assignment_service_1 = require("./assignment.service");
const guards_1 = require("../auth/guards");
const staff_roles_1 = require("../auth/staff-roles");
let AssignmentController = class AssignmentController {
    assignmentService;
    constructor(assignmentService) {
        this.assignmentService = assignmentService;
    }
    async findByAssayer(assayerId, req) {
        const roles = (req.user?.roles ?? []).map((r) => r?.name ?? r).filter(Boolean);
        const isStaff = roles.some((r) => staff_roles_1.STAFF_ROLES.includes(r));
        if (!isStaff && req.user?.id !== assayerId) {
            throw new common_1.ForbiddenException('You may only view your own assignments');
        }
        const items = await this.assignmentService.findByAssayer(assayerId);
        return { success: true, items };
    }
    async checkIn(id, dto, req) {
        const body = dto || {};
        const lat = body.lat ?? body.latitude ?? 0;
        const lng = body.lng ?? body.longitude ?? 0;
        const userId = req.user.id;
        const result = await this.assignmentService.recordCheckIn(id, lat, lng, body.syncToken, userId);
        if (!result.success) {
            return {
                success: false,
                error: result.error,
                message: result.message,
            };
        }
        return {
            success: true,
            message: result.message,
            syncToken: result.assignment.syncToken,
            timestamp: body.timestamp || new Date().toISOString(),
            data: result.assignment,
        };
    }
    async create(dto, req) {
        const userId = req?.user?.id || '00000000-0000-0000-0000-000000000000';
        const assignment = await this.assignmentService.create(dto, userId);
        return {
            success: true,
            data: assignment,
        };
    }
    async findAll(page, limit, status, projectBranchStatus, assessmentStatus, unscheduledOnly, priority) {
        const result = await this.assignmentService.findAll(page ? Number(page) : 1, limit ? Number(limit) : 50, status, projectBranchStatus, assessmentStatus, unscheduledOnly === 'true' || unscheduledOnly === '1', priority);
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
        const userId = req?.user?.id || '00000000-0000-0000-0000-000000000000';
        const assignment = await this.assignmentService.update(id, dto, userId);
        return {
            success: true,
            data: assignment,
        };
    }
    async transition(id, dto, req) {
        const body = dto || {};
        const targetStatus = body.targetStatus || body.status;
        if (!targetStatus) {
            throw new common_1.BadRequestException('targetStatus is required for assignment transition');
        }
        const userId = req.user.id;
        let assignment;
        if (targetStatus === 'COUNTER_OFFER' || targetStatus === 'NEGOTIATION' || (targetStatus === 'PENDING' && (body.counterFee !== undefined || body.fee !== undefined || body.proposedFee !== undefined))) {
            const feeVal = body.counterFee ?? body.fee ?? body.proposedFee;
            if (!feeVal || isNaN(Number(feeVal))) {
                throw new common_1.BadRequestException('Valid counter fee amount is required for negotiation.');
            }
            assignment = await this.assignmentService.proposeCounterFee(id, userId, Number(feeVal), body.reason ?? body.remarks);
        }
        else if (targetStatus === 'ACCEPTED') {
            assignment = await this.assignmentService.acceptOffer(id, userId, undefined, body.reason ?? body.remarks);
        }
        else if (targetStatus === 'REJECTED') {
            assignment = await this.assignmentService.rejectOffer(id, userId, body.reason ?? body.remarks);
        }
        else if (targetStatus === 'CHECKED_IN') {
            const lat = Number(body.lat || body.latitude || 28.6315);
            const lng = Number(body.lng || body.longitude || 77.2167);
            const checkInRes = await this.assignmentService.recordCheckIn(id, lat, lng, body.syncToken, userId);
            assignment = checkInRes.assignment || (await this.assignmentService.findOne(id));
        }
        else if (targetStatus === 'CANCELLED') {
            assignment = await this.assignmentService.cancelAssignment(id, userId, body.reason ?? body.remarks);
        }
        else if (targetStatus === 'COMPLETED') {
            assignment = await this.assignmentService.completeAssignment(id, userId, body.reason ?? body.remarks);
        }
        else {
            throw new common_1.BadRequestException(`Invalid transition: ${targetStatus}.`);
        }
        return {
            success: true,
            data: assignment,
        };
    }
    async escalate(id, body, req) {
        const userId = req.user.id;
        const assignment = await this.assignmentService.escalate(id, userId, body?.reason);
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
    (0, common_1.Get)('assayer/:assayerId'),
    (0, guards_1.Roles)(...staff_roles_1.STAFF_ROLES, shared_1.SystemRole.ASSAYER),
    (0, swagger_1.ApiOperation)({ summary: 'Get active assignments for a specific assayer (Mobile App API)' }),
    __param(0, (0, common_1.Param)('assayerId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "findByAssayer", null);
__decorate([
    (0, common_1.Post)(':id/check-in'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'GPS Check-in with SyncToken Conflict Check for Assayer Mobile App' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "checkIn", null);
__decorate([
    (0, common_1.Post)(),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new assignment in CREATED status' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "create", null);
__decorate([
    (0, guards_1.Roles)(...staff_roles_1.STAFF_ROLES),
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List all assignments, optionally filtered by status, projectBranchStatus, assessmentStatus, or priority' }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __param(2, (0, common_1.Query)('status')),
    __param(3, (0, common_1.Query)('projectBranchStatus')),
    __param(4, (0, common_1.Query)('assessmentStatus')),
    __param(5, (0, common_1.Query)('unscheduledOnly')),
    __param(6, (0, common_1.Query)('priority')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number, String, String, String, String, String]),
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
    (0, swagger_1.ApiOperation)({ summary: 'Transition assignment status' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "transition", null);
__decorate([
    (0, common_1.Post)(':id/escalate'),
    (0, swagger_1.ApiOperation)({ summary: 'Flag an assignment as urgent (sets priority to CRITICAL) and notify the assigning user' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AssignmentController.prototype, "escalate", null);
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
    (0, guards_1.RequirePermissions)('assignment:create:organization'),
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
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard, guards_1.PermissionsGuard),
    (0, common_1.Controller)('assignments'),
    __metadata("design:paramtypes", [assignment_service_1.AssignmentService])
], AssignmentController);
//# sourceMappingURL=assignment.controller.js.map