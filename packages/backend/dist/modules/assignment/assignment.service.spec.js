"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const typeorm_2 = require("typeorm");
const assignment_service_1 = require("./assignment.service");
const assignment_entity_1 = require("./assignment.entity");
const notification_service_1 = require("../notifications/notification.service");
const push_notification_service_1 = require("../notifications/push-notification.service");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
const project_service_1 = require("../project/project.service");
const project_query_service_1 = require("../project/project-query.service");
const assayer_service_1 = require("../assayer/assayer.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const constraint_evaluator_1 = require("../planning/constraint.evaluator");
describe('AssignmentService', () => {
    let service;
    let assignmentRepo;
    let holidayService;
    let auditService;
    const mockAssignmentRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
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
    };
    const mockHolidayService = {
        isHoliday: jest.fn(),
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
    const mockDataSource = {
        transaction: jest.fn((cb) => cb({
            save: jest.fn((arg) => Promise.resolve(arg)),
            getRepository: jest.fn().mockReturnValue({
                findOne: jest.fn(),
            }),
        })),
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
                { provide: project_query_service_1.ProjectQueryService, useValue: mockProjectQueryService },
                { provide: project_service_1.ProjectService, useValue: mockProjectService },
                { provide: assayer_service_1.AssayerService, useValue: mockAssayerService },
                { provide: holiday_service_1.HolidayService, useValue: mockHolidayService },
                { provide: notification_service_1.NotificationService, useValue: mockNotificationService },
                { provide: push_notification_service_1.PushNotificationService, useValue: mockPushNotificationService },
                { provide: audit_service_1.AuditService, useValue: mockAuditService },
                { provide: domain_event_publisher_1.DomainEventPublisher, useValue: mockDomainEventPublisher },
                { provide: typeorm_2.DataSource, useValue: mockDataSource },
                { provide: constraint_evaluator_1.ConstraintEvaluator, useValue: mockConstraintEvaluator },
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
            mockAssignmentRepo.findOne.mockResolvedValue({ id: 'existing', status: shared_1.AssignmentStatus.ACCEPTED });
            await expect(service.create(validDto, 'user-1')).rejects.toThrow(common_1.ConflictException);
        });
        it('should create assignment in PENDING status', async () => {
            mockProjectBranchRepo.findOne.mockResolvedValue({
                id: 'pb-1', projectId: 'p-1', branch: { name: 'Test', state: 'MH' }, project: {},
            });
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', skills: [], certifications: [] });
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
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.NEGOTIATION },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(assignment);
            mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
            const result = await service.acceptOffer('asn-1', 'user-1', 2000);
            expect(result.status).toBe(shared_1.AssignmentStatus.ACCEPTED);
            expect(result.agreedFee).toBe(2000);
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
});
//# sourceMappingURL=assignment.service.spec.js.map