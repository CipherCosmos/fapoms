import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { AssayerService } from './assayer.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { NotificationService } from '../notifications/notification.service';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { CacheService } from '../../infrastructure/cache/cache.service';
import {
  AssayerLifecycleStatus,
  AssayerStatus,
  ASSAYER_ERROR_CODES,
} from '@fapoms/shared';

describe('Strict Activation Gate', () => {
  let service: AssayerService;

  const fullyQualifiedCandidate = (): Partial<AssayerEntity> => ({
    id: 'asr-1',
    assayerCode: 'AS0001',
    displayName: 'Rahul Sharma',
    lifecycleStatus: AssayerLifecycleStatus.TRAINING,
    status: AssayerStatus.INACTIVE,
    isActive: true,
    panNumber: 'ABCDE1234F',
    bankAccountNumber: '123456789012',
    ifscCode: 'HDFC0001234',
    latitude: 19.076,
    longitude: 72.877,
  });

  const mockAssayerRepo = {
    findOne: jest.fn(),
    save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: { count: jest.fn().mockResolvedValue(0), query: jest.fn().mockResolvedValue([]) },
    metadata: {
      findColumnWithPropertyName: () => ({ propertyName: 'id', isNullable: true }),
    },
  };

  const mockDataSource = {
    query: jest.fn().mockResolvedValue([[], 0]),
  };

  const mockWorkflowEngine = {
    registerWorkflow: jest.fn(),
    executeCommand: jest.fn().mockImplementation(async (_k, _id, _cmd, _from, _to, _uid, _r, _rs, action) => action()),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: { create: jest.fn() } },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: { create: jest.fn(), save: jest.fn().mockResolvedValue({}) } },
        { provide: AuditService, useValue: { recordEvent: jest.fn() } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn().mockResolvedValue(undefined) } },
        { provide: WorkflowEngine, useValue: mockWorkflowEngine },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: NotificationService, useValue: { notifyAssayer: jest.fn().mockResolvedValue({ inAppDelivered: true }) } },
        { provide: EmailProvider, useValue: { send: jest.fn().mockResolvedValue({ success: false }) } },
        { provide: SmsProvider, useValue: { send: jest.fn().mockResolvedValue(false) } },
        { provide: UnitOfWork, useValue: { withTransaction: jest.fn().mockImplementation((fn: any) => fn({} as any)) } },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: CacheService, useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() } },
      ],
    }).compile();

    service = module.get<AssayerService>(AssayerService);
  });

  describe('Payout-Readiness Gate', () => {
    it('refuses activation when PAN is missing', async () => {
      const assayer = { ...fullyQualifiedCandidate(), panNumber: undefined };
      mockAssayerRepo.findOne.mockResolvedValue(assayer);

      let caughtErr: any;
      try {
        await service.activateAssayer('asr-1', 'user-1');
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(BadRequestException);
      expect((caughtErr.getResponse() as any)?.code).toBe(ASSAYER_ERROR_CODES.PAYOUT_NOT_ELIGIBLE);
      expect(caughtErr.message).toContain('PAN');
    });

    it('refuses activation when bank account number is missing', async () => {
      const assayer = { ...fullyQualifiedCandidate(), bankAccountNumber: undefined };
      mockAssayerRepo.findOne.mockResolvedValue(assayer);

      let caughtErr: any;
      try {
        await service.activateAssayer('asr-1', 'user-1');
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(BadRequestException);
      expect((caughtErr.getResponse() as any)?.code).toBe(ASSAYER_ERROR_CODES.PAYOUT_NOT_ELIGIBLE);
      expect(caughtErr.message).toContain('Bank account');
    });

    it('refuses activation when IFSC code is missing', async () => {
      const assayer = { ...fullyQualifiedCandidate(), ifscCode: undefined };
      mockAssayerRepo.findOne.mockResolvedValue(assayer);

      let caughtErr: any;
      try {
        await service.activateAssayer('asr-1', 'user-1');
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(BadRequestException);
      expect((caughtErr.getResponse() as any)?.code).toBe(ASSAYER_ERROR_CODES.PAYOUT_NOT_ELIGIBLE);
      expect(caughtErr.message).toContain('IFSC');
    });

    it('names multiple missing payout fields together', async () => {
      const assayer = {
        ...fullyQualifiedCandidate(),
        panNumber: undefined,
        bankAccountNumber: undefined,
        ifscCode: undefined,
      };
      mockAssayerRepo.findOne.mockResolvedValue(assayer);

      let caughtErr: any;
      try {
        await service.activateAssayer('asr-1', 'user-1');
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(BadRequestException);
      expect((caughtErr.getResponse() as any)?.code).toBe(ASSAYER_ERROR_CODES.PAYOUT_NOT_ELIGIBLE);
      expect(caughtErr.message).toContain('PAN and Bank account and IFSC');
    });
  });

  describe('Location Gate', () => {
    it('refuses activation when latitude is missing', async () => {
      const assayer = { ...fullyQualifiedCandidate(), latitude: null as any };
      mockAssayerRepo.findOne.mockResolvedValue(assayer);

      let caughtErr: any;
      try {
        await service.activateAssayer('asr-1', 'user-1');
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(BadRequestException);
      expect((caughtErr.getResponse() as any)?.code).toBe(ASSAYER_ERROR_CODES.LOCATION_MISSING);
      expect(caughtErr.message).toContain('no map coordinates');
    });

    it('refuses activation when longitude is missing', async () => {
      const assayer = { ...fullyQualifiedCandidate(), longitude: null as any };
      mockAssayerRepo.findOne.mockResolvedValue(assayer);

      let caughtErr: any;
      try {
        await service.activateAssayer('asr-1', 'user-1');
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(BadRequestException);
      expect((caughtErr.getResponse() as any)?.code).toBe(ASSAYER_ERROR_CODES.LOCATION_MISSING);
    });
  });

  describe('Successful Activation', () => {
    it('successfully activates an assayer with all required payout and location data', async () => {
      const assayer = fullyQualifiedCandidate();
      mockAssayerRepo.findOne.mockResolvedValue(assayer);

      const result = await service.activateAssayer('asr-1', 'user-1');

      expect(result.lifecycleStatus).toBe(AssayerLifecycleStatus.ACTIVE);
      expect(result.status).toBe(AssayerStatus.ACTIVE);
    });
  });
});
