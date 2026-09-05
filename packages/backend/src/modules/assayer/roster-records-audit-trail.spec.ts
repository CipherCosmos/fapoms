import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentVerification, EmpanelmentStatus, BackgroundCheckVerdict } from '@fapoms/shared';
import { RosterRecordsService } from './roster-records.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { AuditService } from '../../core/audit/audit.service';

/**
 * Empanelment set/withdraw, background-check recording, and identity-document
 * verify/reject/reset used to leave no trail at all — only the row's current state, with
 * nothing to say who set it or when. Each of these tests fails on the pre-fix code with
 * "recordEventSafe was never called".
 */
describe('RosterRecordsService — audit trail for previously-silent writes', () => {
  let service: RosterRecordsService;
  let empanelments: any;
  let checks: any;
  let onboarding: any;
  let assayers: any;
  const audit = { recordEvent: jest.fn(), recordEventSafe: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    empanelments = {
      findOne: jest.fn(),
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn((v: any) => Promise.resolve({ id: 'emp-1', ...v })),
    };
    checks = {
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn((v: any) => Promise.resolve({ id: 'chk-1', ...v })),
    };
    onboarding = {
      findOne: jest.fn(),
      save: jest.fn((v: any) => Promise.resolve(v)),
    };
    assayers = { findOne: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: empanelments },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: checks },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: onboarding },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: {} },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(RosterRecordsService);
    jest.clearAllMocks();
  });

  it('records EMPANELMENT_SET with the previous and new standing', async () => {
    empanelments.findOne.mockResolvedValue({ id: 'emp-1', status: EmpanelmentStatus.INACTIVE, clientId: 'c-1' });
    await service.setEmpanelment('a-1', 'c-1', { status: EmpanelmentStatus.ACTIVE }, 'user-1');

    expect(audit.recordEventSafe).toHaveBeenCalledTimes(1);
    const dto = audit.recordEventSafe.mock.calls[0][0];
    expect(dto.eventType).toBe('EMPANELMENT_SET');
    expect(dto.previousState).toBe(EmpanelmentStatus.INACTIVE);
    expect(dto.newState).toBe(EmpanelmentStatus.ACTIVE);
    expect(dto.metadata.previousValue).toEqual({ status: EmpanelmentStatus.INACTIVE });
    expect(dto.metadata.newValue.status).toBe(EmpanelmentStatus.ACTIVE);
  });

  it('records EMPANELMENT_WITHDRAWN when a standing is removed', async () => {
    empanelments.findOne.mockResolvedValue({ id: 'emp-1', status: EmpanelmentStatus.ACTIVE, clientId: 'c-1', assayerId: 'a-1' });
    await service.removeEmpanelment('emp-1', 'user-1');

    expect(audit.recordEventSafe).toHaveBeenCalledTimes(1);
    const dto = audit.recordEventSafe.mock.calls[0][0];
    expect(dto.eventType).toBe('EMPANELMENT_WITHDRAWN');
    expect(dto.previousState).toBe(EmpanelmentStatus.ACTIVE);
  });

  it('records BACKGROUND_CHECK_RECORDED with the verdict in metadata', async () => {
    await service.recordBackgroundCheck('a-1', { verdict: BackgroundCheckVerdict.CLEAR }, 'user-1');

    expect(audit.recordEventSafe).toHaveBeenCalledTimes(1);
    const dto = audit.recordEventSafe.mock.calls[0][0];
    expect(dto.eventType).toBe('BACKGROUND_CHECK_RECORDED');
    expect(dto.entityId).toBe('a-1');
    expect(dto.metadata.newValue.verdict).toBe(BackgroundCheckVerdict.CLEAR);
  });

  it('records IDENTITY_DOCUMENT_VERIFICATION_CHANGED with the previous and new verdicts', async () => {
    onboarding.findOne.mockResolvedValue({
      id: 'doc-1', assayerId: 'a-1', requirement: 'PAN_CARD',
      verificationStatus: DocumentVerification.PENDING, documentNumber: null,
      // A verification now needs something to have been verified. `set-document-guards.spec.ts`
      // covers the refusal; this test is about the trail the write leaves behind.
      filePaths: ['scans/a-1/pan.jpg'],
    });
    assayers.findOne.mockResolvedValue({ id: 'a-1', panNumber: 'ABCDE1234F' });

    await service.verifyDocument('doc-1', DocumentVerification.VERIFIED, 'user-1');

    expect(audit.recordEventSafe).toHaveBeenCalledTimes(1);
    const dto = audit.recordEventSafe.mock.calls[0][0];
    expect(dto.eventType).toBe('IDENTITY_DOCUMENT_VERIFICATION_CHANGED');
    expect(dto.previousState).toBe(DocumentVerification.PENDING);
    expect(dto.newState).toBe(DocumentVerification.VERIFIED);
  });
});
