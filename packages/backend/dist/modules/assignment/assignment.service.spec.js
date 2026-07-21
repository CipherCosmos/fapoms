"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const assignment_service_1 = require("./assignment.service");
const assignment_entity_1 = require("./assignment.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
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
    const mockHolidayService = {
        isHoliday: jest.fn(),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
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
                    provide: holiday_service_1.HolidayService,
                    useValue: mockHolidayService,
                },
                {
                    provide: audit_service_1.AuditService,
                    useValue: mockAuditService,
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
        it('should throw BadRequestException if date is a holiday', async () => {
            const mockBranch = { id: 'pb-1', branch: { state: 'MH' } };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
            mockHolidayService.isHoliday.mockResolvedValue(true);
            await expect(service.create({
                projectBranchId: 'pb-1',
                assayerId: 'as-1',
                proposedFee: 500,
                scheduledDate: '2026-08-01',
            }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should throw ConflictException if assayer is double-booked', async () => {
            const mockBranch = { id: 'pb-1', branch: { state: 'MH' } };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
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
            const mockBranch = { id: 'pb-1', projectId: 'p-1', branch: { name: 'Branch 1', state: 'MH' } };
            mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
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
            expect(mockProjectBranchRepo.save).toHaveBeenCalled();
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
    });
    describe('transition', () => {
        it('should throw BadRequestException if transition is invalid', async () => {
            const mockAssignment = {
                id: 'asn-123',
                status: shared_1.AssignmentStatus.CREATED,
                projectBranch: { id: 'pb-1' },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);
            await expect(service.transition('asn-123', shared_1.AssignmentStatus.SCHEDULED, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should transition from CREATED to CANDIDATE_SELECTED', async () => {
            const mockAssignment = {
                id: 'asn-123',
                status: shared_1.AssignmentStatus.CREATED,
                projectBranch: { id: 'pb-1', status: shared_1.ProjectBranchStatus.PLANNING },
            };
            mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);
            mockAssignmentRepo.save.mockImplementation((arg) => Promise.resolve(arg));
            const result = await service.transition('asn-123', shared_1.AssignmentStatus.CANDIDATE_SELECTED, 'user-1');
            expect(result.status).toBe(shared_1.AssignmentStatus.CANDIDATE_SELECTED);
        });
    });
});
//# sourceMappingURL=assignment.service.spec.js.map