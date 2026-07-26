"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const field_operations_service_1 = require("./field-operations.service");
const field_visit_entity_1 = require("./field-visit.entity");
const field_incident_entity_1 = require("./field-incident.entity");
const typeorm_1 = require("@nestjs/typeorm");
describe('FieldOperationsService', () => {
    let service;
    const mockVisitRepository = {
        create: jest.fn().mockImplementation((arg) => arg),
        save: jest.fn((arg) => Promise.resolve({ id: 'v-1', ...arg })),
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn(),
    };
    const mockIncidentRepository = {
        create: jest.fn().mockImplementation((arg) => arg),
        save: jest.fn((arg) => Promise.resolve({ id: 'i-1', ...arg })),
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                field_operations_service_1.FieldOperationsService,
                { provide: (0, typeorm_1.getRepositoryToken)(field_visit_entity_1.FieldVisitEntity), useValue: mockVisitRepository },
                { provide: (0, typeorm_1.getRepositoryToken)(field_incident_entity_1.FieldIncidentEntity), useValue: mockIncidentRepository },
            ],
        }).compile();
        service = module.get(field_operations_service_1.FieldOperationsService);
        jest.clearAllMocks();
    });
    it('should initialize a field visit and transition state lifecycle', async () => {
        const visit = await service.createFieldVisit('cp-1', 'eg-1', 'b-1', 'as-1', '2026-07-25');
        expect(visit.status).toBe(field_visit_entity_1.FieldVisitStatus.READY);
        mockVisitRepository.findOne.mockResolvedValue(visit);
        const inProgress = await service.transitionVisitStatus('v-1', field_visit_entity_1.FieldVisitStatus.AUDIT_STARTED);
        expect(inProgress.status).toBe(field_visit_entity_1.FieldVisitStatus.AUDIT_STARTED);
        expect(inProgress.actualStartTime).toBeDefined();
    });
    it('should register and resolve field incidents', async () => {
        mockVisitRepository.findOne.mockResolvedValue({ id: 'v-1' });
        const incident = await service.reportIncident('v-1', 'Closed Branch', 'Branch was closed today', field_incident_entity_1.IncidentSeverity.HIGH);
        expect(incident.title).toBe('Closed Branch');
        mockIncidentRepository.findOne.mockResolvedValue(incident);
        const resolved = await service.resolveIncident('i-1', 'Rescheduled for tomorrow morning');
        expect(resolved.status).toBe(field_incident_entity_1.IncidentStatus.RESOLVED);
    });
    it('should output OCR handover package for submitted visits', async () => {
        const visit = {
            id: 'v-1',
            branchId: 'b-1',
            assayerId: 'as-1',
            status: field_visit_entity_1.FieldVisitStatus.SUBMITTED,
            evidenceReadiness: {
                formsCompleted: true,
                photosCollected: true,
            },
        };
        mockVisitRepository.findOne.mockResolvedValue(visit);
        const pkg = await service.generateHandoverPackage('v-1');
        expect(pkg.visitId).toBe('v-1');
        expect(pkg.evidenceMetadata.hasFormPayload).toBe(true);
    });
});
//# sourceMappingURL=field-operations.service.spec.js.map