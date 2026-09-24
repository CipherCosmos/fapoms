import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import {
  AddressCheckMethod, AddressCheckResult, BackgroundCheckVerdict, CibilBand, CourtCheckResult, DocumentVerification, OnboardingDocument,
} from '@fapoms/shared';
import { RosterRecordsService } from './roster-records.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerDocumentVersionEntity } from './assayer-document-version.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { AuditService } from '../../core/audit/audit.service';

/**
 * EACH BACKGROUND CHECK KEEPS ITS OWN REPORT (owner, 2026-09-23).
 *
 * "Passed" and "not passed" are both recorded with the report they were read from. A candidate who
 * did not pass can be verified again, and the pass must come with the NEW report — the failed one
 * stays with the failed check, viewable, and cannot be removed.
 */
/** A background verification's three parts, all clean — what a clear result needs (2026-09-24). */
const ALL_PARTS = {
  addressCheckMethod: AddressCheckMethod.PHYSICAL, addressCheckResult: AddressCheckResult.VERIFIED,
  cibilBand: CibilBand.GOOD, courtCheckResult: CourtCheckResult.NO_RECORD,
} as const;

describe('background check reports, one per check', () => {
  let service: RosterRecordsService;
  let saved: any[];
  let doc: any;
  let versions: any[];
  const audit = { recordEvent: jest.fn(), recordEventSafe: jest.fn().mockResolvedValue(undefined) };

  const upload = (path: string) => {
    doc.filePaths.push(path);
    versions.unshift({ id: `ver-${path}`, documentId: doc.id, filePath: path, version: versions.length + 1, uploadedAt: new Date('2026-09-20T10:00:00Z') });
  };
  const record = (verdict: BackgroundCheckVerdict, over: Record<string, unknown> = {}) =>
    service.recordBackgroundCheck('a-1', { verdict, ...ALL_PARTS, ...over } as never, 'hr-1');

  beforeEach(async () => {
    saved = [];
    versions = [];
    doc = {
      id: 'doc-bgv', assayerId: 'a-1', requirement: OnboardingDocument.BGV_REPORT, filePaths: [], issuedBy: 'AuthBridge',
      verificationStatus: null, currentVersionId: null,
    };
    const checks = {
      find: jest.fn(async () => saved),
      findOne: jest.fn(async () => saved.at(-1) ?? null),
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn(async (v: any) => { const row = { id: `chk-${saved.length + 1}`, ...v }; saved.push(row); return row; }),
    };
    const onboarding = {
      findOne: jest.fn(async () => doc),
      find: jest.fn(async () => [doc]),
      save: jest.fn(async (v: any) => v),
    };
    const docVersions = {
      find: jest.fn(async () => versions),
      findOne: jest.fn(async () => null),
      update: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: { findOne: jest.fn(), update: jest.fn() } },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: checks },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: onboarding },
        { provide: getRepositoryToken(AssayerDocumentVersionEntity), useValue: docVersions },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: {} },
        { provide: getDataSourceToken(), useValue: {} },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(RosterRecordsService);
    jest.clearAllMocks();
  });

  it('keeps the report a result was read from on the check, with the upload it came from', async () => {
    upload('bgv/first.pdf');
    const check = await record(BackgroundCheckVerdict.CRIMINAL_CASE);

    expect(check.reportFiles).toEqual([
      { documentId: 'doc-bgv', versionId: 'ver-bgv/first.pdf', path: 'bgv/first.pdf', uploadedAt: '2026-09-20T10:00:00.000Z' },
    ]);
    // The trail names the evidence, not just the verdict.
    const event = audit.recordEventSafe.mock.calls[0][0];
    expect(event.metadata.newValue.reportFiles).toEqual([{ versionId: 'ver-bgv/first.pdf', path: 'bgv/first.pdf' }]);
    expect(event.metadata.newValue.checkedByName).toBe('AuthBridge');
  });

  /** The reprocess: a pass must not be recorded against the report that failed them. */
  it('will not record a second result against the first check\'s report', async () => {
    upload('bgv/first.pdf');
    await record(BackgroundCheckVerdict.CRIMINAL_CASE);

    await expect(record(BackgroundCheckVerdict.CLEAR)).rejects.toThrow(/Upload the report for this check/);
    expect(saved).toHaveLength(1);
  });

  it('records the re-verification with its new report, leaving the failed one where it was', async () => {
    upload('bgv/first.pdf');
    await record(BackgroundCheckVerdict.CRIMINAL_CASE);
    upload('bgv/second.pdf');

    const pass = await record(BackgroundCheckVerdict.CLEAR, { checkedByName: 'First Advantage' });

    expect(pass.reportFiles.map((f: any) => f.path)).toEqual(['bgv/second.pdf']);
    expect(saved[0].reportFiles.map((f: any) => f.path)).toEqual(['bgv/first.pdf']);
    expect(pass.checkedByName).toBe('First Advantage');
  });

  it('gives "not checked" no report, so the report stays waiting for a real result', async () => {
    upload('bgv/first.pdf');
    const none = await record(BackgroundCheckVerdict.NOT_CHECKED);
    expect(none.reportFiles).toEqual([]);

    const later = await record(BackgroundCheckVerdict.CLEAR);
    expect(later.reportFiles.map((f: any) => f.path)).toEqual(['bgv/first.pdf']);
  });

  it('lists the report waiting for its result, with where each file sits on the document', async () => {
    upload('bgv/first.pdf');
    await record(BackgroundCheckVerdict.CIVIL_CASE);
    upload('bgv/second.pdf');

    const { unclaimed } = await service.bgvReportState('a-1');
    expect(unclaimed).toEqual([expect.objectContaining({ path: 'bgv/second.pdf', index: 1, versionId: 'ver-bgv/second.pdf' })]);
  });

  describe('the gate asks the operative check for its own report', () => {
    it('is satisfied by a check that carries one', async () => {
      upload('bgv/first.pdf');
      await record(BackgroundCheckVerdict.CLEAR);
      await expect(service.bgvReportOnFile('a-1')).resolves.toBe(true);
    });

    it('is not satisfied by a report that belongs to nobody yet', async () => {
      upload('bgv/first.pdf');
      await expect(service.bgvReportOnFile('a-1')).resolves.toBe(false);
    });
  });

  describe('removing a report file', () => {
    it('refuses one a recorded check was read from — a failed check\'s report included', async () => {
      upload('bgv/first.pdf');
      await record(BackgroundCheckVerdict.CRIMINAL_CASE);

      await expect(service.detachFile('doc-bgv', 0, 'hr-1')).rejects.toThrow(/evidence for a recorded background check/);
      expect(doc.filePaths).toEqual(['bgv/first.pdf']);
    });

    it('allows one still waiting for its result', async () => {
      upload('bgv/first.pdf');
      await record(BackgroundCheckVerdict.CRIMINAL_CASE);
      upload('bgv/wrong-person.pdf');

      await expect(service.detachFile('doc-bgv', 1, 'hr-1')).resolves.toMatchObject({ key: 'bgv/wrong-person.pdf' });
      expect(doc.filePaths).toEqual(['bgv/first.pdf']);
    });
  });

  /**
   * THE THREE PARTS (owner, 2026-09-24): "address check (physical/digital), cibil check, court check
   * should present before making that done".
   */
  describe('a clear background check needs its address, CIBIL and court checks', () => {
    it('refuses clear without them, names what is missing, and records nothing', async () => {
      upload('bgv/first.pdf');
      await expect(record(BackgroundCheckVerdict.CLEAR, { addressCheckMethod: null, courtCheckResult: undefined }))
        .rejects.toThrow('Still to fill in: the address check (physical or digital) and the court check.');
      await expect(record(BackgroundCheckVerdict.CLEAR, { cibilBand: CibilBand.CHECK_FAILED }))
        .rejects.toThrow(/Still to fill in: the CIBIL check\./);
      expect(saved).toHaveLength(0);
      expect(audit.recordEventSafe).not.toHaveBeenCalled();
    });

    it('refuses clear when a part found something', async () => {
      upload('bgv/first.pdf');
      await expect(record(BackgroundCheckVerdict.CLEAR, { courtCheckResult: CourtCheckResult.CRIMINAL_CASE }))
        .rejects.toThrow(/court check found a criminal case, so the result cannot be clear/);
      await expect(record(BackgroundCheckVerdict.CLEAR, { addressCheckResult: AddressCheckResult.DISCREPANCY }))
        .rejects.toThrow(/address check found a discrepancy/);
      expect(saved).toHaveLength(0);
    });

    it('keeps all three on the check', async () => {
      upload('bgv/first.pdf');
      const check = await record(BackgroundCheckVerdict.CLEAR, { addressCheckMethod: AddressCheckMethod.DIGITAL, cibilScore: 752 });
      expect(check).toMatchObject({
        addressCheckMethod: 'DIGITAL', addressCheckResult: 'VERIFIED', cibilBand: 'GOOD', cibilScore: 752, courtCheckResult: 'NO_RECORD',
      });
    });

    /** An agency that found a criminal case may stop there — not passing needs no other part. */
    it('records a result that is not clear with whatever parts were done', async () => {
      upload('bgv/first.pdf');
      const check = await record(BackgroundCheckVerdict.CRIMINAL_CASE, {
        addressCheckMethod: null, addressCheckResult: null, cibilBand: null, courtCheckResult: CourtCheckResult.CRIMINAL_CASE,
      });
      expect(check).toMatchObject({ verdict: 'CRIMINAL_CASE', courtCheckResult: 'CRIMINAL_CASE', addressCheckResult: null, cibilBand: null });
    });

    it('refuses a value it does not know rather than dropping it', async () => {
      upload('bgv/first.pdf');
      await expect(record(BackgroundCheckVerdict.CLEAR, { addressCheckMethod: 'DRONE' }))
        .rejects.toThrow('"DRONE" is not a way of checking an address this system records.');
      await expect(record(BackgroundCheckVerdict.CIVIL_CASE, { courtCheckResult: 'PENDING' }))
        .rejects.toThrow(/is not a result of a court check/);
      expect(saved).toHaveLength(0);
    });

    describe('the gate reads them off the operative check', () => {
      it('has nothing to add for a check recorded with all three', async () => {
        upload('bgv/first.pdf');
        await record(BackgroundCheckVerdict.CLEAR);
        await expect(service.bgvPartsMissing('a-1')).resolves.toEqual([]);
      });

      it('names the parts a clear check from before them lacks', async () => {
        saved.push({ id: 'chk-old', verdict: BackgroundCheckVerdict.CLEAR, cibilBand: CibilBand.GOOD, reportFiles: [] });
        await expect(service.bgvPartsMissing('a-1')).resolves.toEqual(['the address check (physical or digital)', 'the court check']);
      });

      it('leaves "no check at all" to the gate\'s own arm', async () => {
        await expect(service.bgvPartsMissing('a-1')).resolves.toEqual([]);
      });
    });
  });

  // Keeps the unused-import linter honest about why DocumentVerification is here: none of this
  // touches a verification — a report is evidence for a check, not a verified identity document.
  it('never marks the report itself verified', async () => {
    upload('bgv/first.pdf');
    await record(BackgroundCheckVerdict.CLEAR);
    expect(doc.verificationStatus).not.toBe(DocumentVerification.VERIFIED);
  });
});
