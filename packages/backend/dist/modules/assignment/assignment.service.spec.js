"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const typeorm_2 = require("typeorm");
const assignment_service_1 = require("./assignment.service");
const assignment_entity_1 = require("./assignment.entity");
const notification_service_1 = require("../notifications/notification.service");
const notification_dispatch_service_1 = require("../notifications/notification-dispatch.service");
const push_notification_service_1 = require("../notifications/push-notification.service");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
const project_service_1 = require("../project/project.service");
const project_query_service_1 = require("../project/project-query.service");
const assayer_service_1 = require("../assayer/assayer.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const assessment_entity_1 = require("../project/assessment.entity");
const constraint_evaluator_1 = require("../planning/constraint.evaluator");
const routing_provider_1 = require("../geo/routing.provider");
const validation_service_1 = require("../validation/validation.service");
describe('AssignmentService', () => {
    let service;
    let assignmentRepo;
    let holidayService;
    let auditService;
    const mockAssignmentRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
        findAndCount: jest.fn(),
    };
    const mockProjectBranchRepo = {
        findOne: jest.fn(),
        save: jest.fn(),
    };
    const mockAssayerRepo = {
        findOne: jest.fn(),
    };
    const mockProjectService = {
        initiateBranchPlanning: jest.fn(),
        confirmBranchAssignment: jest.fn(),
        scheduleBranchAudit: jest.fn(),
        completeBranchAudit: jest.fn(),
        closeBranchProject: jest.fn(),
    };
    const mockProjectQueryService = {
        findProjectBranchById: mockProjectBranchRepo.findOne,
    };
    const mockAssayerService = {
        findOne: mockAssayerRepo.findOne,
        updateAssayerStats: jest.fn(),
        getActiveCommercialProfile: jest.fn().mockResolvedValue({ baseFee: 1500 }),
    };
    const mockHolidayService = {
        isHoliday: jest.fn(),
    };
    const mockNotificationDispatch = {
        emit: jest.fn().mockResolvedValue({ groupKey: 'g', created: 1, suppressed: 0, recipients: { userIds: [], assayerIds: [] } }),
        emitSafe: jest.fn(),
        markRead: jest.fn(),
    };
    const mockNotificationService = {
        create: jest.fn().mockImplementation(async (dto) => ({ id: 'notif-123', ...dto })),
    };
    const mockPushNotificationService = {
        sendToUser: jest.fn().mockResolvedValue(undefined),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
    };
    const mockDomainEventPublisher = {
        publish: jest.fn(),
    };
    const mockUserRepoViaDataSource = {
        findOne: jest.fn(),
    };
    const mockDataSource = {
        transaction: jest.fn((cb) => cb({
            save: jest.fn((arg) => Promise.resolve(arg)),
            getRepository: jest.fn().mockReturnValue({
                findOne: jest.fn(),
            }),
        })),
        getRepository: jest.fn().mockReturnValue(mockUserRepoViaDataSource),
    };
    const mockConstraintEvaluator = {
        checkDoubleBooking: jest.fn().mockResolvedValue({ passed: true }),
        checkLeaves: jest.fn().mockReturnValue({ passed: true }),
        checkProjectTimeline: jest.fn().mockReturnValue({ passed: true }),
        checkHoliday: jest.fn().mockResolvedValue({ passed: true }),
        checkSkillsAndCertifications: jest.fn().mockReturnValue({ passed: true }),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                assignment_service_1.AssignmentService,
                { provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity), useValue: mockAssignmentRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assessment_entity_1.AssessmentEntity), useValue: { findOne: jest.fn(), save: jest.fn() } },
                { provide: project_query_service_1.ProjectQueryService, useValue: mockProjectQueryService },
                { provide: project_service_1.ProjectService, useValue: mockProjectService },
                { provide: assayer_service_1.AssayerService, useValue: mockAssayerService },
                { provide: holiday_service_1.HolidayService, useValue: mockHolidayService },
                { provide: notification_service_1.NotificationService, useValue: mockNotificationService },
                { provide: notification_dispatch_service_1.NotificationDispatchService, useValue: mockNotificationDispatch },
                { provide: push_notification_service_1.PushNotificationService, useValue: mockPushNotificationService },
                { provide: audit_service_1.AuditService, useValue: mockAuditService },
                { provide: domain_event_publisher_1.DomainEventPublisher, useValue: mockDomainEventPublisher },
                { provide: typeorm_2.DataSource, useValue: mockDataSource },
                { provide: constraint_evaluator_1.ConstraintEvaluator, useValue: mockConstraintEvaluator },
                { provide: routing_provider_1.RoutingService, useValue: { calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 5, durationMinutes: 10 }) } },
                { provide: validation_service_1.ValidationService, useValue: { createAssessment: jest.fn().mockResolvedValue({}) } },
            ],
        }).compile();
        service = module.get(assignment_service_1.AssignmentService);
        assignmentRepo = module.get((0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity));
        holidayService = module.get(holiday_service_1.HolidayService);
        auditService = module.get(audit_service_1.AuditService);
        jest.clearAllMocks();
    });
    describe('create', () => {
        const validDto = {
            projectBranchId: 'pb-1',
            assayerId: 'as-1',
            proposedFee: 500,
            scheduledDate: '2026-08-01',
        };
        it('should throw NotFoundException if project branch does not exist', async () => {
            mockProjectBranchRepo.findOne.mockResolvedValue(null);
            await expect(service.create(validDto, 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
        it('should throw NotFoundException if assayer does not exist', async () => {
            mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', branch: { state: 'MH' }, project: {} });
            mockAssayerRepo.findOne.mockResolvedValue(null);
            await expect(service.create(validDto, 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
        it('should throw BadRequestException if assayer lacks required skills', async () => {
            mockProjectBranchRepo.findOne.mockResolvedValue({
                id: 'pb-1', branch: { state: 'MH' },
                project: { requiredSkills: ['Expert Appraiser'] },
            });
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', skills: ['Junior Valuer'] });
            mockConstraintEvaluator.checkSkillsAndCertifications.mockReturnValue({
                passed: false, reason: 'Assayer lacks required skills',
            });
            await expect(service.create(validDto, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should throw ConflictException if existing active assignment exists', async () => {
            mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', branch: { state: 'MH' }, project: {} });
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', skills: [], certifications: [] });
            mockConstraintEvaluator.checkSkillsAndCertifications.mockReturnValue({ passed: true });
            mockAssignmentRepo.findOne.mockResolvedValue({ id: 'existing', status: shared_1.AssignmentStatus.ACCEPTED });
            await expect(service.create(validDto, 'user-1')).rejects.toThrow(common_1.ConflictException);
        });
        it('should create assignment in PENDING status', async () => {
            mockProjectBranchRepo.findOne.mockResolvedValue({
                id: 'pb-1', projectId: 'p-1', branch: { name: 'Test', state: 'MH' }, project: {},
            });
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', skills: [], certifications: [] });
            mockConstraintEvaluator.checkSkillsAndCertifications.mockReturnValue({ passed: true });
            mockAssignmentRepo.findOne.mockResolvedValue(null);
            const created = {
                id: 'asn-1', assignmentNumber: 'ASN-2026-1',
                status: shared_1.AssignmentStatus.PENDING, proposedFee: 500,
            };
            mockAssignmentRepo.create.mockReturnValue(created);
            mockAssignmentRepo.save.mockResolvedValue(created);
            const result = await service.create(validDto, 'user-1');
            expect(result.status).toBe(shared_1.AssignmentStatus.PENDING);
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
    });
    describe('acceptOffer', () => {
        it('should accept and update project branch to ASSIGNMENT_CONFIRMED', async () => {
            const assignment = {
                id: 'asn-1', status: shared_1.AssignmentStatus.PENDING, agreedFee: null,
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.NEGOTIATION, isActive: true },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(assignment);
            mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
            const result = await service.acceptOffer('asn-1', 'user-1', 2000);
            expect(result.status).toBe(shared_1.AssignmentStatus.ACCEPTED);
            expect(result.agreedFee).toBe(2000);
            expect(assignment.projectBranch.status).toBe(shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED);
            expect(mockDomainEventPublisher.publish).toHaveBeenCalledWith('ProjectBranchAssignmentConfirmedEvent', expect.objectContaining({ aggregateId: 'pb-1' }));
        });
    });
    describe('rejectOffer', () => {
        it('should reject and mark branch as CANDIDATE_SEARCH', async () => {
            const assignment = {
                id: 'asn-1', status: shared_1.AssignmentStatus.PENDING,
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.NEGOTIATION },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(assignment);
            mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
            const result = await service.rejectOffer('asn-1', 'user-1', 'Too far');
            expect(result.status).toBe(shared_1.AssignmentStatus.REJECTED);
            expect(result.rejectReason).toBe('Too far');
        });
    });
    describe('cancelAssignment', () => {
        it('should cancel assignment', async () => {
            const assignment = {
                id: 'asn-1', status: shared_1.AssignmentStatus.ACCEPTED,
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(assignment);
            mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
            const result = await service.cancelAssignment('asn-1', 'user-1', 'Admin override');
            expect(result.status).toBe(shared_1.AssignmentStatus.CANCELLED);
        });
    });
    describe('scheduleAudit', () => {
        it('should update project branch status to SCHEDULED', async () => {
            const assignment = {
                id: 'asn-1', status: shared_1.AssignmentStatus.ACCEPTED, scheduledDate: null,
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(assignment);
            mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
            const result = await service.scheduleAudit('asn-1', 'user-1', '2026-08-15');
            expect(result.scheduledDate).toEqual(new Date('2026-08-15'));
        });
    });
    describe('update', () => {
        it('should throw BadRequestException if assignment is not PENDING', async () => {
            mockAssignmentRepo.findOne.mockResolvedValue({
                id: 'asn-1', status: shared_1.AssignmentStatus.ACCEPTED,
                projectBranch: { id: 'pb-1' },
            });
            await expect(service.update('asn-1', { proposedFee: 600 }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
    });
    describe('autoDeclineExpiredOffers', () => {
        it('auto-declines a PENDING assignment past its slaDueDate', async () => {
            const pastDue = new Date(Date.now() - 60 * 60 * 1000);
            const assignment = {
                id: 'asn-1', status: shared_1.AssignmentStatus.PENDING, slaDueDate: pastDue,
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.NEGOTIATION },
            };
            mockAssignmentRepo.find.mockResolvedValue([assignment]);
            mockAssignmentRepo.findOne.mockResolvedValue(assignment);
            mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
            const declinedCount = await service.autoDeclineExpiredOffers();
            expect(declinedCount).toBe(1);
            expect(assignment.status).toBe(shared_1.AssignmentStatus.REJECTED);
            expect(assignment.rejectReason).toBe('AUTO_DECLINED_SLA_EXPIRED');
            expect(assignment.projectBranch.status).toBe(shared_1.ProjectBranchStatus.CANDIDATE_SEARCH);
        });
        it('leaves a PENDING assignment untouched if its slaDueDate has not passed yet', async () => {
            const notYetDue = new Date(Date.now() + 60 * 60 * 1000);
            const assignment = {
                id: 'asn-1', status: shared_1.AssignmentStatus.PENDING, slaDueDate: notYetDue,
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.NEGOTIATION },
            };
            mockAssignmentRepo.find.mockResolvedValue([assignment]);
            const declinedCount = await service.autoDeclineExpiredOffers();
            expect(declinedCount).toBe(0);
            expect(assignment.status).toBe(shared_1.AssignmentStatus.PENDING);
            expect(mockAssignmentRepo.save).not.toHaveBeenCalled();
        });
        it('queries only active PENDING assignments, so non-PENDING assignments are never considered', async () => {
            mockAssignmentRepo.find.mockResolvedValue([]);
            const declinedCount = await service.autoDeclineExpiredOffers();
            expect(declinedCount).toBe(0);
            expect(mockAssignmentRepo.find).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({ status: shared_1.AssignmentStatus.PENDING, isActive: true }),
            }));
        });
    });
    describe('escalate', () => {
        it('bumps priority to CRITICAL and records an audit event', async () => {
            const assignment = {
                id: 'asn-1', assignmentNumber: 'ASN-2026-1', status: shared_1.AssignmentStatus.PENDING,
                priority: shared_1.Priority.MEDIUM, createdBy: 'ops-user-1',
            };
            mockAssignmentRepo.findOne.mockResolvedValue(assignment);
            mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
            const result = await service.escalate('asn-1', 'ops-user-2', 'Branch manager unresponsive');
            expect(result.priority).toBe(shared_1.Priority.CRITICAL);
            expect(mockAuditService.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1' }));
        });
        it('escalation notifies the operations roles, not just the raiser', async () => {
            const assignment = {
                id: 'asn-1', assignmentNumber: 'ASN-2026-1', status: shared_1.AssignmentStatus.PENDING,
                priority: shared_1.Priority.MEDIUM, createdBy: 'ops-user-1',
            };
            mockAssignmentRepo.findOne.mockResolvedValue(assignment);
            mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
            mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'ops-user-1' });
            await service.escalate('asn-1', 'ops-user-2', 'Client escalated.');
            expect(mockNotificationDispatch.emitSafe).toHaveBeenCalledWith(expect.objectContaining({
                type: 'ASSIGNMENT_ESCALATED',
                entityId: 'asn-1',
                actorUserId: 'ops-user-2',
                ownerUserId: 'ops-user-1',
            }));
        });
        it('does not re-notify an assignment that is already CRITICAL', async () => {
            mockAssignmentRepo.findOne.mockResolvedValue({
                id: 'asn-1', assignmentNumber: 'ASN-2026-1', status: shared_1.AssignmentStatus.PENDING,
                priority: shared_1.Priority.CRITICAL, createdBy: 'ops-user-1',
            });
            mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
            await service.escalate('asn-1', 'ops-user-2');
            expect(mockNotificationDispatch.emitSafe).not.toHaveBeenCalled();
        });
        it('rejects escalating an assignment that is already COMPLETED', async () => {
            mockAssignmentRepo.findOne.mockResolvedValue({
                id: 'asn-1', status: shared_1.AssignmentStatus.COMPLETED, priority: shared_1.Priority.MEDIUM,
            });
            await expect(service.escalate('asn-1', 'ops-user-2')).rejects.toThrow(common_1.BadRequestException);
        });
    });
});
//# sourceMappingURL=assignment.service.spec.js.map