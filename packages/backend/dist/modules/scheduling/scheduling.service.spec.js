"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const scheduling_service_1 = require("./scheduling.service");
const schedule_entity_1 = require("./schedule.entity");
const assignment_service_1 = require("../assignment/assignment.service");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const constraint_evaluator_1 = require("../planning/constraint.evaluator");
const shared_1 = require("@fapoms/shared");
describe('SchedulingService', () => {
    let service;
    let scheduleRepo;
    let assignmentService;
    let holidayService;
    const mockScheduleRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        findAndCount: jest.fn(),
    };
    const mockAssignmentService = {
        findOne: jest.fn(),
        scheduleAudit: jest.fn().mockResolvedValue(undefined),
    };
    const mockHolidayService = {
        isHoliday: jest.fn(),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
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
                scheduling_service_1.SchedulingService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(schedule_entity_1.ScheduleEntity),
                    useValue: mockScheduleRepo,
                },
                {
                    provide: assignment_service_1.AssignmentService,
                    useValue: mockAssignmentService,
                },
                {
                    provide: holiday_service_1.HolidayService,
                    useValue: mockHolidayService,
                },
                {
                    provide: audit_service_1.AuditService,
                    useValue: mockAuditService,
                },
                {
                    provide: constraint_evaluator_1.ConstraintEvaluator,
                    useValue: mockConstraintEvaluator,
                },
            ],
        }).compile();
        service = module.get(scheduling_service_1.SchedulingService);
        scheduleRepo = module.get((0, typeorm_1.getRepositoryToken)(schedule_entity_1.ScheduleEntity));
        assignmentService = module.get(assignment_service_1.AssignmentService);
        holidayService = module.get(holiday_service_1.HolidayService);
        jest.clearAllMocks();
    });
    describe('create', () => {
        it('should throw NotFoundException if assignment is missing', async () => {
            mockAssignmentService.findOne.mockResolvedValue(null);
            await expect(service.create({ assignmentId: 'asn-missing', scheduledDate: '2026-08-01' }, 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
        it('should throw BadRequestException if assignment status is not ACCEPTED', async () => {
            const mockAsn = { id: 'asn-1', status: shared_1.AssignmentStatus.CREATED };
            mockAssignmentService.findOne.mockResolvedValue(mockAsn);
            await expect(service.create({ assignmentId: 'asn-1', scheduledDate: '2026-08-01' }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should throw BadRequestException if assayer is on leave', async () => {
            const mockAsn = {
                id: 'asn-1',
                status: shared_1.AssignmentStatus.ACCEPTED,
                assayer: {
                    leaves: [{ startDate: '2026-08-01', endDate: '2026-08-05' }],
                },
            };
            mockAssignmentService.findOne.mockResolvedValue(mockAsn);
            mockConstraintEvaluator.checkLeaves.mockReturnValueOnce({ passed: false, reason: 'Assayer is on leave' });
            await expect(service.create({ assignmentId: 'asn-1', scheduledDate: '2026-08-03' }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should throw BadRequestException if scheduled date is outside project timeline', async () => {
            const mockAsn = {
                id: 'asn-1',
                status: shared_1.AssignmentStatus.ACCEPTED,
                assayer: { leaves: [] },
                project: {
                    startDate: '2026-08-05',
                    endDate: '2026-08-10',
                },
            };
            mockAssignmentService.findOne.mockResolvedValue(mockAsn);
            mockConstraintEvaluator.checkProjectTimeline.mockReturnValueOnce({ passed: false, reason: 'Outside project timeline' });
            await expect(service.create({ assignmentId: 'asn-1', scheduledDate: '2026-08-03' }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
    });
});
//# sourceMappingURL=scheduling.service.spec.js.map