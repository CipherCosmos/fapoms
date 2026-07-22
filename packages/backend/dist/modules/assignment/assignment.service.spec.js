"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const typeorm_2 = require("typeorm");
const assignment_service_1 = require("./assignment.service");
const assignment_entity_1 = require("./assignment.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const notification_service_1 = require("../notifications/notification.service");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
const workflow_engine_1 = require("../platform/workflow/workflow.engine");
describe('AssignmentService', () => {
    let service;
    let assignmentRepo;
    let projectBranchRepo;
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
    const mockHolidayService = {
        isHoliday: jest.fn(),
    };
    const mockNotificationService = {
        create: jest.fn().mockImplementation(async (dto) => ({ id: 'notif-123', ...dto })),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
    };
    const mockDataSource = {
        transaction: jest.fn((cb) => cb({
            save: jest.fn((arg) => Promise.resolve(arg)),
        })),
    };
    const mockWorkflowEngine = {
        registerWorkflow: jest.fn(),
        executeTransition: jest.fn().mockImplementation(async (key, id, from, to, ctx) => {
            const validPaths = {
                CREATED: ['ACCEPTED', 'REJECTED', 'CANCELLED', 'CANDIDATE_SELECTED'],
                ACCEPTED: ['SCHEDULED'],
                SCHEDULED: ['AUDIT_COMPLETED'],
                AUDIT_COMPLETED: ['CLOSED'],
            };
            const allowed = validPaths[from] || [];
            if (!allowed.includes(to)) {
                throw new common_1.BadRequestException(`Invalid transition from '${from}' to '${to}'`);
            }
            if (to === 'ACCEPTED') {
                ctx.payload.assignment.agreedFee = ctx.payload.fee ?? ctx.payload.assignment.proposedFee;
                ctx.payload.assignment.projectBranch.status = 'ASSIGNMENT_CONFIRMED';
            }
            if (to === 'REJECTED') {
                ctx.payload.assignment.rejectReason = ctx.payload.reason ?? 'Rejected';
                ctx.payload.assignment.projectBranch.status = 'CANDIDATE_SEARCH';
            }
            if (to === 'CANCELLED') {
                ctx.payload.assignment.cancelReason = ctx.payload.reason ?? 'Cancelled';
                ctx.payload.assignment.projectBranch.status = 'CANDIDATE_SEARCH';
            }
            if (to === 'SCHEDULED') {
                if (ctx.payload.scheduledDate) {
                    ctx.payload.assignment.scheduledDate = new Date(ctx.payload.scheduledDate);
                    ctx.payload.assignment.projectBranch.scheduledDate = new Date(ctx.payload.scheduledDate);
                }
                ctx.payload.assignment.projectBranch.status = 'SCHEDULED';
            }
            if (to === 'AUDIT_COMPLETED') {
                ctx.payload.assignment.completionDate = new Date();
                ctx.payload.assignment.projectBranch.status = 'AUDIT_COMPLETED';
            }
            if (to === 'CLOSED') {
                ctx.payload.assignment.projectBranch.status = 'CLOSED';
            }
        }),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                assignment_service_1.AssignmentService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity),
                    useValue: mockAssignmentRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity),
                    useValue: mockProjectBranchRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(assayer_entity_1.AssayerEntity),
                    useValue: mockAssayerRepo,
                },
                {
                    provide: holiday_service_1.HolidayService,
                    useValue: mockHolidayService,
                },
                {
                    provide: notification_service_1.NotificationService,
                    useValue: mockNotificationService,
                },
                {
                    provide: audit_service_1.AuditService,
                    useValue: mockAuditService,
                },
                {
                    provide: workflow_engine_1.WorkflowEngine,
                    useValue: mockWorkflowEngine,
                },
                {
                    provide: typeorm_2.DataSource,
                    useValue: mockDataSource,
                },
            ],
        }).compile();
        service = module.get(assignment_service_1.AssignmentService);
        assignmentRepo = module.get((0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity));
        projectBranchRepo = module.get((0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity));
        holidayService = module.get(holiday_service_1.HolidayService);
        auditService = module.get(audit_service_1.AuditService);
        jest.clearAllMocks();
    });
    describe('create', () => {
        it('should throw NotFoundException if project branch does not exist', async () => {
            mockProjectBranchRepo.findOne.mockResolvedValue(null);
            await expect(service.create({
                projectBranchId: 'pb-1',
                assayerId: 'as-1',
                proposedFee: 500,
                scheduledDate: '2026-08-01',
            }, 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
        it('should throw NotFoundException if assayer does not exist', async () => {
            const mockBranch = { id: 'pb-1', branch: { state: 'MH' }, project: {} };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
            mockAssayerRepo.findOne.mockResolvedValue(null);
            await expect(service.create({
                projectBranchId: 'pb-1',
                assayerId: 'as-1',
                proposedFee: 500,
                scheduledDate: '2026-08-01',
            }, 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
        it('should throw BadRequestException if assayer lacks required skills', async () => {
            const mockBranch = {
                id: 'pb-1',
                branch: { state: 'MH' },
                project: { requiredSkills: ['Expert Appraiser'] },
            };
            const mockAssayer = { id: 'as-1', skills: ['Junior Valuer'] };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
            mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
            await expect(service.create({
                projectBranchId: 'pb-1',
                assayerId: 'as-1',
                proposedFee: 500,
                scheduledDate: '2026-08-01',
            }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should throw BadRequestException if assayer lacks required certifications', async () => {
            const mockBranch = {
                id: 'pb-1',
                branch: { state: 'MH' },
                project: { requiredSkills: [], requiredCertifications: ['Gold Appraiser Cert'] },
            };
            const mockAssayer = {
                id: 'as-1',
                skills: [],
                certifications: [{ name: 'Basic Valuer Cert', expiryDate: '2027-01-01' }],
            };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
            mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
            await expect(service.create({
                projectBranchId: 'pb-1',
                assayerId: 'as-1',
                proposedFee: 500,
                scheduledDate: '2026-08-01',
            }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should throw BadRequestException if date is a holiday', async () => {
            const mockBranch = { id: 'pb-1', branch: { state: 'MH' }, project: {} };
            const mockAssayer = { id: 'as-1', skills: [], certifications: [] };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
            mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
            mockHolidayService.isHoliday.mockResolvedValue(true);
            await expect(service.create({
                projectBranchId: 'pb-1',
                assayerId: 'as-1',
                proposedFee: 500,
                scheduledDate: '2026-08-01',
            }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should throw ConflictException if assayer is double-booked', async () => {
            const mockBranch = { id: 'pb-1', branch: { state: 'MH' }, project: {} };
            const mockAssayer = { id: 'as-1', skills: [], certifications: [] };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
            mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
            mockHolidayService.isHoliday.mockResolvedValue(false);
            mockAssignmentRepo.findOne.mockResolvedValue({ id: 'existing-asn' });
            await expect(service.create({
                projectBranchId: 'pb-1',
                assayerId: 'as-1',
                proposedFee: 500,
                scheduledDate: '2026-08-01',
            }, 'user-1')).rejects.toThrow(common_1.ConflictException);
        });
        it('should successfully create an assignment in CREATED status', async () => {
            const mockBranch = { id: 'pb-1', projectId: 'p-1', branch: { name: 'Branch 1', state: 'MH' }, project: {} };
            const mockAssayer = { id: 'as-1', skills: [], certifications: [] };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
            mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
            mockHolidayService.isHoliday.mockResolvedValue(false);
            mockAssignmentRepo.findOne.mockResolvedValue(null);
            const mockCreatedAssignment = {
                id: 'asn-123',
                assignmentNumber: 'ASN-2026-1234',
                status: shared_1.AssignmentStatus.CREATED,
            };
            mockAssignmentRepo.create.mockReturnValue(mockCreatedAssignment);
            mockAssignmentRepo.save.mockResolvedValue(mockCreatedAssignment);
            const result = await service.create({
                projectBranchId: 'pb-1',
                assayerId: 'as-1',
                proposedFee: 500,
                scheduledDate: '2026-08-01',
            }, 'user-1');
            expect(result.status).toBe(shared_1.AssignmentStatus.CREATED);
            expect(mockDataSource.transaction).toHaveBeenCalled();
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
    });
    describe('transition', () => {
        it('should throw BadRequestException if transition is invalid', async () => {
            const mockAssignment = {
                id: 'asn-123',
                status: shared_1.AssignmentStatus.CREATED,
                projectBranch: { id: 'pb-1', branch: { state: 'MH' } },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);
            await expect(service.transition('asn-123', shared_1.AssignmentStatus.SCHEDULED, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should transition from CREATED to CANDIDATE_SELECTED', async () => {
            const mockAssignment = {
                id: 'asn-123',
                status: shared_1.AssignmentStatus.CREATED,
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.PLANNING, branch: { state: 'MH' } },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);
            mockAssignmentRepo.save.mockImplementation((arg) => Promise.resolve(arg));
            const result = await service.transition('asn-123', shared_1.AssignmentStatus.CANDIDATE_SELECTED, 'user-1');
            expect(result.status).toBe(shared_1.AssignmentStatus.CANDIDATE_SELECTED);
        });
    });
    describe('update', () => {
        it('should throw BadRequestException if assignment is locked (ACCEPTED status)', async () => {
            const mockAssignment = {
                id: 'asn-123',
                status: shared_1.AssignmentStatus.ACCEPTED,
                projectBranch: { id: 'pb-1' },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);
            await expect(service.update('asn-123', { proposedFee: 600 }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
    });
    describe('SLA and Notifications validation', () => {
        it('should calculate SLA due date based on client configuration in create', async () => {
            const mockBranch = {
                id: 'pb-1',
                projectId: 'p-1',
                branch: { name: 'Branch 1', state: 'MH' },
                project: {
                    client: {
                        configuration: {
                            maxResponseTimeHours: 48,
                        },
                    },
                },
            };
            const mockAssayer = { id: 'as-1', skills: [], certifications: [] };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
            mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
            mockHolidayService.isHoliday.mockResolvedValue(false);
            mockAssignmentRepo.findOne.mockResolvedValue(null);
            const mockCreatedAssignment = {
                id: 'asn-123',
                assignmentNumber: 'ASN-2026-1234',
                status: shared_1.AssignmentStatus.CREATED,
            };
            mockAssignmentRepo.create.mockImplementation((arg) => ({ ...mockCreatedAssignment, ...arg }));
            mockAssignmentRepo.save.mockImplementation((arg) => Promise.resolve(arg));
            const result = await service.create({
                projectBranchId: 'pb-1',
                assayerId: 'as-1',
                proposedFee: 500,
                scheduledDate: '2026-08-01',
            }, 'user-1');
            expect(result.slaDueDate).toBeDefined();
            const expectedTime = new Date().getTime() + 48 * 60 * 60 * 1000;
            expect(Math.abs(result.slaDueDate.getTime() - expectedTime)).toBeLessThan(5000);
        });
        it('should trigger notification when transitioning to ACCEPTED status', async () => {
            const mockAssignment = {
                id: 'asn-123',
                assignmentNumber: 'ASN-2026-1234',
                status: shared_1.AssignmentStatus.CREATED,
                createdBy: 'creator-user',
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.PLANNING, branch: { state: 'MH' } },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);
            mockAssignmentRepo.save.mockImplementation((arg) => Promise.resolve(arg));
            await service.transition('asn-123', shared_1.AssignmentStatus.ACCEPTED, 'user-1');
            expect(mockNotificationService.create).toHaveBeenCalledWith(expect.objectContaining({
                userId: 'creator-user',
                title: 'Assignment Accepted',
            }), 'user-1');
        });
    });
});
//# sourceMappingURL=assignment.service.spec.js.map