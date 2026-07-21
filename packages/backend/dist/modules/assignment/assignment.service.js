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
const typeorm_3 = require("@nestjs/typeorm");
const assignment_entity_1 = require("./assignment.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const workflow_engine_1 = require("../platform/workflow/workflow.engine");
const shared_1 = require("@fapoms/shared");
let AssignmentService = class AssignmentService {
    assignmentRepository;
    projectBranchRepository;
    holidayService;
    auditService;
    workflowEngine;
    dataSource;
    constructor(assignmentRepository, projectBranchRepository, holidayService, auditService, workflowEngine, dataSource) {
        this.assignmentRepository = assignmentRepository;
        this.projectBranchRepository = projectBranchRepository;
        this.holidayService = holidayService;
        this.auditService = auditService;
        this.workflowEngine = workflowEngine;
        this.dataSource = dataSource;
    }
    onModuleInit() {
        this.workflowEngine.registerWorkflow('assignment', [
            {
                from: [shared_1.AssignmentStatus.CREATED],
                to: shared_1.AssignmentStatus.CANDIDATE_SELECTED,
                beforeTransition: async (ctx) => {
                },
            },
            {
                from: [shared_1.AssignmentStatus.CANDIDATE_SELECTED],
                to: shared_1.AssignmentStatus.CONTACT_INITIATED,
                beforeTransition: async (ctx) => {
                },
            },
            {
                from: [shared_1.AssignmentStatus.CONTACT_INITIATED],
                to: shared_1.AssignmentStatus.NEGOTIATION,
                beforeTransition: async (ctx) => {
                },
            },
            {
                from: [shared_1.AssignmentStatus.CREATED, shared_1.AssignmentStatus.NEGOTIATION],
                to: shared_1.AssignmentStatus.ACCEPTED,
                beforeTransition: async (ctx) => {
                    const { assignment, fee } = ctx.payload;
                    assignment.agreedFee = fee ?? assignment.proposedFee;
                    assignment.projectBranch.status = shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED;
                },
            },
            {
                from: [shared_1.AssignmentStatus.CREATED, shared_1.AssignmentStatus.NEGOTIATION],
                to: shared_1.AssignmentStatus.REJECTED,
                beforeTransition: async (ctx) => {
                    const { assignment, reason, remarks } = ctx.payload;
                    assignment.rejectReason = reason ?? remarks ?? 'Rejected by Assayer';
                    assignment.projectBranch.status = shared_1.ProjectBranchStatus.CANDIDATE_SEARCH;
                },
            },
            {
                from: [
                    shared_1.AssignmentStatus.CREATED,
                    shared_1.AssignmentStatus.CANDIDATE_SELECTED,
                    shared_1.AssignmentStatus.CONTACT_INITIATED,
                    shared_1.AssignmentStatus.NEGOTIATION,
                    shared_1.AssignmentStatus.ACCEPTED,
                ],
                to: shared_1.AssignmentStatus.CANCELLED,
                beforeTransition: async (ctx) => {
                    const { assignment, reason, remarks } = ctx.payload;
                    assignment.cancelReason = reason ?? remarks ?? 'Cancelled by Admin';
                    assignment.projectBranch.status = shared_1.ProjectBranchStatus.CANDIDATE_SEARCH;
                },
            },
            {
                from: [shared_1.AssignmentStatus.ACCEPTED],
                to: shared_1.AssignmentStatus.SCHEDULED,
                guards: [
                    async (ctx) => {
                        const { scheduledDate, state } = ctx.payload;
                        if (scheduledDate) {
                            const isHoliday = await this.holidayService.isHoliday(new Date(scheduledDate), state);
                            if (isHoliday) {
                                throw new common_1.BadRequestException(`Holiday Conflict: ${scheduledDate} is a holiday in ${state}.`);
                            }
                        }
                        return true;
                    },
                ],
                beforeTransition: async (ctx) => {
                    const { assignment, scheduledDate } = ctx.payload;
                    if (scheduledDate) {
                        const scheduledDateObj = new Date(scheduledDate);
                        assignment.scheduledDate = scheduledDateObj;
                        assignment.projectBranch.scheduledDate = scheduledDateObj;
                    }
                    assignment.projectBranch.status = shared_1.ProjectBranchStatus.SCHEDULED;
                },
            },
            {
                from: [shared_1.AssignmentStatus.SCHEDULED],
                to: shared_1.AssignmentStatus.AUDIT_COMPLETED,
                beforeTransition: async (ctx) => {
                    const { assignment } = ctx.payload;
                    assignment.completionDate = new Date();
                    assignment.projectBranch.status = shared_1.ProjectBranchStatus.AUDIT_COMPLETED;
                },
            },
            {
                from: [shared_1.AssignmentStatus.AUDIT_COMPLETED],
                to: shared_1.AssignmentStatus.CLOSED,
                beforeTransition: async (ctx) => {
                    const { assignment } = ctx.payload;
                    assignment.projectBranch.status = shared_1.ProjectBranchStatus.CLOSED;
                },
            },
        ]);
    }
    async create(dto, userId) {
        const projectBranch = await this.projectBranchRepository.findOne({
            where: { id: dto.projectBranchId, isActive: true },
            relations: ['branch'],
        });
        if (!projectBranch) {
            throw new common_1.NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
        }
        const existingAssignment = await this.assignmentRepository.findOne({
            where: { projectBranchId: projectBranch.id },
        });
        if (existingAssignment) {
            if (existingAssignment.status === shared_1.AssignmentStatus.CANCELLED ||
                existingAssignment.status === shared_1.AssignmentStatus.REJECTED) {
                await this.assignmentRepository.remove(existingAssignment);
            }
            else {
                throw new common_1.ConflictException(`Branch Busy: An active assignment (${existingAssignment.assignmentNumber}) already exists for this branch.`);
            }
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
            status: shared_1.AssignmentStatus.CREATED,
            proposedFee: dto.proposedFee,
            agreedFee: null,
            scheduledDate: scheduledDateObj,
            remarks: dto.remarks ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        return this.dataSource.transaction(async (manager) => {
            const savedAssignment = await manager.save(assignment);
            projectBranch.status = shared_1.ProjectBranchStatus.PLANNING;
            projectBranch.updatedBy = userId;
            await manager.save(projectBranch);
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.OPERATIONAL,
                eventType: 'ASSIGNMENT_CREATED',
                entityType: 'ASSIGNMENT',
                entityId: savedAssignment.id,
                userId,
                remarks: `Created assignment offer for branch ${projectBranch.branch.name}. Fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`,
            });
            return savedAssignment;
        });
    }
    async findOne(id) {
        const assignment = await this.assignmentRepository.findOne({
            where: { id, isActive: true },
            relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
        });
        if (!assignment) {
            throw new common_1.NotFoundException(`Assignment ${id} not found.`);
        }
        return assignment;
    }
    async update(id, dto, userId) {
        const assignment = await this.findOne(id);
        if (assignment.status === shared_1.AssignmentStatus.ACCEPTED ||
            assignment.status === shared_1.AssignmentStatus.SCHEDULED ||
            assignment.status === shared_1.AssignmentStatus.AUDIT_COMPLETED ||
            assignment.status === shared_1.AssignmentStatus.CLOSED) {
            throw new common_1.BadRequestException(`Locked: Cannot modify assignment details after acceptance (Current status: ${assignment.status}).`);
        }
        if (dto.proposedFee !== undefined)
            assignment.proposedFee = dto.proposedFee;
        if (dto.agreedFee !== undefined)
            assignment.agreedFee = dto.agreedFee;
        if (dto.scheduledDate !== undefined) {
            const scheduledDateObj = new Date(dto.scheduledDate);
            const isHolidayConflict = await this.holidayService.isHoliday(scheduledDateObj, assignment.projectBranch.branch.state);
            if (isHolidayConflict) {
                throw new common_1.BadRequestException(`Holiday Conflict: ${dto.scheduledDate} is a national/bank holiday in ${assignment.projectBranch.branch.state}.`);
            }
            assignment.scheduledDate = scheduledDateObj;
        }
        if (dto.remarks !== undefined)
            assignment.remarks = dto.remarks;
        assignment.updatedBy = userId;
        const saved = await this.assignmentRepository.save(assignment);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSIGNMENT_UPDATED',
            entityType: 'ASSIGNMENT',
            entityId: saved.id,
            userId,
            remarks: `Updated details for assignment ${saved.assignmentNumber}.`,
        });
        return saved;
    }
    async transition(id, targetStatus, userId, remarks, reason, fee, scheduledDate) {
        const assignment = await this.findOne(id);
        const prevStatus = assignment.status;
        if (prevStatus === targetStatus) {
            return assignment;
        }
        await this.workflowEngine.executeTransition('assignment', assignment.id, prevStatus, targetStatus, {
            userId,
            payload: {
                assignment,
                fee,
                scheduledDate,
                state: assignment.projectBranch.branch.state,
                reason,
                remarks,
            },
        });
        assignment.status = targetStatus;
        if (remarks)
            assignment.remarks = remarks;
        assignment.updatedBy = userId;
        assignment.projectBranch.updatedBy = userId;
        return this.dataSource.transaction(async (manager) => {
            await manager.save(assignment.projectBranch);
            const saved = await manager.save(assignment);
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.OPERATIONAL,
                eventType: `ASSIGNMENT_${targetStatus}`,
                entityType: 'ASSIGNMENT',
                entityId: saved.id,
                previousState: prevStatus,
                newState: targetStatus,
                userId,
                remarks: remarks ?? `Transitioned assignment to ${targetStatus}`,
            });
            return saved;
        });
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
    __param(5, (0, typeorm_3.InjectDataSource)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        holiday_service_1.HolidayService,
        audit_service_1.AuditService,
        workflow_engine_1.WorkflowEngine,
        typeorm_2.DataSource])
], AssignmentService);
//# sourceMappingURL=assignment.service.js.map