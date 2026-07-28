import { Test, TestingModule } from '@nestjs/testing';
import { FieldOperationsService } from './field-operations.service';
import { FieldVisitEntity, FieldVisitStatus } from './field-visit.entity';
import { FieldIncidentEntity, IncidentStatus, IncidentSeverity } from './field-incident.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('FieldOperationsService', () => {
  let service: FieldOperationsService;

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FieldOperationsService,
        { provide: getRepositoryToken(FieldVisitEntity), useValue: mockVisitRepository },
        { provide: getRepositoryToken(FieldIncidentEntity), useValue: mockIncidentRepository },
      ],
    }).compile();

    service = module.get<FieldOperationsService>(FieldOperationsService);
    jest.clearAllMocks();
  });

  it('should initialize a field visit and transition state lifecycle', async () => {
    const visit = await service.createFieldVisit('cp-1', 'eg-1', 'b-1', 'as-1', '2026-07-25');
    expect(visit.status).toBe(FieldVisitStatus.READY);

    mockVisitRepository.findOne.mockResolvedValue(visit);
    const inProgress = await service.transitionVisitStatus('v-1', FieldVisitStatus.AUDIT_STARTED);
    expect(inProgress.status).toBe(FieldVisitStatus.AUDIT_STARTED);
    expect(inProgress.actualStartTime).toBeDefined();
  });

  it('should register and resolve field incidents', async () => {
    mockVisitRepository.findOne.mockResolvedValue({ id: 'v-1' });
    const incident = await service.reportIncident('v-1', 'Closed Branch', 'Branch was closed today', IncidentSeverity.HIGH);
    expect(incident.title).toBe('Closed Branch');

    mockIncidentRepository.findOne.mockResolvedValue(incident);
    const resolved = await service.resolveIncident('i-1', 'Rescheduled for tomorrow morning');
    expect(resolved.status).toBe(IncidentStatus.RESOLVED);
  });

  it('should output OCR handover package for submitted visits', async () => {
    const visit = {
      id: 'v-1',
      branchId: 'b-1',
      assayerId: 'as-1',
      status: FieldVisitStatus.SUBMITTED,
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
