"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const scheduling_service_1 = require("./scheduling.service");
const schedule_entity_1 = require("./schedule.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const holiday_service_1 = require("../holiday/holiday.service");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
describe('SchedulingService', () => {
    let service;
    let scheduleRepo;
    let assignmentRepo;
    let holidayService;
    const mockScheduleRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        findAndCount: jest.fn(),
    };
    const mockAssignmentRepo = {
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
                scheduling_service_1.SchedulingService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(schedule_entity_1.ScheduleEntity),
                    useValue: mockScheduleRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity),
                    useValue: mockAssignmentRepo,
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
        service = module.get(scheduling_service_1.SchedulingService);
        scheduleRepo = module.get((0, typeorm_1.getRepositoryToken)(schedule_entity_1.ScheduleEntity));
        assignmentRepo = module.get((0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity));
        holidayService = module.get(holiday_service_1.HolidayService);
        jest.clearAllMocks();
    });
    describe('create', () => {
        it('should throw NotFoundException if assignment is missing', async () => {
            mockAssignmentRepo.findOne.mockResolvedValue(null);
            await expect(service.create({ assignmentId: 'asn-missing', scheduledDate: '2026-08-01' }, 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
        it('should throw BadRequestException if assignment status is not ACCEPTED', async () => {
            const mockAsn = { id: 'asn-1', status: shared_1.AssignmentStatus.CREATED };
            mockAssignmentRepo.findOne.mockResolvedValue(mockAsn);
            await expect(service.create({ assignmentId: 'asn-1', scheduledDate: '2026-08-01' }, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
    });
});
//# sourceMappingURL=scheduling.service.spec.js.map