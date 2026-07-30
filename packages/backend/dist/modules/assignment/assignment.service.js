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
const assessment_entity_1 = require("../project/assessment.entity");
const customer_master_version_entity_1 = require("../customer-master/customer-master-version.entity");
const customer_record_entity_1 = require("../customer-master/customer-record.entity");
const user_entity_1 = require("../user/user.entity");
const notification_service_1 = require("../notifications/notification.service");
const push_notification_service_1 = require("../notifications/push-notification.service");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const assayer_service_1 = require("../assayer/assayer.service");
const project_service_1 = require("../project/project.service");
const project_query_service_1 = require("../project/project-query.service");
const assignment_state_machine_1 = require("./assignment.state-machine");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const constraint_evaluator_1 = require("../planning/constraint.evaluator");
const shared_1 = require("@fapoms/shared");
const ASSESSMENT_STATUS_MAP = {
    [shared_1.ProjectBranchStatus.IMPORTED]: shared_1.AssessmentStatus.PENDING_PLANNING,
    [shared_1.ProjectBranchStatus.PLANNING]: shared_1.AssessmentStatus.PENDING_PLANNING,
    [shared_1.ProjectBranchStatus.CANDIDATE_SEARCH]: shared_1.AssessmentStatus.ASSESSOR_RECOMMENDED,
    [shared_1.ProjectBranchStatus.CONTACT_INITIATED]: shared_1.AssessmentStatus.IN_NEGOTIATION,
    [shared_1.ProjectBranchStatus.NEGOTIATION]: shared_1.AssessmentStatus.IN_NEGOTIATION,
    [shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED]: shared_1.AssessmentStatus.ASSIGNED_AND_SCHEDULED,
    [shared_1.ProjectBranchStatus.SCHEDULED]: shared_1.AssessmentStatus.ASSIGNED_AND_SCHEDULED,
    [shared_1.ProjectBranchStatus.AUDIT_COMPLETED]: shared_1.AssessmentStatus.AUDITED_PDF_RECEIVED,
    [shared_1.ProjectBranchStatus.VALIDATION_COMPLETED]: shared_1.AssessmentStatus.SENT_TO_DATA_ENTRY,
    [shared_1.ProjectBranchStatus.CLOSED]: shared_1.AssessmentStatus.COMPLETED,
    [shared_1.ProjectBranchStatus.UNABLE_TO_COVER]: shared_1.AssessmentStatus.UNASSIGNED,
    [shared_1.ProjectBranchStatus.ON_HOLD]: shared_1.AssessmentStatus.PENDING_PLANNING,
    [shared_1.ProjectBranchStatus.CANCELLED]: shared_1.AssessmentStatus.UNASSIGNED,
};
let AssignmentService = class AssignmentService {
    assignmentRepository;
    assessmentRepository;
    projectQueryService;
    projectService;
    assayerService;
    notificationService;
    pushNotificationService;
    holidayService;
    auditService;
    eventPublisher;
    constraintEvaluator;
    dataSource;
    constructor(assignmentRepository, assessmentRepository, projectQueryService, projectService, assayerService, notificationService, pushNotificationService, holidayService, auditService, eventPublisher, constraintEvaluator, dataSource) {
        this.assignmentRepository = assignmentRepository;
        this.assessmentRepository = assessmentRepository;
        this.projectQueryService = projectQueryService;
        this.projectService = projectService;
        this.assayerService = assayerService;
        this.notificationService = notificationService;
        this.pushNotificationService = pushNotificationService;
        this.holidayService = holidayService;
        this.auditService = auditService;
        this.eventPublisher = eventPublisher;
        this.constraintEvaluator = constraintEvaluator;
        this.dataSource = dataSource;
    }
    async syncAssessmentStatus(assignment) {
        if (assignment.assessment && assignment.projectBranch) {
            const mapped = ASSESSMENT_STATUS_MAP[assignment.projectBranch.status];
            if (mapped && assignment.assessment.status !== mapped) {
                assignment.assessment.status = mapped;
                assignment.assessment.auditDate = assignment.projectBranch.scheduledDate;
                assignment.assessment.assignedAssessorId = assignment.assayerId;
                assignment.assessment.agreedFee = assignment.agreedFee;
                await this.assessmentRepository.save(assignment.assessment);
            }
        }
    }
    async create(dto, userId) {
        const projectBranch = await this.projectQueryService.findProjectBranchById(dto.projectBranchId);
        if (!projectBranch) {
            throw new common_1.NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
        }
        const assessment = await this.assessmentRepository.findOne({
            where: { projectId: projectBranch.projectId, branchId: projectBranch.branchId, isActive: true },
        });
        const assayer = await this.assayerService.findOne(dto.assayerId);
        if (!assayer) {
            throw new common_1.NotFoundException(`Assayer ${dto.assayerId} not found.`);
        }
        if (projectBranch.project) {
            const skillsCheck = this.constraintEvaluator.checkSkillsAndCertifications(assayer, projectBranch.project);
            if (!skillsCheck.passed) {
                throw new common_1.BadRequestException(skillsCheck.reason);
            }
        }
        const existingAssignment = await this.assignmentRepository.findOne({
            where: { projectBranchId: projectBranch.id },
            order: { createdAt: 'DESC' },
        });
        if (existingAssignment &&
            [shared_1.AssignmentStatus.ACCEPTED].includes(existingAssignment.status)) {
            throw new common_1.ConflictException(`Branch Busy: An active assignment (${existingAssignment.assignmentNumber}) already exists for this branch.`);
        }
        const scheduledDateObj = dto.scheduledDate ? new Date(dto.scheduledDate) : null;
        if (scheduledDateObj) {
            const holidayCheck = await this.constraintEvaluator.checkHoliday(projectBranch.branch.state, scheduledDateObj);
            if (!holidayCheck.passed) {
                throw new common_1.BadRequestException(holidayCheck.reason);
            }
            const doubleBookingCheck = await this.constraintEvaluator.checkDoubleBooking(dto.assayerId, scheduledDateObj);
            if (!doubleBookingCheck.passed) {
                throw new common_1.ConflictException(doubleBookingCheck.reason);
            }
        }
        let maxResponseTimeHours = 24;
        if (projectBranch.project?.client?.configuration?.maxResponseTimeHours) {
            maxResponseTimeHours = Number(projectBranch.project.client.configuration.maxResponseTimeHours);
        }
        const slaDueDate = new Date();
        slaDueDate.setHours(slaDueDate.getHours() + maxResponseTimeHours);
        let assignment;
        const isReassignment = Boolean(existingAssignment);
        if (existingAssignment) {
            assignment = existingAssignment;
            assignment.assayerId = dto.assayerId;
            assignment.status = shared_1.AssignmentStatus.PENDING;
            assignment.proposedFee = dto.proposedFee;
            assignment.agreedFee = null;
            assignment.scheduledDate = scheduledDateObj;
            assignment.cancelReason = null;
            assignment.rejectReason = null;
            assignment.completionDate = null;
            assignment.syncToken = `SYNC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
            assignment.slaDueDate = slaDueDate;
            assignment.slaStatus = 'COMPLIANT';
            assignment.updatedBy = userId;
            assignment.isActive = true;
        }
        else {
            const randomSuffix = Math.floor(1000 + Math.random() * 9000);
            const assignmentNumber = `ASN-${new Date().getFullYear()}-${randomSuffix}`;
            assignment = this.assignmentRepository.create({
                assignmentNumber,
                projectBranchId: projectBranch.id,
                assessmentId: assessment?.id || null,
                projectId: projectBranch.projectId,
                assayerId: dto.assayerId,
                status: shared_1.AssignmentStatus.PENDING,
                priority: projectBranch.priority,
                proposedFee: dto.proposedFee,
                agreedFee: null,
                scheduledDate: scheduledDateObj,
                syncToken: `SYNC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
                slaDueDate,
                slaStatus: 'COMPLIANT',
                remarks: dto.remarks ?? null,
                createdBy: userId,
                updatedBy: userId,
            });
        }
        return this.dataSource.transaction(async (manager) => {
            const savedAssignment = await manager.save(assignment);
            await this.projectService.initiateBranchPlanning(projectBranch.id, userId, manager);
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.OPERATIONAL,
                eventType: isReassignment ? 'ASSIGNMENT_REASSIGNED' : 'ASSIGNMENT_CREATED',
                entityType: 'ASSIGNMENT',
                entityId: savedAssignment.id,
                userId,
                remarks: isReassignment
                    ? `Reassigned branch ${projectBranch.branch.name} to assayer ${assayer.displayName}. Proposed fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`
                    : `Created assignment offer for branch ${projectBranch.branch.name}. Fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`,
            });
            return savedAssignment;
        }).then(async (saved) => {
            try {
                if (assayer.email) {
                    const userObj = await this.dataSource.getRepository(user_entity_1.UserEntity).findOne({ where: { email: assayer.email } }).catch(() => null);
                    if (userObj) {
                        await this.notificationService.create({
                            userId: userObj.id,
                            title: 'New Assignment',
                            message: `You have been assigned to ${projectBranch.branch.name} on ${dto.scheduledDate}. Proposed fee: ₹${dto.proposedFee}.`,
                            link: `/assignments/${saved.id}`,
                        }, userId);
                    }
                }
                await this.pushNotificationService.sendToUser(assayer.id, 'New Assignment', `You have been assigned to ${projectBranch.branch.name} on ${dto.scheduledDate}. Fee: ₹${dto.proposedFee}.`, { assignmentId: saved.id, type: 'assignment_created' });
            }
            catch (err) {
                console.error('Failed to send assignment creation notification:', err);
            }
            try {
                this.eventPublisher.publish('assignment:created', {
                    eventType: 'assignment:created',
                    assignmentId: saved.id,
                    assignmentNumber: saved.assignmentNumber,
                    assayerId: saved.assayerId,
                    organizationId: saved.projectBranch?.project?.organizationId,
                    branchName: projectBranch.branch?.name,
                    status: saved.status,
                });
            }
            catch (err) {
                console.error('Failed to publish assignment:created event:', err);
            }
            return saved;
        });
    }
    async findOne(id) {
        const assignment = await this.assignmentRepository.findOne({
            where: { id },
            relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
        });
        if (!assignment) {
            throw new common_1.NotFoundException(`Assignment ${id} not found.`);
        }
        return assignment;
    }
    async update(id, dto, userId) {
        const assignment = await this.findOne(id);
        if (assignment.status !== shared_1.AssignmentStatus.PENDING) {
            throw new common_1.BadRequestException(`Locked: Cannot modify assignment details in status ${assignment.status}.`);
        }
        if (dto.proposedFee !== undefined)
            assignment.proposedFee = dto.proposedFee;
        if (dto.agreedFee !== undefined)
            assignment.agreedFee = dto.agreedFee;
        if (dto.scheduledDate !== undefined) {
            const scheduledDateObj = new Date(dto.scheduledDate);
            const branchState = assignment.projectBranch?.branch?.state || assignment.assessment?.branch?.state || '';
            const isHolidayConflict = await this.holidayService.isHoliday(scheduledDateObj, branchState);
            if (isHolidayConflict) {
                throw new common_1.BadRequestException(`Holiday Conflict: ${dto.scheduledDate} is a national/bank holiday in ${branchState}.`);
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
        try {
            if (dto.proposedFee !== undefined || dto.agreedFee !== undefined) {
                this.eventPublisher.publish('assignment:fee-updated', {
                    eventType: 'assignment:fee-updated',
                    assignmentId: saved.id,
                    assignmentNumber: saved.assignmentNumber,
                    proposedFee: saved.proposedFee,
                    agreedFee: saved.agreedFee,
                    assayerId: saved.assayerId,
                    organizationId: saved.projectBranch?.project?.organizationId,
                    userId,
                    timestamp: new Date(),
                });
            }
        }
        catch (err) {
            console.error('Failed to publish assignment:fee-updated event:', err);
        }
        return saved;
    }
    async executeAssignmentTransition(id, targetStatus, userId, reason, fee) {
        const assignment = await this.findOne(id);
        const prevStatus = assignment.status;
        if (prevStatus === targetStatus) {
            return { saved: assignment, event: null };
        }
        let event;
        if (targetStatus === shared_1.AssignmentStatus.ACCEPTED) {
            event = assignment_state_machine_1.AssignmentStateMachine.acceptOffer(assignment, userId);
            if (fee !== undefined)
                assignment.agreedFee = fee;
            if (assignment.projectBranch) {
                assignment.projectBranch.status = shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED;
            }
        }
        else if (targetStatus === shared_1.AssignmentStatus.REJECTED) {
            event = assignment_state_machine_1.AssignmentStateMachine.rejectOffer(assignment, userId, reason);
            if (assignment.projectBranch) {
                assignment.projectBranch.status = shared_1.ProjectBranchStatus.CANDIDATE_SEARCH;
            }
        }
        else if (targetStatus === shared_1.AssignmentStatus.CANCELLED) {
            event = assignment_state_machine_1.AssignmentStateMachine.cancel(assignment, userId, reason);
            if (assignment.projectBranch) {
                assignment.projectBranch.status = shared_1.ProjectBranchStatus.CANDIDATE_SEARCH;
            }
        }
        else {
            throw new common_1.BadRequestException(`Invalid assignment status transition to ${targetStatus}`);
        }
        assignment.updatedBy = userId;
        await this.syncAssessmentStatus(assignment);
        const saved = await this.dataSource.transaction(async (manager) => {
            if (assignment.projectBranch) {
                await manager.save(assignment.projectBranch);
            }
            if (assignment.assessment) {
                await manager.save(assignment.assessment);
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
                remarks: reason ?? `Transitioned assignment to ${targetStatus}`,
            });
            return savedAssign;
        });
        try {
            if (targetStatus === shared_1.AssignmentStatus.ACCEPTED && saved.createdBy) {
                const targetUser = await this.dataSource.getRepository(user_entity_1.UserEntity).findOne({ where: { id: saved.createdBy } }).catch(() => null);
                if (targetUser) {
                    await this.notificationService.create({
                        userId: saved.createdBy,
                        title: 'Assignment Accepted',
                        message: `Assignment offer ${saved.assignmentNumber} has been accepted by the assayer.`,
                    }, userId);
                }
            }
            else if (targetStatus === shared_1.AssignmentStatus.REJECTED && saved.createdBy) {
                const targetUser = await this.dataSource.getRepository(user_entity_1.UserEntity).findOne({ where: { id: saved.createdBy } }).catch(() => null);
                if (targetUser) {
                    await this.notificationService.create({
                        userId: saved.createdBy,
                        title: 'Assignment Rejected',
                        message: `Assignment offer ${saved.assignmentNumber} was rejected. Reason: ${reason ?? 'None'}.`,
                    }, userId);
                }
            }
        }
        catch (err) {
            console.error('Failed to dispatch transition notification', err);
        }
        if (targetStatus === shared_1.AssignmentStatus.CANCELLED || targetStatus === shared_1.AssignmentStatus.REJECTED) {
            try {
                await this.assayerService.updateAssayerStats(saved.assayerId);
            }
            catch (err) {
                console.error('Failed to update assayer stats', err);
            }
        }
        return { saved, event };
    }
    async acceptOffer(id, userId, fee, reason) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.ACCEPTED, userId, reason, fee);
        if (event)
            this.publishAssignmentEvent('assignment:status-changed', saved, event);
        return saved;
    }
    async rejectOffer(id, userId, reason) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.REJECTED, userId, reason);
        if (event)
            this.publishAssignmentEvent('assignment:status-changed', saved, event);
        return saved;
    }
    async cancelAssignment(id, userId, reason) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.CANCELLED, userId, reason);
        if (event)
            this.publishAssignmentEvent('assignment:status-changed', saved, event);
        return saved;
    }
    async scheduleAudit(id, userId, scheduledDate, remarks) {
        const assignment = await this.findOne(id);
        if (assignment.projectBranch) {
            assignment.projectBranch.status = shared_1.ProjectBranchStatus.SCHEDULED;
            assignment.projectBranch.scheduledDate = new Date(scheduledDate);
            assignment.projectBranch.updatedBy = userId;
        }
        if (assignment.assessment) {
            assignment.assessment.auditDate = new Date(scheduledDate);
            assignment.assessment.status = shared_1.AssessmentStatus.ASSIGNED_AND_SCHEDULED;
        }
        assignment.scheduledDate = new Date(scheduledDate);
        assignment.updatedBy = userId;
        const saved = await this.dataSource.transaction(async (manager) => {
            if (assignment.projectBranch) {
                await manager.save(assignment.projectBranch);
            }
            if (assignment.assessment) {
                await manager.save(assignment.assessment);
            }
            return manager.save(assignment);
        });
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSIGNMENT_SCHEDULED',
            entityType: 'ASSIGNMENT',
            entityId: saved.id,
            userId,
            remarks: remarks ?? `Scheduled audit for ${scheduledDate}.`,
        });
        this.publishAssignmentEvent('assignment:scheduled', saved, {
            previousState: saved.status,
            newState: saved.status,
            userId,
        });
        return saved;
    }
    publishAssignmentEvent(eventType, assignment, event) {
        this.eventPublisher.publish(eventType, {
            eventType,
            assignmentId: assignment.id,
            assignmentNumber: assignment.assignmentNumber,
            previousState: event.previousState || assignment.status,
            newState: assignment.status,
            assayerId: assignment.assayerId,
            organizationId: assignment.projectBranch?.project?.organizationId,
            userId: event.userId,
            timestamp: event.timestamp || new Date(),
            metadata: event.metadata,
        });
    }
    async findAll(page = 1, limit = 50, status, projectBranchStatus, assessmentStatus) {
        const where = {};
        if (status) {
            const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
            if (statuses.length === 1) {
                where.status = statuses[0];
            }
            else if (statuses.length > 1) {
                where.status = (0, typeorm_2.In)(statuses);
            }
        }
        if (projectBranchStatus) {
            where.projectBranch = { status: projectBranchStatus };
        }
        if (assessmentStatus) {
            where.assessment = { status: assessmentStatus };
        }
        const [assignments, total] = await this.assignmentRepository.findAndCount({
            where,
            relations: ['projectBranch', 'projectBranch.branch', 'assessment', 'assessment.branch', 'assayer', 'project'],
            order: { createdAt: 'DESC' },
            take: limit,
            skip: (page - 1) * limit,
        });
        return { assignments, total };
    }
    async findByAssayer(assayerId) {
        const assignments = await this.assignmentRepository.find({
            where: {
                assayerId,
                status: (0, typeorm_2.In)([shared_1.AssignmentStatus.ACCEPTED]),
            },
            relations: ['projectBranch', 'projectBranch.branch', 'assayer', 'project'],
            order: { createdAt: 'DESC' },
        });
        const projectIds = [...new Set(assignments.map((a) => a.projectBranch.projectId))];
        const versionRepo = this.dataSource.getRepository(customer_master_version_entity_1.CustomerMasterVersionEntity);
        const recordRepo = this.dataSource.getRepository(customer_record_entity_1.CustomerRecordEntity);
        const projectVersions = new Map();
        for (const projectId of projectIds) {
            const version = await versionRepo.findOne({
                where: { projectId, status: shared_1.CustomerMasterStatus.APPROVED, isActive: true },
                order: { versionNumber: 'DESC' },
            });
            projectVersions.set(projectId, version);
        }
        for (const assignment of assignments) {
            const version = projectVersions.get(assignment.projectBranch.projectId);
            if (version) {
                const branchId = assignment.projectBranch.branchId;
                const records = await recordRepo.find({
                    where: { customerMasterVersionId: version.id, branchId, isActive: true },
                });
                assignment.customerCount = records.length;
                assignment.customers = records;
            }
            else {
                assignment.customerCount = 0;
                assignment.customers = [];
            }
        }
        return assignments;
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
        const saved = await this.dataSource.getRepository(assignment_comment_entity_1.AssignmentCommentEntity).save(commentRecord);
        try {
            this.eventPublisher.publish('comment:added', {
                eventType: 'comment:added',
                assignmentId: assignment.id,
                commentId: saved.id,
                userId,
                userName,
                comment,
            });
        }
        catch (err) {
            console.error('Failed to publish comment:added event:', err);
        }
        return saved;
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
                    shared_1.AssignmentStatus.PENDING,
                    shared_1.AssignmentStatus.ACCEPTED,
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
    async recordCheckIn(id, lat, lng, syncToken, userId) {
        const assignment = await this.findOne(id);
        if (!assignment) {
            return { success: false, assignment: null, error: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found.' };
        }
        if (syncToken && assignment.syncToken && syncToken !== assignment.syncToken) {
            return {
                success: false,
                assignment,
                error: 'CONFLICT_ASSIGNMENT_MODIFIED',
                message: 'Assignment state has changed on server. Please refresh schedule.',
            };
        }
        const timeStr = new Date().toISOString();
        const checkInRemarks = `GPS Checked in at (${lat}, ${lng}) on ${timeStr}`;
        assignment.remarks = assignment.remarks ? `${assignment.remarks} | ${checkInRemarks}` : checkInRemarks;
        assignment.updatedBy = userId || assignment.assayerId || id;
        assignment.syncToken = `SYNC-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        if (assignment.projectBranch) {
            assignment.projectBranch.status = shared_1.ProjectBranchStatus.SCHEDULED;
            assignment.projectBranch.updatedBy = userId || assignment.assayerId || id;
        }
        if (assignment.assessment) {
            assignment.assessment.status = shared_1.AssessmentStatus.ASSIGNED_AND_SCHEDULED;
            assignment.assessment.auditDate = assignment.scheduledDate;
        }
        const saved = await this.dataSource.transaction(async (manager) => {
            if (assignment.projectBranch) {
                await manager.save(assignment.projectBranch);
            }
            if (assignment.assessment) {
                await manager.save(assignment.assessment);
            }
            return manager.save(assignment);
        });
        try {
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.OPERATIONAL,
                eventType: 'ASSIGNMENT_CHECKED_IN',
                entityType: 'ASSIGNMENT',
                entityId: saved.id,
                userId: userId || saved.assayerId,
                remarks: `Assayer ${saved.assayer?.displayName || ''} GPS checked in at branch ${saved.projectBranch?.branch?.name || ''} (${lat}, ${lng}).`,
            });
        }
        catch (err) {
            console.error('Failed to log check-in audit event:', err);
        }
        if (saved.createdBy) {
            try {
                const targetUser = await this.dataSource.getRepository(user_entity_1.UserEntity).findOne({ where: { id: saved.createdBy } }).catch(() => null);
                if (targetUser) {
                    await this.notificationService.create({
                        userId: saved.createdBy,
                        title: 'Assayer GPS Check-In',
                        message: `Assayer ${saved.assayer?.displayName || 'Field Assayer'} checked in at ${saved.projectBranch?.branch?.name || 'Branch'} (${lat}, ${lng}).`,
                        link: `/assignments/${saved.id}`,
                    }, userId || saved.assayerId);
                }
            }
            catch (err) {
                console.error('Failed to dispatch check-in notification:', err);
            }
        }
        return {
            success: true,
            assignment: saved,
            message: `Checked in at ${lat}, ${lng}`,
        };
    }
};
exports.AssignmentService = AssignmentService;
exports.AssignmentService = AssignmentService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assessment_entity_1.AssessmentEntity)),
    __param(11, (0, typeorm_3.InjectDataSource)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        project_query_service_1.ProjectQueryService,
        project_service_1.ProjectService,
        assayer_service_1.AssayerService,
        notification_service_1.NotificationService,
        push_notification_service_1.PushNotificationService,
        holiday_service_1.HolidayService,
        audit_service_1.AuditService,
        domain_event_publisher_1.DomainEventPublisher,
        constraint_evaluator_1.ConstraintEvaluator,
        typeorm_2.DataSource])
], AssignmentService);
//# sourceMappingURL=assignment.service.js.map