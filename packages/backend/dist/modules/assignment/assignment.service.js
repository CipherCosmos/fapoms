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
exports.AssignmentService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const assignment_entity_1 = require("./assignment.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let AssignmentService = class AssignmentService {
    assignmentRepository;
    projectBranchRepository;
    holidayService;
    auditService;
    constructor(assignmentRepository, projectBranchRepository, holidayService, auditService) {
        this.assignmentRepository = assignmentRepository;
        this.projectBranchRepository = projectBranchRepository;
        this.holidayService = holidayService;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const projectBranch = await this.projectBranchRepository.findOne({
            where: { id: dto.projectBranchId, isActive: true },
            relations: ['branch'],
        });
        if (!projectBranch) {
            throw new common_1.NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
        }
        const scheduledDateObj = new Date(dto.scheduledDate);
        const isHolidayConflict = await this.holidayService.isHoliday(scheduledDateObj, projectBranch.branch.state);
        if (isHolidayConflict) {
            throw new common_1.BadRequestException(`Holiday Conflict: ${dto.scheduledDate} is a national/bank holiday in ${projectBranch.branch.state}.`);
        }
        const isDoubleBooked = await this.assignmentRepository.findOne({
            where: {
                assayerId: dto.assayerId,
                scheduledDate: scheduledDateObj,
                status: (0, typeorm_2.In)([shared_1.AssignmentStatus.ACCEPTED, shared_1.AssignmentStatus.SCHEDULED]),
                isActive: true,
            },
        });
        if (isDoubleBooked) {
            throw new common_1.ConflictException(`Assayer Collision: Assayer is already assigned to branch audit on ${dto.scheduledDate}.`);
        }
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        const assignmentNumber = `ASN-${new Date().getFullYear()}-${randomSuffix}`;
        const assignment = this.assignmentRepository.create({
            assignmentNumber,
            projectBranchId: projectBranch.id,
            projectId: projectBranch.projectId,
            assayerId: dto.assayerId,
            status: shared_1.AssignmentStatus.ACCEPTED,
            proposedFee: dto.proposedFee,
            agreedFee: dto.proposedFee,
            scheduledDate: scheduledDateObj,
            remarks: dto.remarks ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const savedAssignment = await this.assignmentRepository.save(assignment);
        projectBranch.status = shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED;
        projectBranch.scheduledDate = scheduledDateObj;
        projectBranch.updatedBy = userId;
        await this.projectBranchRepository.save(projectBranch);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSIGNMENT_ACCEPTED',
            entityType: 'ASSIGNMENT',
            entityId: savedAssignment.id,
            userId,
            remarks: `Assigned branch ${projectBranch.branch.name} to assayer. Fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`,
        });
        return savedAssignment;
    }
    async findAll(page = 1, limit = 50) {
        const [assignments, total] = await this.assignmentRepository.findAndCount({
            where: { isActive: true },
            relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
            order: { createdAt: 'DESC' },
            take: limit,
            skip: (page - 1) * limit,
        });
        return { assignments, total };
    }
};
exports.AssignmentService = AssignmentService;
exports.AssignmentService = AssignmentService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        holiday_service_1.HolidayService,
        audit_service_1.AuditService])
], AssignmentService);
//# sourceMappingURL=assignment.service.js.map