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
const assignment_comment_entity_1 = require("./assignment-comment.entity");
const notification_service_1 = require("../notifications/notification.service");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const workflow_engine_1 = require("../platform/workflow/workflow.engine");
const assayer_service_1 = require("../assayer/assayer.service");
const project_service_1 = require("../project/project.service");
const project_query_service_1 = require("../project/project-query.service");
const assignment_state_machine_1 = require("./assignment.state-machine");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const shared_1 = require("@fapoms/shared");
let AssignmentService = class AssignmentService {
    assignmentRepository;
    projectQueryService;
    projectService;
    assayerService;
    notificationService;
    holidayService;
    auditService;
    workflowEngine;
    eventPublisher;
    dataSource;
    constructor(assignmentRepository, projectQueryService, projectService, assayerService, notificationService, holidayService, auditService, workflowEngine, eventPublisher, dataSource) {
        this.assignmentRepository = assignmentRepository;
        this.projectQueryService = projectQueryService;
        this.projectService = projectService;
        this.assayerService = assayerService;
        this.notificationService = notificationService;
        this.holidayService = holidayService;
        this.auditService = auditService;
        this.workflowEngine = workflowEngine;
        this.eventPublisher = eventPublisher;
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
        const projectBranch = await this.projectQueryService.findProjectBranchById(dto.projectBranchId);
        if (!projectBranch) {
            throw new common_1.NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
        }
        const assayer = await this.assayerService.findOne(dto.assayerId);
        if (!assayer) {
            throw new common_1.NotFoundException(`Assayer ${dto.assayerId} not found.`);
        }
        if (projectBranch.project && projectBranch.project.requiredSkills && projectBranch.project.requiredSkills.length > 0) {
            const assayerSkills = (assayer.skills || []).map(s => s.trim().toLowerCase());
            const missingSkills = projectBranch.project.requiredSkills.filter((skill) => !assayerSkills.includes(skill.trim().toLowerCase()));
            if (missingSkills.length > 0) {
                throw new common_1.BadRequestException(`Assayer Qualification Conflict: Assayer lacks required skills: ${missingSkills.join(', ')}`);
            }
        }
        if (projectBranch.project && projectBranch.project.requiredCertifications && projectBranch.project.requiredCertifications.length > 0) {
            const assayerCerts = (assayer.certifications || []).map((c) => c.name.trim().toLowerCase());
            const missingCerts = projectBranch.project.requiredCertifications.filter((cert) => !assayerCerts.includes(cert.trim().toLowerCase()));
            if (missingCerts.length > 0) {
                throw new common_1.BadRequestException(`Assayer Qualification Conflict: Assayer lacks required certifications: ${missingCerts.join(', ')}`);
            }
        }
        const activeAssignment = await this.assignmentRepository.findOne({
            where: {
                projectBranchId: projectBranch.id,
                status: (0, typeorm_2.In)([
                    shared_1.AssignmentStatus.CREATED,
                    shared_1.AssignmentStatus.CANDIDATE_SELECTED,
                    shared_1.AssignmentStatus.CONTACT_INITIATED,
                    shared_1.AssignmentStatus.NEGOTIATION,
                    shared_1.AssignmentStatus.ACCEPTED,
                    shared_1.AssignmentStatus.SCHEDULED,
                    shared_1.AssignmentStatus.AUDIT_COMPLETED,
                    shared_1.AssignmentStatus.CLOSED,
                ]),
                isActive: true,
            },
        });
        if (activeAssignment) {
            throw new common_1.ConflictException(`Branch Busy: An active assignment (${activeAssignment.assignmentNumber}) already exists for this branch.`);
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
        let maxResponseTimeHours = 24;
        if (projectBranch.project?.client?.configuration?.maxResponseTimeHours) {
            maxResponseTimeHours = Number(projectBranch.project.client.configuration.maxResponseTimeHours);
        }
        const slaDueDate = new Date();
        slaDueDate.setHours(slaDueDate.getHours() + maxResponseTimeHours);
        const assignment = this.assignmentRepository.create({
            assignmentNumber,
            projectBranchId: projectBranch.id,
            projectId: projectBranch.projectId,
            assayerId: dto.assayerId,
            status: shared_1.AssignmentStatus.CREATED,
            priority: projectBranch.priority,
            proposedFee: dto.proposedFee,
            agreedFee: null,
            scheduledDate: scheduledDateObj,
            slaDueDate,
            slaStatus: 'COMPLIANT',
            remarks: dto.remarks ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        return this.dataSource.transaction(async (manager) => {
            const savedAssignment = await manager.save(assignment);
            await this.projectService.initiateBranchPlanning(projectBranch.id, userId, manager);
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
    async executeAssignmentTransition(id, targetStatus, userId, remarks, reason, fee, scheduledDate, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const assignment = await this.findOne(id);
        const prevStatus = assignment.status;
        if (prevStatus === targetStatus) {
            return { saved: assignment, event: null };
        }
        let event;
        if (targetStatus === shared_1.AssignmentStatus.CANDIDATE_SELECTED) {
            event = assignment_state_machine_1.AssignmentStateMachine.selectCandidate(assignment, userId);
        }
        else if (targetStatus === shared_1.AssignmentStatus.CONTACT_INITIATED) {
            event = assignment_state_machine_1.AssignmentStateMachine.initiateContact(assignment, userId);
        }
        else if (targetStatus === shared_1.AssignmentStatus.NEGOTIATION) {
            if (fee === undefined)
                throw new common_1.BadRequestException('Fee is required for negotiation.');
            event = assignment_state_machine_1.AssignmentStateMachine.negotiate(assignment, fee, userId);
        }
        else if (targetStatus === shared_1.AssignmentStatus.ACCEPTED) {
            event = assignment_state_machine_1.AssignmentStateMachine.acceptOffer(assignment, userId, fee);
        }
        else if (targetStatus === shared_1.AssignmentStatus.REJECTED) {
            event = assignment_state_machine_1.AssignmentStateMachine.rejectOffer(assignment, userId, reason);
        }
        else if (targetStatus === shared_1.AssignmentStatus.CANCELLED) {
            event = assignment_state_machine_1.AssignmentStateMachine.cancel(assignment, userId, reason);
        }
        else if (targetStatus === shared_1.AssignmentStatus.SCHEDULED) {
            if (!scheduledDate)
                throw new common_1.BadRequestException('Scheduled date is required.');
            event = assignment_state_machine_1.AssignmentStateMachine.scheduleAudit(assignment, scheduledDate, userId);
        }
        else if (targetStatus === shared_1.AssignmentStatus.AUDIT_COMPLETED) {
            event = assignment_state_machine_1.AssignmentStateMachine.completeAudit(assignment, userId);
        }
        else if (targetStatus === shared_1.AssignmentStatus.CLOSED) {
            event = assignment_state_machine_1.AssignmentStateMachine.close(assignment, userId);
        }
        else {
            throw new common_1.BadRequestException(`Invalid assignment status: ${targetStatus}`);
        }
        return this.workflowEngine.executeCommand('assignment', assignment.id, `${targetStatus}_Command`, prevStatus, targetStatus, userId, role, [], async () => {
            if (remarks)
                assignment.remarks = remarks;
            assignment.updatedBy = userId;
            assignment.projectBranch.updatedBy = userId;
            const saved = await this.dataSource.transaction(async (manager) => {
                const targetPBStatus = assignment.projectBranch.status;
                if (targetPBStatus === shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED) {
                    await this.projectService.confirmBranchAssignment(assignment.projectBranch.id, userId, manager);
                }
                else if (targetPBStatus === shared_1.ProjectBranchStatus.SCHEDULED) {
                    await this.projectService.scheduleBranchAudit(assignment.projectBranch.id, userId, manager);
                }
                else if (targetPBStatus === shared_1.ProjectBranchStatus.AUDIT_COMPLETED) {
                    await this.projectService.completeBranchAudit(assignment.projectBranch.id, userId, manager);
                }
                else if (targetPBStatus === shared_1.ProjectBranchStatus.CLOSED) {
                    await this.projectService.closeBranchProject(assignment.projectBranch.id, userId, manager);
                }
                else if (targetPBStatus === shared_1.ProjectBranchStatus.CANDIDATE_SEARCH) {
                    await this.projectService.initiateBranchPlanning(assignment.projectBranch.id, userId, manager);
                }
                const savedAssign = await manager.save(assignment);
                await this.auditService.recordEvent({
                    category: shared_1.EventCategory.OPERATIONAL,
                    eventType: `ASSIGNMENT_${targetStatus}`,
                    entityType: 'ASSIGNMENT',
                    entityId: savedAssign.id,
                    previousState: prevStatus,
                    newState: targetStatus,
                    userId,
                    remarks: remarks ?? `Transitioned assignment to ${targetStatus}`,
                });
                try {
                    if (targetStatus === shared_1.AssignmentStatus.ACCEPTED) {
                        await this.notificationService.create({
                            userId: savedAssign.createdBy,
                            title: `Assignment Accepted`,
                            message: `Assignment offer ${savedAssign.assignmentNumber} has been accepted by the assayer.`,
                        }, userId);
                    }
                    else if (targetStatus === shared_1.AssignmentStatus.REJECTED) {
                        await this.notificationService.create({
                            userId: savedAssign.createdBy,
                            title: `Assignment Rejected`,
                            message: `Assignment offer ${savedAssign.assignmentNumber} was rejected. Reason: ${reason ?? remarks ?? 'None'}.`,
                        }, userId);
                    }
                }
                catch (err) {
                    console.error('Failed to dispatch transition notification', err);
                }
                try {
                    if (targetStatus === shared_1.AssignmentStatus.AUDIT_COMPLETED ||
                        targetStatus === shared_1.AssignmentStatus.CLOSED ||
                        targetStatus === shared_1.AssignmentStatus.CANCELLED) {
                        await this.assayerService.updateAssayerStats(savedAssign.assayerId);
                    }
                }
                catch (err) {
                    console.error('Failed to update assayer stats', err);
                }
                return savedAssign;
            });
            return { saved, event };
        });
    }
    async transition(id, targetStatus, userId, remarks, reason, fee, scheduledDate) {
        if (targetStatus === shared_1.AssignmentStatus.CANDIDATE_SELECTED) {
            return this.selectCandidate(id, userId, remarks);
        }
        else if (targetStatus === shared_1.AssignmentStatus.CONTACT_INITIATED) {
            return this.initiateContact(id, userId, remarks);
        }
        else if (targetStatus === shared_1.AssignmentStatus.NEGOTIATION) {
            if (fee === undefined)
                throw new common_1.BadRequestException('Fee is required for negotiation.');
            return this.negotiate(id, userId, fee, remarks);
        }
        else if (targetStatus === shared_1.AssignmentStatus.ACCEPTED) {
            return this.acceptOffer(id, userId, fee, remarks);
        }
        else if (targetStatus === shared_1.AssignmentStatus.REJECTED) {
            return this.rejectOffer(id, userId, reason, remarks);
        }
        else if (targetStatus === shared_1.AssignmentStatus.CANCELLED) {
            return this.cancelAssignment(id, userId, reason, remarks);
        }
        else if (targetStatus === shared_1.AssignmentStatus.SCHEDULED) {
            if (!scheduledDate)
                throw new common_1.BadRequestException('Scheduled date is required.');
            return this.scheduleAudit(id, userId, scheduledDate, remarks);
        }
        else if (targetStatus === shared_1.AssignmentStatus.AUDIT_COMPLETED) {
            return this.completeAudit(id, userId, remarks);
        }
        else if (targetStatus === shared_1.AssignmentStatus.CLOSED) {
            return this.closeAssignment(id, userId, remarks);
        }
        else {
            throw new common_1.BadRequestException(`Invalid assignment status transition to ${targetStatus}`);
        }
    }
    async selectCandidate(id, userId, remarks) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.CANDIDATE_SELECTED, userId, remarks);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async initiateContact(id, userId, remarks) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.CONTACT_INITIATED, userId, remarks);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async negotiate(id, userId, fee, remarks) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.NEGOTIATION, userId, remarks, undefined, fee);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async acceptOffer(id, userId, fee, remarks) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.ACCEPTED, userId, remarks, undefined, fee);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async rejectOffer(id, userId, reason, remarks) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.REJECTED, userId, remarks, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async scheduleAudit(id, userId, scheduledDate, remarks) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.SCHEDULED, userId, remarks, undefined, undefined, scheduledDate);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async completeAudit(id, userId, remarks) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.AUDIT_COMPLETED, userId, remarks);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async closeAssignment(id, userId, remarks) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.CLOSED, userId, remarks);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async cancelAssignment(id, userId, reason, remarks) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.CANCELLED, userId, remarks, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async findAll(page = 1, limit = 50, status) {
        const where = { isActive: true };
        if (status)
            where.status = status;
        const [assignments, total] = await this.assignmentRepository.findAndCount({
            where,
            relations: ['projectBranch', 'projectBranch.branch', 'assayer', 'project'],
            order: { createdAt: 'DESC' },
            take: limit,
            skip: (page - 1) * limit,
        });
        return { assignments, total };
    }
    async addComment(assignmentId, comment, userId, userName) {
        const assignment = await this.findOne(assignmentId);
        const commentRecord = this.dataSource.getRepository(assignment_comment_entity_1.AssignmentCommentEntity).create({
            assignmentId: assignment.id,
            userId,
            userName,
            comment,
            createdBy: userId,
            updatedBy: userId,
        });
        return this.dataSource.getRepository(assignment_comment_entity_1.AssignmentCommentEntity).save(commentRecord);
    }
    async getTimeline(assignmentId) {
        const assignment = await this.findOne(assignmentId);
        const { events } = await this.auditService.getEntityHistory('ASSIGNMENT', assignment.id, 100);
        const comments = await this.dataSource.getRepository(assignment_comment_entity_1.AssignmentCommentEntity).find({
            where: { assignmentId: assignment.id, isActive: true },
            order: { createdAt: 'ASC' },
        });
        const timelineEvents = [];
        for (const e of events) {
            timelineEvents.push({
                id: e.id,
                type: 'SYSTEM_EVENT',
                title: e.eventType,
                description: e.remarks,
                timestamp: e.occurredAt,
                user: e.userDisplayName || e.userId,
            });
        }
        for (const c of comments) {
            timelineEvents.push({
                id: c.id,
                type: 'COMMENT',
                title: `Comment by ${c.userName}`,
                description: c.comment,
                timestamp: c.createdAt,
                user: c.userName,
            });
        }
        return timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
    async checkSlaBreaches() {
        const now = new Date();
        const overdueAssignments = await this.assignmentRepository.find({
            where: {
                slaStatus: 'COMPLIANT',
                status: (0, typeorm_2.In)([
                    shared_1.AssignmentStatus.CREATED,
                    shared_1.AssignmentStatus.CANDIDATE_SELECTED,
                    shared_1.AssignmentStatus.CONTACT_INITIATED,
                    shared_1.AssignmentStatus.NEGOTIATION,
                    shared_1.AssignmentStatus.ACCEPTED,
                    shared_1.AssignmentStatus.SCHEDULED,
                ]),
                isActive: true,
            },
        });
        let breachedCount = 0;
        for (const assignment of overdueAssignments) {
            if (assignment.slaDueDate && assignment.slaDueDate < now) {
                assignment.slaStatus = 'BREACHED';
                await this.assignmentRepository.save(assignment);
                await this.auditService.recordEvent({
                    category: shared_1.EventCategory.SYSTEM,
                    eventType: 'ASSIGNMENT_SLA_BREACHED',
                    entityType: 'ASSIGNMENT',
                    entityId: assignment.id,
                    remarks: `SLA breach detected: Assignment ${assignment.assignmentNumber} exceeded response time deadline of ${assignment.slaDueDate}.`,
                });
                breachedCount++;
            }
        }
        return breachedCount;
    }
    async getDashboardSummary() {
        const counts = await this.assignmentRepository
            .createQueryBuilder('assignment')
            .select('assignment.status', 'status')
            .addSelect('COUNT(assignment.id)', 'count')
            .where('assignment.isActive = :isActive', { isActive: true })
            .groupBy('assignment.status')
            .getRawMany();
        const slaCounts = await this.assignmentRepository
            .createQueryBuilder('assignment')
            .select('assignment.slaStatus', 'slaStatus')
            .addSelect('COUNT(assignment.id)', 'count')
            .where('assignment.isActive = :isActive', { isActive: true })
            .groupBy('assignment.slaStatus')
            .getRawMany();
        const summary = {};
        for (const c of counts) {
            summary[c.status] = Number(c.count);
        }
        const slaSummary = {};
        for (const s of slaCounts) {
            slaSummary[s.slaStatus] = Number(s.count);
        }
        return {
            statusCounts: summary,
            slaCounts: slaSummary,
        };
    }
};
exports.AssignmentService = AssignmentService;
exports.AssignmentService = AssignmentService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __param(9, (0, typeorm_3.InjectDataSource)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        project_query_service_1.ProjectQueryService,
        project_service_1.ProjectService,
        assayer_service_1.AssayerService,
        notification_service_1.NotificationService,
        holiday_service_1.HolidayService,
        audit_service_1.AuditService,
        workflow_engine_1.WorkflowEngine,
        domain_event_publisher_1.DomainEventPublisher,
        typeorm_2.DataSource])
], AssignmentService);
//# sourceMappingURL=assignment.service.js.map