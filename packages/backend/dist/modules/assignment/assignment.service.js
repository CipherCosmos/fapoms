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
const notification_dispatch_service_1 = require("../notifications/notification-dispatch.service");
const push_notification_service_1 = require("../notifications/push-notification.service");
const holiday_service_1 = require("../holiday/holiday.service");
const validation_query_entity_1 = require("../validation-query/validation-query.entity");
const validation_case_entity_1 = require("../validation/validation-case.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const assayer_service_1 = require("../assayer/assayer.service");
const assayer_commercial_profile_entity_1 = require("../assayer/assayer-commercial-profile.entity");
const project_service_1 = require("../project/project.service");
const project_query_service_1 = require("../project/project-query.service");
const assignment_state_machine_1 = require("./assignment.state-machine");
const project_state_machine_1 = require("../project/project.state-machine");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const constraint_evaluator_1 = require("../planning/constraint.evaluator");
const routing_provider_1 = require("../geo/routing.provider");
const validation_service_1 = require("../validation/validation.service");
const shared_1 = require("@fapoms/shared");
const TRAVEL_FEE_PER_KM = 8;
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
    notificationDispatch;
    pushNotificationService;
    holidayService;
    auditService;
    eventPublisher;
    constraintEvaluator;
    routingService;
    validationService;
    dataSource;
    constructor(assignmentRepository, assessmentRepository, projectQueryService, projectService, assayerService, notificationService, notificationDispatch, pushNotificationService, holidayService, auditService, eventPublisher, constraintEvaluator, routingService, validationService, dataSource) {
        this.assignmentRepository = assignmentRepository;
        this.assessmentRepository = assessmentRepository;
        this.projectQueryService = projectQueryService;
        this.projectService = projectService;
        this.assayerService = assayerService;
        this.notificationService = notificationService;
        this.notificationDispatch = notificationDispatch;
        this.pushNotificationService = pushNotificationService;
        this.holidayService = holidayService;
        this.auditService = auditService;
        this.eventPublisher = eventPublisher;
        this.constraintEvaluator = constraintEvaluator;
        this.routingService = routingService;
        this.validationService = validationService;
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
        const terminalBranchStatuses = ['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'];
        if (terminalBranchStatuses.includes(projectBranch.status)) {
            throw new common_1.ConflictException(`Cannot assign: Branch "${projectBranch.branch?.name || dto.projectBranchId}" is already in ${projectBranch.status.replace(/_/g, ' ')} state. No further assignments are permitted.`);
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
            [
                shared_1.AssignmentStatus.ACCEPTED,
                shared_1.AssignmentStatus.CHECKED_IN,
                shared_1.AssignmentStatus.IN_PROGRESS,
                shared_1.AssignmentStatus.COMPLETED,
            ].includes(existingAssignment.status)) {
            throw new common_1.ConflictException(`Branch Busy: An active/completed assignment (${existingAssignment.assignmentNumber}) already exists for this branch in state ${existingAssignment.status}.`);
        }
        const targetDateStr = dto.scheduledDate || (projectBranch.scheduledDate ? (typeof projectBranch.scheduledDate === 'string' ? projectBranch.scheduledDate.slice(0, 10) : projectBranch.scheduledDate.toISOString().slice(0, 10)) : new Date().toISOString().slice(0, 10));
        const scheduledDateObj = new Date(targetDateStr);
        let resolvedProposedFee = dto.proposedFee;
        let calculatedTravelFee = 0;
        let distanceKm = 0;
        const commProfile = await this.assayerService.getActiveCommercialProfile(assayer.id, scheduledDateObj || new Date()).catch(() => null);
        const baseFee = commProfile?.baseFee ? Number(commProfile.baseFee) : 1200;
        if (projectBranch.branch?.latitude && projectBranch.branch?.longitude && assayer.latitude && assayer.longitude) {
            try {
                const route = await this.routingService.calculateRoute({ latitude: Number(projectBranch.branch.latitude), longitude: Number(projectBranch.branch.longitude) }, { latitude: Number(assayer.latitude), longitude: Number(assayer.longitude) });
                distanceKm = route.distanceKm || 0;
                const chargeableKm = Math.max(0, distanceKm - 10);
                calculatedTravelFee = Math.round(chargeableKm * TRAVEL_FEE_PER_KM);
            }
            catch (e) {
            }
        }
        if (resolvedProposedFee === undefined || resolvedProposedFee === null) {
            resolvedProposedFee = baseFee + calculatedTravelFee;
        }
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
            assignment.proposedFee = resolvedProposedFee;
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
                proposedFee: resolvedProposedFee,
                agreedFee: null,
                scheduledDate: scheduledDateObj,
                autoSchedule: dto.autoSchedule ?? true,
                syncToken: `SYNC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
                slaDueDate,
                slaStatus: 'COMPLIANT',
                remarks: dto.remarks ?? null,
                createdBy: userId,
                updatedBy: userId,
            });
        }
        return this.dataSource.transaction(async (manager) => {
            if (projectBranch && !projectBranch.scheduledDate && scheduledDateObj) {
                projectBranch.scheduledDate = scheduledDateObj;
                await manager.save(projectBranch);
            }
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
            this.notificationDispatch.emitSafe({
                type: 'ASSIGNMENT_OFFERED',
                entityType: 'ASSIGNMENT',
                entityId: saved.id,
                actorUserId: userId,
                assayerId: assayer.id,
                ownerUserId: userId,
                dedupeKey: `ASSIGNMENT_OFFERED:${saved.id}`,
                payload: {
                    assignmentId: saved.id,
                    assignmentNumber: saved.assignmentNumber,
                    branchName: projectBranch.branch?.name ?? 'the branch',
                    scheduledDate: dto.scheduledDate ?? 'a date to be confirmed',
                    proposedFee: dto.proposedFee,
                },
            });
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
        if (prevStatus === targetStatus && fee === undefined) {
            return { saved: assignment, event: null };
        }
        let event;
        let pbEvent;
        if (targetStatus === shared_1.AssignmentStatus.ACCEPTED) {
            if (prevStatus !== targetStatus) {
                event = assignment_state_machine_1.AssignmentStateMachine.acceptOffer(assignment, userId);
            }
            if (fee !== undefined && fee !== null) {
                assignment.proposedFee = fee;
                assignment.agreedFee = fee;
            }
            else if (!assignment.agreedFee && assignment.proposedFee) {
                assignment.agreedFee = assignment.proposedFee;
            }
            if (assignment.projectBranch && assignment.projectBranch.status !== shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED) {
                pbEvent = project_state_machine_1.ProjectBranchStateMachine.confirmAssignment(assignment.projectBranch, userId);
            }
            if (assignment.autoSchedule !== false && assignment.scheduledDate) {
                const scheduleRepo = this.dataSource.getRepository('schedules');
                const existing = await scheduleRepo.findOne({ where: { assignmentId: assignment.id, isActive: true } }).catch(() => null);
                if (!existing) {
                    await scheduleRepo.save({
                        assignmentId: assignment.id,
                        projectId: assignment.projectId,
                        assayerId: assignment.assayerId,
                        scheduledDate: assignment.scheduledDate,
                        status: 'CONFIRMED',
                        remarks: 'Auto-created upon offer acceptance (Direct Calendar Lock)',
                        createdBy: userId,
                        updatedBy: userId,
                    }).catch(() => { });
                }
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
        else if (targetStatus === shared_1.AssignmentStatus.COMPLETED) {
            event = { previousState: prevStatus, newState: shared_1.AssignmentStatus.COMPLETED, userId };
            assignment.status = shared_1.AssignmentStatus.COMPLETED;
            assignment.completionDate = new Date();
            if (assignment.projectBranch && assignment.projectBranch.status !== shared_1.ProjectBranchStatus.AUDIT_COMPLETED) {
                pbEvent = project_state_machine_1.ProjectBranchStateMachine.completeAudit(assignment.projectBranch, userId);
            }
            await this.dataSource.query(`INSERT INTO schedules (id, version, is_active, assignment_id, project_id, assayer_id, scheduled_date, status, completed_at, remarks, created_by, updated_by)
         VALUES (gen_random_uuid(), 1, true, $1, $2, $3, COALESCE($4, CURRENT_DATE), 'COMPLETED'::schedules_status_enum, NOW(), 'Completed audit', $5, $5)
         ON CONFLICT (assignment_id) DO UPDATE SET status = 'COMPLETED'::schedules_status_enum, completed_at = COALESCE(schedules.completed_at, NOW()), updated_by = EXCLUDED.updated_by`, [assignment.id, assignment.projectId, assignment.assayerId, assignment.scheduledDate, userId]).catch((err) => console.error('Schedule completion upsert failed:', err));
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
        if (pbEvent) {
            this.eventPublisher.publish(pbEvent.constructor.name, pbEvent);
        }
        const notifyType = targetStatus === shared_1.AssignmentStatus.ACCEPTED ? 'ASSIGNMENT_ACCEPTED'
            : targetStatus === shared_1.AssignmentStatus.REJECTED ? 'ASSIGNMENT_REJECTED'
                : null;
        if (notifyType) {
            this.notificationDispatch.emitSafe({
                type: notifyType,
                entityType: 'ASSIGNMENT',
                entityId: saved.id,
                actorUserId: userId,
                assayerId: saved.assayerId,
                ownerUserId: saved.createdBy,
                dedupeKey: `${notifyType}:${saved.id}:${targetStatus}`,
                payload: {
                    assignmentId: saved.id,
                    assignmentNumber: saved.assignmentNumber,
                    assayerName: assignment.assayer
                        ? `${assignment.assayer.firstName} ${assignment.assayer.lastName}`.trim()
                        : 'The assayer',
                    branchName: assignment.projectBranch?.branch?.name ?? saved.assignmentNumber,
                    reason: reason ?? 'No reason given',
                },
            });
        }
        if (targetStatus === shared_1.AssignmentStatus.COMPLETED) {
            try {
                if (saved.projectBranchId) {
                    await this.validationService.create({
                        projectBranchId: saved.projectBranchId,
                        assessmentId: saved.assessmentId || undefined,
                    }, userId);
                }
            }
            catch (err) {
                console.error('Failed to auto-create validation case on completion:', err);
            }
        }
        try {
            await this.assayerService.updateAssayerStats(saved.assayerId);
        }
        catch (err) {
            console.error('Failed to update assayer stats', err);
        }
        return { saved, event };
    }
    async proposeCounterFee(id, userId, counterFee, remarks) {
        const assignment = await this.findOne(id);
        const currentCount = assignment.negotiationCount || 0;
        if (currentCount >= 3) {
            assignment.status = shared_1.AssignmentStatus.REJECTED;
            assignment.rejectReason = 'Negotiation limit reached (3 counter-offers max). Offer auto-declined.';
            assignment.remarks = `Negotiation limit reached. Auto-declined.`;
            assignment.updatedBy = userId;
            if (assignment.projectBranch) {
                assignment.projectBranch.status = shared_1.ProjectBranchStatus.CANDIDATE_SEARCH;
            }
            return this.dataSource.transaction(async (manager) => {
                if (assignment.projectBranch) {
                    await manager.save(assignment.projectBranch);
                }
                return manager.save(assignment);
            });
        }
        assignment.negotiationCount = currentCount + 1;
        assignment.proposedFee = counterFee;
        assignment.remarks = remarks ?? `Counter offer #${assignment.negotiationCount} proposed: ₹${counterFee}`;
        assignment.updatedBy = userId;
        if (assignment.projectBranch) {
            assignment.projectBranch.status = shared_1.ProjectBranchStatus.NEGOTIATION;
        }
        const saved = await this.dataSource.transaction(async (manager) => {
            if (assignment.projectBranch) {
                await manager.save(assignment.projectBranch);
            }
            return manager.save(assignment);
        });
        try {
            this.eventPublisher.publish('assignment:counter-offered', {
                eventType: 'assignment:counter-offered',
                assignmentId: saved.id,
                assayerId: saved.assayerId,
                proposedFee: counterFee,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish counter offer event', err);
        }
        return saved;
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
    async completeAssignment(id, userId, reason) {
        const { saved, event } = await this.executeAssignmentTransition(id, shared_1.AssignmentStatus.COMPLETED, userId, reason);
        if (event)
            this.publishAssignmentEvent('assignment:status-changed', saved, event);
        return saved;
    }
    async escalate(id, userId, reason) {
        const assignment = await this.findOne(id);
        if (assignment.status === shared_1.AssignmentStatus.COMPLETED) {
            throw new common_1.BadRequestException('Cannot escalate a completed assignment.');
        }
        const alreadyCritical = assignment.priority === shared_1.Priority.CRITICAL;
        assignment.priority = shared_1.Priority.CRITICAL;
        assignment.updatedBy = userId;
        const saved = await this.assignmentRepository.save(assignment);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSIGNMENT_ESCALATED',
            entityType: 'ASSIGNMENT',
            entityId: saved.id,
            userId,
            remarks: reason ?? `Assignment ${saved.assignmentNumber} escalated to CRITICAL priority.`,
        });
        if (!alreadyCritical) {
            this.notificationDispatch.emitSafe({
                type: 'ASSIGNMENT_ESCALATED',
                entityType: 'ASSIGNMENT',
                entityId: saved.id,
                actorUserId: userId,
                ownerUserId: saved.createdBy,
                dedupeKey: `ASSIGNMENT_ESCALATED:${saved.id}`,
                payload: {
                    assignmentId: saved.id,
                    assignmentNumber: saved.assignmentNumber,
                    branchName: assignment.projectBranch?.branch?.name ?? saved.assignmentNumber,
                    reason: reason ?? 'No reason given.',
                },
            });
        }
        this.publishAssignmentEvent('assignment:escalated', saved, { userId, previousState: assignment.status, timestamp: new Date() });
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
    async findAll(page = 1, limit = 50, status, projectBranchStatus, assessmentStatus, unscheduledOnly, priority) {
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
            const pbStatuses = projectBranchStatus.split(',').map((s) => s.trim()).filter(Boolean);
            if (pbStatuses.length === 1) {
                where.projectBranch = { status: pbStatuses[0] };
            }
            else if (pbStatuses.length > 1) {
                where.projectBranch = { status: (0, typeorm_2.In)(pbStatuses) };
            }
        }
        if (assessmentStatus) {
            where.assessment = { status: assessmentStatus };
        }
        if (priority) {
            const priorities = priority.split(',').map((s) => s.trim()).filter(Boolean);
            if (priorities.length === 1) {
                where.priority = priorities[0];
            }
            else if (priorities.length > 1) {
                where.priority = (0, typeorm_2.In)(priorities);
            }
        }
        if (unscheduledOnly) {
            const activeSchedules = await this.dataSource
                .getRepository('schedules')
                .find({ select: ['assignmentId'], where: { isActive: true } })
                .catch(() => []);
            const scheduledAsnIds = activeSchedules.map((s) => s.assignmentId).filter(Boolean);
            if (scheduledAsnIds.length > 0) {
                where.id = (0, typeorm_2.Not)((0, typeorm_2.In)(scheduledAsnIds));
            }
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
                status: (0, typeorm_2.In)([
                    shared_1.AssignmentStatus.PENDING,
                    shared_1.AssignmentStatus.ACCEPTED,
                    shared_1.AssignmentStatus.CHECKED_IN,
                    shared_1.AssignmentStatus.IN_PROGRESS,
                    shared_1.AssignmentStatus.COMPLETED,
                    shared_1.AssignmentStatus.REJECTED,
                    shared_1.AssignmentStatus.CANCELLED,
                ]),
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
        const commercialProfileRepo = this.dataSource.getRepository(assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity);
        const commProfile = await commercialProfileRepo.findOne({ where: { assayerId, isActive: true } }).catch(() => null);
        const baseFeeAmount = commProfile?.baseFee ? Number(commProfile.baseFee) : 1200;
        const queryRepo = this.dataSource.getRepository(validation_query_entity_1.ValidationQueryEntity);
        const caseRepo = this.dataSource.getRepository(validation_case_entity_1.ValidationCaseEntity);
        for (const assignment of assignments) {
            assignment.currentStandardBaseFee = baseFeeAmount;
            const version = projectVersions.get(assignment.projectBranch.projectId);
            if (version) {
                const branchId = assignment.projectBranch.branchId;
                const records = await recordRepo.find({
                    where: { customerMasterVersionId: version.id, branchId, isActive: true },
                });
                assignment.customerCount = records.length > 0 ? records.length : (assignment.projectBranch?.packetCount || 15);
                assignment.customers = records;
            }
            else {
                assignment.customerCount = assignment.projectBranch?.packetCount || 15;
                assignment.customers = [];
            }
            if (assignment.projectBranchId) {
                const valCases = await caseRepo.find({
                    where: { projectBranchId: assignment.projectBranchId, isActive: true },
                });
                if (valCases.length > 0) {
                    const caseIds = valCases.map((c) => c.id);
                    const queries = await queryRepo.find({
                        where: { validationCaseId: (0, typeorm_2.In)(caseIds), isActive: true },
                        order: { createdAt: 'DESC' },
                    });
                    assignment.queries = queries;
                }
                else {
                    assignment.queries = [];
                }
            }
            else {
                assignment.queries = [];
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
    async autoDeclineExpiredOffers() {
        const now = new Date();
        const pendingOffers = await this.assignmentRepository.find({
            where: {
                status: shared_1.AssignmentStatus.PENDING,
                isActive: true,
            },
        });
        let declinedCount = 0;
        for (const assignment of pendingOffers) {
            if (assignment.slaDueDate && assignment.slaDueDate < now) {
                try {
                    await this.rejectOffer(assignment.id, 'SYSTEM', 'AUTO_DECLINED_SLA_EXPIRED');
                    declinedCount++;
                }
                catch (err) {
                    console.error(`Failed to auto-decline expired assignment ${assignment.id}:`, err);
                }
            }
        }
        return declinedCount;
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
        assignment.status = shared_1.AssignmentStatus.CHECKED_IN;
        assignment.updatedBy = userId || assignment.assayerId || id;
        assignment.syncToken = `SYNC-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        if (assignment.projectBranch) {
            assignment.projectBranch.status = shared_1.ProjectBranchStatus.SCHEDULED;
            if (!assignment.projectBranch.scheduledDate) {
                assignment.projectBranch.scheduledDate = assignment.scheduledDate || new Date();
            }
            assignment.projectBranch.updatedBy = userId || assignment.assayerId || id;
        }
        if (assignment.assessment) {
            assignment.assessment.status = shared_1.AssessmentStatus.ASSIGNED_AND_SCHEDULED;
            assignment.assessment.auditDate = assignment.scheduledDate || new Date();
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
    __param(14, (0, typeorm_3.InjectDataSource)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        project_query_service_1.ProjectQueryService,
        project_service_1.ProjectService,
        assayer_service_1.AssayerService,
        notification_service_1.NotificationService,
        notification_dispatch_service_1.NotificationDispatchService,
        push_notification_service_1.PushNotificationService,
        holiday_service_1.HolidayService,
        audit_service_1.AuditService,
        domain_event_publisher_1.DomainEventPublisher,
        constraint_evaluator_1.ConstraintEvaluator,
        routing_provider_1.RoutingService,
        validation_service_1.ValidationService,
        typeorm_2.DataSource])
], AssignmentService);
//# sourceMappingURL=assignment.service.js.map