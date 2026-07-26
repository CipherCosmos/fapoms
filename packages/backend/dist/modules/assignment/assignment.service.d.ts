import { OnModuleInit } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentCommentEntity } from './assignment-comment.entity';
import { NotificationService } from '../notifications/notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { AssayerService } from '../assayer/assayer.service';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { AssignmentStatus } from '@fapoms/shared';
export interface CreateAssignmentDto {
    projectBranchId: string;
    assayerId: string;
    proposedFee: number;
    scheduledDate: string;
    remarks?: string;
}
export interface UpdateAssignmentDetailsDto {
    proposedFee?: number;
    agreedFee?: number;
    scheduledDate?: string;
    remarks?: string;
}
export interface TransitionAssignmentDto {
    targetStatus: AssignmentStatus;
    remarks?: string;
    reason?: string;
    fee?: number;
    scheduledDate?: string;
}
export declare class AssignmentService implements OnModuleInit {
    private readonly assignmentRepository;
    private readonly projectQueryService;
    private readonly projectService;
    private readonly assayerService;
    private readonly notificationService;
    private readonly holidayService;
    private readonly auditService;
    private readonly workflowEngine;
    private readonly eventPublisher;
    private readonly constraintEvaluator;
    private readonly dataSource;
    constructor(assignmentRepository: Repository<AssignmentEntity>, projectQueryService: ProjectQueryService, projectService: ProjectService, assayerService: AssayerService, notificationService: NotificationService, holidayService: HolidayService, auditService: AuditService, workflowEngine: WorkflowEngine, eventPublisher: DomainEventPublisher, constraintEvaluator: ConstraintEvaluator, dataSource: DataSource);
    onModuleInit(): void;
    create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentEntity>;
    findOne(id: string): Promise<AssignmentEntity>;
    update(id: string, dto: UpdateAssignmentDetailsDto, userId: string): Promise<AssignmentEntity>;
    private executeAssignmentTransition;
    transition(id: string, targetStatus: AssignmentStatus, userId: string, remarks?: string, reason?: string, fee?: number, scheduledDate?: string): Promise<AssignmentEntity>;
    selectCandidate(id: string, userId: string, remarks?: string): Promise<AssignmentEntity>;
    initiateContact(id: string, userId: string, remarks?: string): Promise<AssignmentEntity>;
    negotiate(id: string, userId: string, fee: number, remarks?: string): Promise<AssignmentEntity>;
    acceptOffer(id: string, userId: string, fee?: number, remarks?: string): Promise<AssignmentEntity>;
    rejectOffer(id: string, userId: string, reason?: string, remarks?: string): Promise<AssignmentEntity>;
    scheduleAudit(id: string, userId: string, scheduledDate: string, remarks?: string): Promise<AssignmentEntity>;
    completeAudit(id: string, userId: string, remarks?: string): Promise<AssignmentEntity>;
    closeAssignment(id: string, userId: string, remarks?: string): Promise<AssignmentEntity>;
    cancelAssignment(id: string, userId: string, reason?: string, remarks?: string): Promise<AssignmentEntity>;
    findAll(page?: number, limit?: number, status?: string): Promise<{
        assignments: AssignmentEntity[];
        total: number;
    }>;
    addComment(assignmentId: string, comment: string, userId: string, userName: string): Promise<AssignmentCommentEntity>;
    getTimeline(assignmentId: string): Promise<any[]>;
    checkSlaBreaches(): Promise<number>;
    getDashboardSummary(): Promise<any>;
}
