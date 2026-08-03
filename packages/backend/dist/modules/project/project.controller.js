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
exports.ProjectController = exports.CreateProjectRequestDto = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const platform_express_1 = require("@nestjs/platform-express");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const class_validator_1 = require("class-validator");
const project_service_1 = require("./project.service");
const guards_1 = require("../auth/guards");
const staff_roles_1 = require("../auth/staff-roles");
const shared_1 = require("@fapoms/shared");
const user_entity_1 = require("../user/user.entity");
class CreateProjectRequestDto {
    name;
    projectNumber;
    description;
    clientId;
    priority;
    startDate;
    endDate;
    budget;
    scope;
    requiredSkills;
    requiredCertifications;
    sla;
    risks;
    milestones;
    dependencies;
    status;
}
exports.CreateProjectRequestDto = CreateProjectRequestDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateProjectRequestDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateProjectRequestDto.prototype, "projectNumber", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateProjectRequestDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateProjectRequestDto.prototype, "clientId", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateProjectRequestDto.prototype, "priority", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateProjectRequestDto.prototype, "startDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateProjectRequestDto.prototype, "endDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], CreateProjectRequestDto.prototype, "budget", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateProjectRequestDto.prototype, "scope", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateProjectRequestDto.prototype, "requiredSkills", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateProjectRequestDto.prototype, "requiredCertifications", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateProjectRequestDto.prototype, "sla", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateProjectRequestDto.prototype, "risks", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateProjectRequestDto.prototype, "milestones", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateProjectRequestDto.prototype, "dependencies", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateProjectRequestDto.prototype, "status", void 0);
class UpdateProjectRequestDto {
    name;
    projectNumber;
    description;
    clientId;
    priority;
    startDate;
    endDate;
    budget;
    scope;
    requiredSkills;
    requiredCertifications;
    sla;
    risks;
    milestones;
    dependencies;
}
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProjectRequestDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProjectRequestDto.prototype, "projectNumber", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProjectRequestDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProjectRequestDto.prototype, "clientId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProjectRequestDto.prototype, "priority", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProjectRequestDto.prototype, "startDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProjectRequestDto.prototype, "endDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], UpdateProjectRequestDto.prototype, "budget", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProjectRequestDto.prototype, "scope", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateProjectRequestDto.prototype, "requiredSkills", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], UpdateProjectRequestDto.prototype, "requiredCertifications", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpdateProjectRequestDto.prototype, "sla", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpdateProjectRequestDto.prototype, "risks", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpdateProjectRequestDto.prototype, "milestones", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpdateProjectRequestDto.prototype, "dependencies", void 0);
class TransitionProjectRequestDto {
    targetStatus;
    reason;
}
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], TransitionProjectRequestDto.prototype, "targetStatus", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TransitionProjectRequestDto.prototype, "reason", void 0);
let ProjectController = class ProjectController {
    projectService;
    userRepository;
    constructor(projectService, userRepository) {
        this.projectService = projectService;
        this.userRepository = userRepository;
    }
    async create(dto, req) {
        const project = await this.projectService.create(dto, req.user.id, req.user.organizationId);
        return {
            success: true,
            data: project,
        };
    }
    async findAll(page, limit) {
        const result = await this.projectService.findAll(page ? Number(page) : 1, limit ? Number(limit) : 50);
        return {
            success: true,
            data: result.projects,
            meta: {
                pagination: {
                    page: page ? Number(page) : 1,
                    limit: limit ? Number(limit) : 50,
                    total: result.total,
                },
            },
        };
    }
    async findOne(id) {
        const project = await this.projectService.findOne(id);
        return {
            success: true,
            data: project,
        };
    }
    async update(id, dto, req) {
        const project = await this.projectService.update(id, dto, req.user.id);
        return {
            success: true,
            data: project,
        };
    }
    async transition(id, dto, req) {
        const project = await this.projectService.transition(id, dto.targetStatus, req.user.id, dto.reason);
        return { success: true, data: project };
    }
    async remove(id, req) {
        await this.projectService.remove(id, req.user.id);
        return {
            success: true,
            data: { message: 'Project deleted successfully' },
        };
    }
    async getBranchHistory(projectBranchId) {
        return { success: true, data: await this.projectService.getBranchHistory(projectBranchId) };
    }
    async getProjectBranches(id) {
        const branches = await this.projectService.findProjectBranches(id);
        const activeAssignmentByBranch = new Map(branches.map(b => [
            b.id,
            b.assignments
                ?.filter(a => a.status !== 'CANCELLED' && a.status !== 'REJECTED')
                ?.sort((a, b2) => new Date(b2.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())?.[0],
        ]));
        const creatorIds = [...new Set([...activeAssignmentByBranch.values()].map(a => a?.createdBy).filter((v) => !!v))];
        const creators = creatorIds.length
            ? await this.userRepository.find({ where: { id: (0, typeorm_2.In)(creatorIds) }, select: ['id', 'displayName'] })
            : [];
        const creatorNameById = new Map(creators.map(u => [u.id, u.displayName]));
        const data = branches.map(b => {
            const activeAssignment = activeAssignmentByBranch.get(b.id);
            return {
                ...b,
                assignment: activeAssignment ? {
                    id: activeAssignment.id,
                    status: activeAssignment.status,
                    proposedFee: activeAssignment.proposedFee,
                    agreedFee: activeAssignment.agreedFee,
                    scheduledDate: activeAssignment.scheduledDate,
                    remarks: activeAssignment.remarks,
                    negotiatedByName: activeAssignment.createdBy
                        ? creatorNameById.get(activeAssignment.createdBy) ?? null
                        : null,
                    negotiationCount: activeAssignment.negotiationCount ?? 0,
                    assayer: activeAssignment.assayer ? {
                        displayName: activeAssignment.assayer.displayName,
                        id: activeAssignment.assayer.id,
                        assayerCode: activeAssignment.assayer.assayerCode,
                    } : undefined,
                } : null,
                assignments: undefined,
            };
        });
        return {
            success: true,
            data,
        };
    }
    async associateBranches(id, dto, req) {
        const list = await this.projectService.associateBranches(id, dto.branchIds, req.user.id);
        return {
            success: true,
            data: list,
        };
    }
    async uploadBranches(id, file, req) {
        const list = await this.projectService.uploadBranchesFromExcel(id, file.buffer, req.user.id);
        return {
            success: true,
            data: list,
        };
    }
    async downloadTemplate(id, res) {
        const buffer = await this.projectService.generateBranchTemplate(id);
        const filename = encodeURIComponent('branch_upload_template.xlsx');
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
        });
        res.send(buffer);
    }
    async removeBranch(id, pbId, req) {
        const list = await this.projectService.removeProjectBranch(id, pbId, req.user.id);
        return {
            success: true,
            data: list,
        };
    }
};
exports.ProjectController = ProjectController;
__decorate([
    (0, common_1.Post)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('project:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new project linked to a client institution' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateProjectRequestDto, Object]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get paginated list of projects' }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get details for a single project by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "findOne", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('project:edit:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Update project details' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, UpdateProjectRequestDto, Object]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "update", null);
__decorate([
    (0, common_1.Post)(':id/transition'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('project:edit:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Move a project to another lifecycle status' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, TransitionProjectRequestDto, Object]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "transition", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, guards_1.RequirePermissions)('project:delete:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Soft delete a project' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "remove", null);
__decorate([
    (0, common_1.Get)('branches/:projectBranchId/history'),
    (0, swagger_1.ApiOperation)({ summary: 'Full timeline for one project branch: status, assignments, documents, validation' }),
    __param(0, (0, common_1.Param)('projectBranchId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "getBranchHistory", null);
__decorate([
    (0, common_1.Get)(':id/branches'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.READ_ONLY_AUDITOR),
    (0, swagger_1.ApiOperation)({ summary: 'Get unassigned and planning branches queue for project' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "getProjectBranches", null);
__decorate([
    (0, common_1.Post)(':id/branches'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('project:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Associate branches with a project' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "associateBranches", null);
__decorate([
    (0, common_1.Post)(':id/branches/upload'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('project:create:organization'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    (0, swagger_1.ApiOperation)({ summary: 'Upload branches from Excel spreadsheet and associate with project' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.UploadedFile)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "uploadBranches", null);
__decorate([
    (0, common_1.Get)(':id/branches/template'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Download Excel template for branch data entry' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "downloadTemplate", null);
__decorate([
    (0, common_1.Delete)(':id/branches/:pbId'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('project:delete:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Remove a branch association from a project' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Param)('pbId', common_1.ParseUUIDPipe)),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], ProjectController.prototype, "removeBranch", null);
exports.ProjectController = ProjectController = __decorate([
    (0, swagger_1.ApiTags)('Projects'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard, guards_1.PermissionsGuard),
    (0, guards_1.Roles)(...staff_roles_1.STAFF_ROLES),
    (0, common_1.Controller)('projects'),
    __param(1, (0, typeorm_1.InjectRepository)(user_entity_1.UserEntity)),
    __metadata("design:paramtypes", [project_service_1.ProjectService,
        typeorm_2.Repository])
], ProjectController);
//# sourceMappingURL=project.controller.js.map