"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const branch_service_1 = require("./branch.service");
const branch_entity_1 = require("./branch.entity");
const branch_contact_entity_1 = require("./branch-contact.entity");
const branch_document_entity_1 = require("./branch-document.entity");
const client_service_1 = require("../client/client.service");
const zone_entity_1 = require("../zone/zone.entity");
const geo_entities_1 = require("../geo/geo.entities");
const audit_service_1 = require("../../core/audit/audit.service");
describe('BranchService', () => {
    let service;
    const mockBranchRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        createQueryBuilder: jest.fn(),
    };
    const mockContactRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
        update: jest.fn(),
    };
    const mockDocumentRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
    };
    const mockZoneRepo = {
        findOne: jest.fn(),
    };
    const mockStateRepo = { findOne: jest.fn() };
    const mockDistrictRepo = { findOne: jest.fn() };
    const mockCityRepo = { findOne: jest.fn() };
    const mockClientService = { findOne: jest.fn() };
    const mockAuditService = { recordEvent: jest.fn() };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                branch_service_1.BranchService,
                { provide: (0, typeorm_1.getRepositoryToken)(branch_entity_1.BranchEntity), useValue: mockBranchRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(branch_contact_entity_1.BranchContactEntity), useValue: mockContactRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(branch_document_entity_1.BranchDocumentEntity), useValue: mockDocumentRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(zone_entity_1.ZoneEntity), useValue: mockZoneRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(geo_entities_1.GeoStateEntity), useValue: mockStateRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(geo_entities_1.GeoDistrictEntity), useValue: mockDistrictRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(geo_entities_1.GeoCityEntity), useValue: mockCityRepo },
                { provide: client_service_1.ClientService, useValue: mockClientService },
                { provide: audit_service_1.AuditService, useValue: mockAuditService },
            ],
        }).compile();
        service = module.get(branch_service_1.BranchService);
        jest.clearAllMocks();
    });
    describe('create', () => {
        it('should throw an error if state validation fails', async () => {
            mockStateRepo.findOne.mockResolvedValue(null);
            await expect(service.create({
                branchCode: 'B-1',
                name: 'Branch 1',
                address: 'Add 1',
                state: 'UnknownState',
                district: 'D-1',
                city: 'C-1',
            }, 'user-1')).rejects.toThrow(/State 'UnknownState' not found/);
        });
        it('should successfully create a branch if geography validation passes', async () => {
            mockStateRepo.findOne.mockResolvedValue({ id: 's-1', name: 'MH' });
            mockDistrictRepo.findOne.mockResolvedValue({ id: 'd-1', name: 'Pune', stateId: 's-1' });
            mockCityRepo.findOne.mockResolvedValue({ id: 'c-1', name: 'Pune City', districtId: 'd-1' });
            const mockCreatedBranch = {
                id: 'b-123',
                branchCode: 'B-1',
                name: 'Pune Branch',
            };
            mockBranchRepo.create.mockReturnValue(mockCreatedBranch);
            mockBranchRepo.save.mockResolvedValue(mockCreatedBranch);
            const result = await service.create({
                branchCode: 'B-1',
                name: 'Pune Branch',
                address: '123 Main St',
                state: 'MH',
                district: 'Pune',
                city: 'Pune City',
            }, 'user-1');
            expect(result.branchCode).toBe('B-1');
            expect(mockBranchRepo.save).toHaveBeenCalled();
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
    });
    describe('findOne', () => {
        it('should throw NotFoundException if branch does not exist', async () => {
            mockBranchRepo.findOne.mockResolvedValue(null);
            await expect(service.findOne('non-existent-id')).rejects.toThrow(common_1.NotFoundException);
        });
    });
});
//# sourceMappingURL=branch.service.spec.js.map