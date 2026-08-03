import { DataSource, Repository } from 'typeorm';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentCommentEntity } from './assignment-comment.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { NotificationService } from '../notifications/notification.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerService } from '../assayer/assayer.service';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { RoutingService } from '../geo/routing.provider';
import { ValidationService } from '../validation/validation.service';
import { AssignmentStatus } from '@fapoms/shared';
export interface CreateAssignmentDto {
    projectBranchId: string;
    assayerId: string;
    proposedFee?: number;
    scheduledDate?: string;
    remarks?: string;
    autoSchedule?: boolean;
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
export declare class AssignmentService {
    private readonly assignmentRepository;
    private readonly assessmentRepository;
    private readonly projectQueryService;
    private readonly projectService;
    private readonly assayerService;
    private readonly notificationService;
    private readonly notificationDispatch;
    private readonly pushNotificationService;
    private readonly holidayService;
    private readonly auditService;
    private readonly eventPublisher;
    private readonly constraintEvaluator;
    private readonly routingService;
    private readonly validationService;
    private readonly dataSource;
    constructor(assignmentRepository: Repository<AssignmentEntity>, assessmentRepository: Repository<AssessmentEntity>, projectQueryService: ProjectQueryService, projectService: ProjectService, assayerService: AssayerService, notificationService: NotificationService, notificationDispatch: NotificationDispatchService, pushNotificationService: PushNotificationService, holidayService: HolidayService, auditService: AuditService, eventPublisher: DomainEventPublisher, constraintEvaluator: ConstraintEvaluator, routingService: RoutingService, validationService: ValidationService, dataSource: DataSource);
    private syncAssessmentStatus;
    create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentEntity>;
    findOne(id: string): Promise<AssignmentEntity>;
    update(id: string, dto: UpdateAssignmentDetailsDto, userId: string): Promise<AssignmentEntity>;
    private executeAssignmentTransition;
    proposeCounterFee(id: string, userId: string, counterFee: number, remarks?: string): Promise<AssignmentEntity>;
    acceptOffer(id: string, userId: string, fee?: number, reason?: string): Promise<AssignmentEntity>;
    rejectOffer(id: string, userId: string, reason?: string): Promise<AssignmentEntity>;
    cancelAssignment(id: string, userId: string, reason?: string): Promise<AssignmentEntity>;
    completeAssignment(id: string, userId: string, reason?: string): Promise<AssignmentEntity>;
    escalate(id: string, userId: string, reason?: string): Promise<AssignmentEntity>;
    scheduleAudit(id: string, userId: string, scheduledDate: string, remarks?: string): Promise<AssignmentEntity>;
    private publishAssignmentEvent;
    findAll(page?: number, limit?: number, status?: string, projectBranchStatus?: string, assessmentStatus?: string, unscheduledOnly?: boolean, priority?: string): Promise<{
        assignments: AssignmentEntity[];
        total: number;
    }>;
    findByAssayer(assayerId: string): Promise<AssignmentEntity[]>;
    addComment(assignmentId: string, comment: string, userId: string, userName: string): Promise<AssignmentCommentEntity>;
    getTimeline(assignmentId: string): Promise<any[]>;
    checkSlaBreaches(): Promise<number>;
    autoDeclineExpiredOffers(): Promise<number>;
    getDashboardSummary(): Promise<any>;
    recordCheckIn(id: string, lat: number, lng: number, syncToken?: string, userId?: string): Promise<{
        success: boolean;
        assignment: AssignmentEntity;
        error?: string;
        message?: string;
    }>;
}
