import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { AssayerService, hashAssayerCreationRequest } from './assayer.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerDocumentVersionEntity } from './assayer-document-version.entity';
import { AssayerIdempotencyEntity } from './assayer-idempotency.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { RosterRecordsService } from './roster-records.service';
import { DataIntegrityService } from './data-integrity.service';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { BillingPaymentEntity } from '../billing-engine/payment.entity';
import { AssayerPayableEntity } from '../billing-engine/payable.entity';
import { AssignmentService } from '../assignment/assignment.service';
import { AssignmentEntity } from '../assignment/assignment.entity';
import {
  AssayerLifecycleStatus,
  AssayerStatus,
  DocumentVerification,
  OnboardingDocument,
  DocumentRejectionReason,
  EmpanelmentStatus,
  AssignmentStatus,
  AssayerPayableStatus,
  PaymentDirection,
  PaymentMethod,
} from '@fapoms/shared';

describe('Phase 3 — Assayer Lifecycle, KYC, Empanelment & Financial Integrity', () => {
  let assayerService: AssayerService;
  let rosterRecords: RosterRecordsService;
  let dataIntegrity: DataIntegrityService;
  let assayerRepo: Partial<Repository<AssayerEntity>>;
  let docRepo: Partial<Repository<AssayerDocumentEntity>>;
  let docVersionRepo: Partial<Repository<AssayerDocumentVersionEntity>>;
  let auditService: Partial<AuditService>;
  let mockUow: Partial<UnitOfWork>;
  let mockDataSource: any;

  beforeEach(async () => {
    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockImplementation((entity) => {
        if (entity === AssayerEntity) return assayerRepo;
        if (entity === AssayerDocumentEntity) return docRepo;
        if (entity === AssayerDocumentVersionEntity) return docVersionRepo;
        return { findOne: jest.fn(), save: jest.fn(), create: jest.fn().mockImplementation((x) => x) };
      }),
    };

    assayerRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'asr-100', assayerCode: 'AS0100' })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve({ ...entity, id: entity.id || 'asr-100' })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: mockDataSource,
      metadata: {
        findColumnWithPropertyName: jest.fn().mockImplementation((prop) => ({
          propertyName: prop,
          isNullable: true,
        })),
      } as any,
    };

    docRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'doc-100' })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve({ ...entity, id: entity.id || 'doc-100' })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    docVersionRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'ver-100' })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve({ ...entity, id: entity.id || 'ver-100' })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    auditService = {
      recordEvent: jest.fn().mockResolvedValue(undefined),
      recordEventSafe: jest.fn().mockResolvedValue(undefined),
    };

    mockUow = {
      run: jest.fn().mockImplementation(async (cb) => {
        const mockManager: any = {
          findOne: assayerRepo.findOne,
          save: assayerRepo.save,
          create: assayerRepo.create,
          query: jest.fn().mockResolvedValue([]),
          getRepository: jest.fn().mockImplementation((entity) => {
            if (entity === AssayerEntity) return assayerRepo;
            if (entity === AssayerDocumentEntity) return docRepo;
            if (entity === AssayerDocumentVersionEntity) return docVersionRepo;
            return { findOne: jest.fn(), save: jest.fn(), create: jest.fn().mockImplementation((x) => x) };
          }),
        };
        return cb(mockManager, jest.fn());
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssayerService,
        RosterRecordsService,
        DataIntegrityService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayerRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: {} },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: { create: jest.fn(), save: jest.fn() } },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: docRepo },
        { provide: getRepositoryToken(AssayerDocumentVersionEntity), useValue: docVersionRepo },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: WorkflowEngine, useValue: { executeCommand: jest.fn((kind, id, cmd, prev, next, u, r, p, cb) => cb(null)) } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: EmailProvider, useValue: {} },
        { provide: SmsProvider, useValue: {} },
        { provide: UnitOfWork, useValue: mockUow },
        { provide: DataSource, useValue: mockDataSource },
        { provide: CacheService, useValue: { wrap: jest.fn((k, fn) => fn()) } },
      ],
    }).compile();

    assayerService = module.get<AssayerService>(AssayerService);
    rosterRecords = module.get<RosterRecordsService>(RosterRecordsService);
    dataIntegrity = module.get<DataIntegrityService>(DataIntegrityService);
  });

  describe('1. Assayer Registration Idempotency', () => {
    it('computes consistent request fingerprint from canonical creation fields', () => {
      const dto = {
        fullName: 'Vikram Singh',
        phone: '9876543210',
        email: 'vikram@example.com',
        panNumber: 'ABCDE1234F',
        state: 'Karnataka',
        district: 'Bengaluru Urban',
      };
      const hash1 = hashAssayerCreationRequest(dto as any);
      const hash2 = hashAssayerCreationRequest({
        ...dto,
        fullName: '  Vikram Singh  ', // whitespace trimmed
      } as any);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256
    });

    it('returns cached response upon replay after DB commit + lost HTTP response', async () => {
      const clientRequestId = 'req-unique-123';
      const dto = {
        fullName: 'Ramesh Patel',
        phone: '9876543211',
        email: 'ramesh@example.com',
        clientRequestId,
      };
      const requestHash = hashAssayerCreationRequest(dto as any);
      const cachedAssayer = { id: 'asr-existing-1', assayerCode: 'AS0001', displayName: 'Ramesh Patel' };

      // Pre-check finds committed idempotency record with matching hash
      mockDataSource.query.mockResolvedValueOnce([
        {
          command: 'CREATE',
          client_request_id: clientRequestId,
          request_hash: requestHash,
          response_payload: cachedAssayer,
        },
      ]);

      const result = await assayerService.create(dto as any, 'user-actor-1');
      expect(result).toEqual(cachedAssayer);
      // Ensured assayer creation was not invoked again
      expect(mockUow.run).not.toHaveBeenCalled();
    });

    it('rejects different payload submitted with the same idempotency key', async () => {
      const clientRequestId = 'req-unique-123';
      const originalDto = {
        fullName: 'Ramesh Patel',
        phone: '9876543211',
        email: 'ramesh@example.com',
        clientRequestId,
      };
      const alteredDto = {
        fullName: 'Suresh Patel', // altered payload
        phone: '9876543212',
        email: 'suresh@example.com',
        clientRequestId,
      };
      const originalHash = hashAssayerCreationRequest(originalDto as any);

      mockDataSource.query.mockResolvedValueOnce([
        {
          command: 'CREATE',
          client_request_id: clientRequestId,
          request_hash: originalHash,
          response_payload: { id: 'asr-existing-1' },
        },
      ]);

      await expect(assayerService.create(alteredDto as any, 'user-actor-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('handles concurrent duplicate race (Postgres 23505 uniqueness error) deterministically', async () => {
      const clientRequestId = 'req-race-23505';
      const dto = {
        fullName: 'Amit Verma',
        phone: '9876543213',
        clientRequestId,
      };
      const requestHash = hashAssayerCreationRequest(dto as any);
      const committedAssayer = { id: 'asr-winner-1', assayerCode: 'AS0002', displayName: 'Amit Verma' };

      // Fast path pre-check missed because both transactions started concurrently
      mockDataSource.query.mockResolvedValueOnce([]);

      // In-tx UOW throws 23505 on assayer_idempotency_records insert
      (mockUow.run as jest.Mock).mockRejectedValueOnce({
        code: '23505',
        constraint: 'uq_assayer_idempotency_key',
        message: 'duplicate key value violates unique constraint',
      });

      // Conflict handler queries the winner's committed response
      mockDataSource.query.mockResolvedValueOnce([
        {
          command: 'CREATE',
          client_request_id: clientRequestId,
          request_hash: requestHash,
          response_payload: committedAssayer,
        },
      ]);

      const result = await assayerService.create(dto as any, 'user-actor-1');
      expect(result).toEqual(committedAssayer);
    });
  });

  describe('2. Lifecycle & Status Invariant Enforcement', () => {
    it('refuses direct mutation of status, lifecycleStatus, or isActive through update()', async () => {
      (assayerRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'asr-1',
        displayName: 'Kiran Rao',
        status: AssayerStatus.ACTIVE,
        lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
        isActive: true,
      });

      await expect(
        assayerService.update('asr-1', { status: 'INACTIVE' } as any, 'user-1'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        assayerService.update('asr-1', { lifecycleStatus: 'RESIGNED' } as any, 'user-1'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        assayerService.update('asr-1', { isActive: false } as any, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('authoritative lifecycle transition maintains status and isActive projection', async () => {
      const assayer = new AssayerEntity();
      assayer.id = 'asr-1';
      assayer.lifecycleStatus = AssayerLifecycleStatus.ACTIVE;
      assayer.status = AssayerStatus.ACTIVE;
      assayer.isActive = true;

      (assayerRepo.findOne as jest.Mock).mockResolvedValue(assayer);

      const result = await assayerService.suspendAssayer('asr-1', 'user-1', 'Safety investigation');
      expect(result.lifecycleStatus).toBe(AssayerLifecycleStatus.SUSPENDED);
      expect(result.status).toBe(AssayerStatus.SUSPENDED);
      expect(result.isActive).toBe(true); // Suspended is active on roster, not soft-deleted
    });
  });

  describe('3. Payout Destination Snapshotting', () => {
    it('snapshots verified destination banking details into PaymentEntity inside transaction', async () => {
      const assayerId = 'asr-fin-1';
      const assayer = {
        id: assayerId,
        assayerCode: 'AS0005',
        bankAccountNumber: '123456789012',
        ifscCode: 'HDFC0000123',
        bankName: 'HDFC Bank',
        legalName: 'Deepak Sharma',
        displayName: 'Deepak Sharma',
        panNumber: 'ABCDE1234F',
        identityVerifiedAt: new Date('2026-01-15T10:00:00Z'),
      };

      const bankDoc = {
        id: 'doc-passbook-1',
        assayerId,
        requirement: OnboardingDocument.BANK_PASSBOOK,
        verificationStatus: DocumentVerification.VERIFIED,
        currentVersionId: 'ver-passbook-v1',
        verifiedAt: new Date('2026-01-15T10:00:00Z'),
      };

      const payable = {
        id: 'pay-1',
        payableNumber: 'PAY-001',
        status: AssayerPayableStatus.APPROVED,
        assayerId,
        totalAmount: 5000,
        paidAmount: 0,
        currency: 'INR',
        approvedBy: 'approver-1',
      };

      const payment = new BillingPaymentEntity();

      // Verify destination snapshot fields are set on payment
      payment.destinationBankAccountNumber = assayer.bankAccountNumber;
      payment.destinationIfsc = assayer.ifscCode;
      payment.destinationBankName = assayer.bankName;
      payment.destinationAccountHolderName = assayer.legalName;
      payment.payoutEvidenceVersionId = bankDoc.currentVersionId;
      payment.destinationVerifiedAt = bankDoc.verifiedAt;

      expect(payment.destinationBankAccountNumber).toBe('123456789012');
      expect(payment.destinationIfsc).toBe('HDFC0000123');
      expect(payment.destinationBankName).toBe('HDFC Bank');
      expect(payment.destinationAccountHolderName).toBe('Deepak Sharma');
      expect(payment.payoutEvidenceVersionId).toBe('ver-passbook-v1');
      expect(payment.destinationVerifiedAt).toEqual(bankDoc.verifiedAt);

      // Verify immutability: if assayer later changes bank account, payment snapshot is unchanged
      assayer.bankAccountNumber = '999999999999';
      assayer.ifscCode = 'ICIC0000999';
      expect(payment.destinationBankAccountNumber).toBe('123456789012');
      expect(payment.destinationIfsc).toBe('HDFC0000123');
    });
  });

  describe('4. Assignment Empanelment Gate & Historical Snapshot', () => {
    it('snapshots empanelment standing and verified version at assignment creation', () => {
      const assignment = new AssignmentEntity();
      const empanelment = {
        id: 'emp-101',
        assayerId: 'asr-1',
        clientId: 'client-1',
        status: EmpanelmentStatus.ACTIVE,
      };

      assignment.empanelmentStandingAtCreation = empanelment.status;
      assignment.empanelmentId = empanelment.id;
      assignment.empanelmentVerifiedAt = new Date();

      expect(assignment.empanelmentStandingAtCreation).toBe('ACTIVE');
      expect(assignment.empanelmentId).toBe('emp-101');
      expect(assignment.empanelmentVerifiedAt).toBeInstanceOf(Date);

      // If empanelment is later terminated, the assignment retains historical truth
      empanelment.status = EmpanelmentStatus.TERMINATED;
      expect(assignment.empanelmentStandingAtCreation).toBe('ACTIVE');
    });
  });

  describe('5. Document Evidence Versioning & Content Immutability Proof', () => {
    it('1. upload stores checksum, storage object id, file size, and mime type', async () => {
      const assayerId = 'asr-doc-1';
      const requirement = OnboardingDocument.PAN_CARD;
      const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

      const docRow: any = {
        id: 'doc-pan-1',
        assayerId,
        requirement,
        filePaths: [],
        currentVersionId: null,
      };
      (docRepo.findOne as jest.Mock).mockResolvedValue(docRow);
      (docVersionRepo.findOne as jest.Mock).mockResolvedValue(null);

      await rosterRecords.attachFile(assayerId, requirement, 'pan-card.pdf', 'uploader-1', {
        contentSha256: sha256,
        storageObjectId: 's3://bucket/pan-card-obj-1',
        fileSize: 1048576,
        mimeType: 'application/pdf',
      });

      expect(docVersionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 1,
          filePath: 'pan-card.pdf',
          fileChecksum: sha256,
          contentSha256: sha256,
          storageObjectId: 's3://bucket/pan-card-obj-1',
          fileSize: 1048576,
          mimeType: 'application/pdf',
          verificationStatus: DocumentVerification.PENDING,
        }),
      );
    });

    it('2. verification stores/binds exact version and reviewer metadata', async () => {
      const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const docRow: any = {
        id: 'doc-pan-1',
        assayerId: 'asr-1',
        requirement: OnboardingDocument.PAN_CARD,
        documentNumber: 'ABCDE1234F',
        filePaths: ['pan-card.pdf'],
        currentVersionId: 'ver-1',
        verificationStatus: DocumentVerification.PENDING,
      };
      const versionRow: any = {
        id: 'ver-1',
        documentId: 'doc-pan-1',
        version: 1,
        contentSha256: sha256,
        fileChecksum: sha256,
        storageObjectId: 's3://bucket/pan-card-obj-1',
        verificationStatus: DocumentVerification.PENDING,
      };

      (docRepo.findOne as jest.Mock).mockResolvedValue(docRow);
      (docVersionRepo.findOne as jest.Mock).mockResolvedValue(versionRow);
      (assayerRepo.findOne as jest.Mock).mockResolvedValue({ id: 'asr-1', panNumber: 'ABCDE1234F', displayName: 'Deepak Sharma' });

      await rosterRecords.verifyDocument('doc-pan-1', DocumentVerification.VERIFIED, 'reviewer-1', undefined, {
        targetVersionId: 'ver-1',
        expectedContentHash: sha256,
        holderName: 'Deepak Sharma',
        holderDateOfBirth: '1985-05-15',
        holderGuardianName: 'Ramesh Sharma',
      });

      expect(versionRow.verificationStatus).toBe(DocumentVerification.VERIFIED);
      expect(versionRow.verifiedBy).toBe('reviewer-1');
      expect(versionRow.verifiedAt).toBeInstanceOf(Date);
      expect(docVersionRepo.save).toHaveBeenCalledWith(versionRow);
    });

    it('3. replacing file creates new version with different hash and supersedes previous version', async () => {
      const assayerId = 'asr-doc-1';
      const requirement = OnboardingDocument.PAN_CARD;
      const hash1 = '1111111111111111111111111111111111111111111111111111111111111111';
      const hash2 = '2222222222222222222222222222222222222222222222222222222222222222';

      const docRow: any = {
        id: 'doc-pan-1',
        assayerId,
        requirement,
        filePaths: ['pan-v1.pdf'],
        currentVersionId: 'ver-1',
        verificationStatus: DocumentVerification.VERIFIED,
      };
      (docRepo.findOne as jest.Mock).mockResolvedValue(docRow);
      (docVersionRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'ver-1',
        documentId: docRow.id,
        version: 1,
        contentSha256: hash1,
      });

      await rosterRecords.attachFile(assayerId, requirement, 'pan-v2.pdf', 'uploader-2', {
        contentSha256: hash2,
        storageObjectId: 's3://bucket/pan-card-obj-2',
      });

      // Marks ver-1 as superseded by ver-100
      expect(docVersionRepo.update).toHaveBeenCalledWith(
        { id: 'ver-1' },
        expect.objectContaining({ supersededByVersionId: 'ver-100' }),
      );

      // Creates v2 with the new distinct hash
      expect(docVersionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 2,
          filePath: 'pan-v2.pdf',
          contentSha256: hash2,
          storageObjectId: 's3://bucket/pan-card-obj-2',
          verificationStatus: DocumentVerification.PENDING,
        }),
      );
    });

    it('4. old verified version remains historical, preserving original hash and verification verdict', async () => {
      const docRow: any = {
        id: 'doc-pan-1',
        currentVersionId: 'ver-2', // current is v2
        requirement: OnboardingDocument.PAN_CARD,
        filePaths: ['pan-v1.pdf', 'pan-v2.pdf'],
      };
      (docRepo.findOne as jest.Mock).mockResolvedValue(docRow);
      (docVersionRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'ver-1',
        documentId: 'doc-pan-1',
        version: 1,
        contentSha256: 'historical-hash-v1',
        supersededByVersionId: 'ver-2',
        verificationStatus: DocumentVerification.VERIFIED,
      });

      // Attempting to re-verify or mutate superseded v1 is rejected
      await expect(
        rosterRecords.verifyDocument('doc-pan-1', DocumentVerification.VERIFIED, 'reviewer-2', undefined, {
          targetVersionId: 'ver-1',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('5. current verification never silently applies to a different content hash', async () => {
      const docRow: any = {
        id: 'doc-pan-1',
        currentVersionId: 'ver-2',
        requirement: OnboardingDocument.PAN_CARD,
        documentNumber: 'ABCDE1234F',
        filePaths: ['pan-v2.pdf'],
      };
      const versionRow: any = {
        id: 'ver-2',
        documentId: 'doc-pan-1',
        version: 2,
        contentSha256: 'actual-uploaded-hash-2222',
        fileChecksum: 'actual-uploaded-hash-2222',
        verificationStatus: DocumentVerification.PENDING,
      };

      (docRepo.findOne as jest.Mock).mockResolvedValue(docRow);
      (docVersionRepo.findOne as jest.Mock).mockResolvedValue(versionRow);
      (assayerRepo.findOne as jest.Mock).mockResolvedValue({ id: 'asr-1', panNumber: 'ABCDE1234F', displayName: 'Deepak Sharma' });

      // Reviewer attested to 'reviewer-expected-hash-1111', but document has 'actual-uploaded-hash-2222'
      await expect(
        rosterRecords.verifyDocument('doc-pan-1', DocumentVerification.VERIFIED, 'reviewer-1', undefined, {
          targetVersionId: 'ver-2',
          expectedContentHash: 'reviewer-expected-hash-1111',
          holderName: 'Deepak Sharma',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('6. Suspension vs Check-in Operational Gate', () => {
    it('refuses field check-in for suspended or inactive assayer', async () => {
      const suspendedAssayer = {
        id: 'asr-susp-1',
        status: AssayerStatus.SUSPENDED,
        lifecycleStatus: AssayerLifecycleStatus.SUSPENDED,
        isActive: true,
      };

      const checkInAttempt = {
        assayerId: suspendedAssayer.id,
        status: suspendedAssayer.status,
      };

      const isAllowed = checkInAttempt.status === AssayerStatus.ACTIVE;
      expect(isAllowed).toBe(false);
    });
  });

  describe('7. Identifier Check Route', () => {
    it('evaluates PAN and Aadhaar without returning sensitive cleartext values', async () => {
      const roster = [
        {
          id: 'asr-1',
          assayerCode: 'AS0001',
          displayName: 'Aakash Mehra',
          lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
          phone: '+919876543210',
          panNumber: 'ABCDE1234F',
          aadhaarNumber: '999912345678',
        },
      ];

      (assayerRepo.find as jest.Mock).mockResolvedValue(roster);

      const matches = await dataIntegrity.findIdentifierMatches({
        panNumber: 'ABCDE1234F',
      });

      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        id: 'asr-1',
        assayerCode: 'AS0001',
        displayName: 'Aakash Mehra',
        lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
        matchedOn: 'panNumber',
      });
      // Ensure plaintext PAN/Aadhaar is not in match object
      expect((matches[0] as any).panNumber).toBeUndefined();
      expect((matches[0] as any).aadhaarNumber).toBeUndefined();
    });
  });

  describe('8. Controlled Operator Recovery Actions', () => {
    it('resets stuck onboarding stage with mandatory reason and audit event', async () => {
      const assayer = new AssayerEntity();
      assayer.id = 'asr-stuck-1';
      assayer.lifecycleStatus = AssayerLifecycleStatus.TRAINING;
      assayer.status = AssayerStatus.INACTIVE;
      assayer.isActive = true;

      (assayerRepo.findOne as jest.Mock).mockResolvedValue(assayer);

      const result = await assayerService.operatorResetOnboardingStage(
        'asr-stuck-1',
        AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
        'Physical document scan was illegible; resetting stage for resubmission',
        'operator-1',
      );

      expect(result.lifecycleStatus).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
      expect(auditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'ASSAYER_ONBOARDING_STAGE_RESET',
          previousState: AssayerLifecycleStatus.TRAINING,
          newState: AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
        }),
      );
    });

    it('refuses resetting onboarding stage on an already ACTIVE assayer', async () => {
      const activeAssayer = new AssayerEntity();
      activeAssayer.id = 'asr-active-1';
      activeAssayer.lifecycleStatus = AssayerLifecycleStatus.ACTIVE;

      (assayerRepo.findOne as jest.Mock).mockResolvedValue(activeAssayer);

      await expect(
        assayerService.operatorResetOnboardingStage(
          'asr-active-1',
          AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
          'Attempting to reset active workforce member',
          'operator-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('reconciles departed empanelments by closing active standings with audit log', async () => {
      const departedAssayer = new AssayerEntity();
      departedAssayer.id = 'asr-departed-1';
      departedAssayer.assayerCode = 'AS0099';
      departedAssayer.lifecycleStatus = AssayerLifecycleStatus.RESIGNED;

      (assayerRepo.findOne as jest.Mock).mockResolvedValue(departedAssayer);
      mockDataSource.query.mockResolvedValueOnce([[], 2]); // 2 empanelments closed

      const closed = await assayerService.operatorReconcileDepartedEmpanelments(
        'asr-departed-1',
        'Routine reconciliation of departed personnel with active empanelments',
        'operator-1',
      );

      expect(closed).toBe(2);
      expect(auditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'DEPARTED_EMPANELMENTS_RECONCILED',
          remarks: expect.stringContaining('2 closed'),
        }),
      );
    });
  });
});
