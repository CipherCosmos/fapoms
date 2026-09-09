import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DocumentVerification, OnboardingDocument } from '@fapoms/shared';

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
 * A verified document's evidence cannot be deleted out from under it.
 *
 * `DELETE /assayers/document/:id/file/:index` answered 204 and the controller then destroyed the
 * stored object, because the object's lifetime was decided by ONE of its two references:
 * `assayer_documents.file_paths`. The other one — `assayer_document_versions.file_path` — is the
 * row a reviewer signs, and certification reproduced the consequence exactly: a version reading
 * `verification_status = VERIFIED` citing `uploads/1788968609538-kyc_probe.pdf`, and no such
 * object in the bucket. The row asserted that somebody compared a PAN card against its original;
 * the original was gone.
 *
 * The rule these tests hold is the one `detachFile` now owns outright: **an object is destroyed
 * only when nothing still attests to it.** Detach still works — removing a bad scan from a live
 * record is an editorial act and must not be blocked — but the bytes under a signature stay, and
 * stay reachable.
 *
 * And the second dangling state, which "refuse the delete" would not have closed: the parent row
 * could read VERIFIED with `file_paths = []`, a state `verifyDocument` itself refuses to create
 * ("there is nothing to have checked against the original"). Removing the evidence now withdraws
 * the verification through the same `undoVerification` every other loss-of-grounds goes through.
 */

const ASSAYER = 'a-1';
const DOC = 'doc-1';
const KEY_V1 = 'uploads/1000-pan-v1.pdf';
const KEY_V2 = 'uploads/2000-pan-v2.pdf';

type Version = Partial<AssayerDocumentVersionEntity> & { id: string; version: number; filePath: string };

describe('RosterRecordsService.detachFile — evidence under a verification', () => {
  let service: RosterRecordsService;
  let onboarding: any;
  let docVersions: any;
  let assayers: any;
  let versionRows: Version[];
  const audit = { recordEvent: jest.fn(), recordEventSafe: jest.fn().mockResolvedValue(undefined) };

  /** One document row plus its version history, wired to in-memory arrays the service mutates. */
  const given = (doc: Partial<AssayerDocumentEntity>, versions: Version[]) => {
    versionRows = versions;
    const row: any = {
      id: DOC,
      assayerId: ASSAYER,
      requirement: OnboardingDocument.PAN_CARD,
      filePaths: [],
      currentVersionId: null,
      verificationStatus: null,
      remarks: null,
      ...doc,
    };
    onboarding.findOne.mockResolvedValue(row);
    docVersions.find.mockImplementation(async () => versionRows.map((v) => ({ ...v })));
    docVersions.findOne.mockImplementation(async ({ where }: any) =>
      versionRows.find((v) => v.id === where.id) ?? null);
    docVersions.update.mockImplementation(async (criteria: any, patch: any) => {
      // `In([...])` arrives as a FindOperator; its values are what the service asked for.
      const ids: string[] = criteria.id?._value ?? (Array.isArray(criteria.id) ? criteria.id : [criteria.id]);
      for (const v of versionRows) if (ids.includes(v.id)) Object.assign(v, patch);
      return { affected: ids.length };
    });
    return row;
  };

  beforeEach(async () => {
    onboarding = {
      findOne: jest.fn(),
      // `deriveLegalName` re-reads the person's documents whenever a verdict changes.
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((v: any) => Promise.resolve(v)),
    };
    docVersions = { find: jest.fn(), findOne: jest.fn(), update: jest.fn(), save: jest.fn((v: any) => Promise.resolve(v)) };
    assayers = { findOne: jest.fn().mockResolvedValue({ id: ASSAYER, displayName: 'Person One', panNumber: 'ABCDE1234F' }), update: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: onboarding },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerDocumentVersionEntity), useValue: docVersions },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(RosterRecordsService);
    jest.clearAllMocks();
    audit.recordEventSafe.mockResolvedValue(undefined);
  });

  it('lets an UNVERIFIED scan go, and releases its object', async () => {
    // Nothing signed for this one, so there is nothing to protect and no reason to keep bytes.
    given(
      { filePaths: [KEY_V1], currentVersionId: 'v1', verificationStatus: DocumentVerification.PENDING },
      [{ id: 'v1', version: 1, filePath: KEY_V1, verificationStatus: DocumentVerification.PENDING, evidenceReleasedAt: null }],
    );

    const detached = await service.detachFile(DOC, 0, 'user-1');

    expect(detached).toMatchObject({ key: KEY_V1, mayDestroy: true, retainedBy: [] });
    expect(versionRows[0].evidenceReleasedAt).toBeInstanceOf(Date);
  });

  it('refuses to release the object under a VERIFIED version, while still detaching the reference', async () => {
    given(
      { filePaths: [KEY_V1], currentVersionId: 'v1', verificationStatus: DocumentVerification.VERIFIED },
      [{ id: 'v1', version: 1, filePath: KEY_V1, verificationStatus: DocumentVerification.VERIFIED, evidenceReleasedAt: null }],
    );

    const detached = await service.detachFile(DOC, 0, 'user-1');

    // The operator's request succeeded: the scan is off the record.
    expect(onboarding.save).toHaveBeenCalledWith(expect.objectContaining({ filePaths: [] }));
    // The bytes are not the operator's to destroy while a signature depends on them.
    expect(detached?.mayDestroy).toBe(false);
    expect(detached?.retainedBy).toEqual([{ versionId: 'v1', version: 1 }]);
    expect(versionRows[0].evidenceReleasedAt).toBeNull();
    // And the attestation itself is untouched — it is the history, not the current state.
    expect(versionRows[0].verificationStatus).toBe(DocumentVerification.VERIFIED);
  });

  it('withdraws the parent row\'s verification when its evidence is taken away', async () => {
    // `verifyDocument` will not mark a document VERIFIED with `file_paths` empty — "there is
    // nothing to have checked against the original". Detaching used to walk straight past that.
    const row = given(
      { filePaths: [KEY_V1], currentVersionId: 'v1', verificationStatus: DocumentVerification.VERIFIED, verifiedAt: new Date(), verifiedBy: 'user-9' },
      [{ id: 'v1', version: 1, filePath: KEY_V1, verificationStatus: DocumentVerification.VERIFIED, evidenceReleasedAt: null }],
    );

    const detached = await service.detachFile(DOC, 0, 'user-1');

    expect(row.verificationStatus).toBe(DocumentVerification.PENDING);
    expect(row.verifiedAt).toBeNull();
    expect(row.verifiedBy).toBeNull();
    expect(row.remarks).toMatch(/Verification withdrawn — the scan it was checked against was removed/);
    expect(detached?.withdrewVerification).toBe(true);
    // The name of record follows the verifications, so it is re-derived rather than left standing
    // on evidence that is no longer attached.
    expect(assayers.update).toHaveBeenCalledWith({ id: ASSAYER }, expect.objectContaining({ legalName: null }));
  });

  it('keeps a superseded VERIFIED version alive after the scan is replaced and the old one removed', async () => {
    // The replace-then-tidy-up journey: v1 was verified, v2 was uploaded and supersedes it, and
    // somebody now clears the old scan off the record. v1's signature still stands, so its bytes
    // stay — even though the CURRENT version is a different, unverified file.
    given(
      {
        filePaths: [KEY_V1, KEY_V2],
        currentVersionId: 'v2',
        verificationStatus: DocumentVerification.PENDING,
      },
      [
        { id: 'v1', version: 1, filePath: KEY_V1, verificationStatus: DocumentVerification.VERIFIED, supersededByVersionId: 'v2', evidenceReleasedAt: null },
        { id: 'v2', version: 2, filePath: KEY_V2, verificationStatus: DocumentVerification.PENDING, evidenceReleasedAt: null },
      ],
    );

    const detached = await service.detachFile(DOC, 0, 'user-1');

    expect(detached).toMatchObject({ key: KEY_V1, mayDestroy: false });
    expect(versionRows[0].evidenceReleasedAt).toBeNull();
    // The unrelated, current version is not collateral damage.
    expect(versionRows[1].evidenceReleasedAt).toBeNull();
    expect(versionRows[1].verificationStatus).toBe(DocumentVerification.PENDING);
  });

  it('releases the superseded object when the version that cited it was never verified', async () => {
    given(
      { filePaths: [KEY_V1, KEY_V2], currentVersionId: 'v2', verificationStatus: DocumentVerification.PENDING },
      [
        { id: 'v1', version: 1, filePath: KEY_V1, verificationStatus: DocumentVerification.REJECTED, evidenceReleasedAt: null },
        { id: 'v2', version: 2, filePath: KEY_V2, verificationStatus: DocumentVerification.PENDING, evidenceReleasedAt: null },
      ],
    );

    const detached = await service.detachFile(DOC, 0, 'user-1');

    // A rejection is not an attestation that the document was checked and matched — there is
    // nothing to preserve for audit beyond the reason, which is on the row already.
    expect(detached?.mayDestroy).toBe(true);
    expect(versionRows[0].evidenceReleasedAt).toBeInstanceOf(Date);
    expect(versionRows[1].evidenceReleasedAt).toBeNull();
  });

  it('matches a reference held as storage_object_id, not only as file_path', async () => {
    // `attachFile` writes both columns and a future storage engine may legitimately make them
    // differ. Missing one is how the object gets destroyed anyway.
    given(
      { filePaths: [KEY_V1], currentVersionId: 'v1', verificationStatus: DocumentVerification.VERIFIED },
      [{ id: 'v1', version: 1, filePath: 'a-different-path', storageObjectId: KEY_V1, verificationStatus: DocumentVerification.VERIFIED, evidenceReleasedAt: null }],
    );

    const detached = await service.detachFile(DOC, 0, 'user-1');

    expect(detached?.mayDestroy).toBe(false);
  });

  it('says in the audit trail which of the two things happened', async () => {
    given(
      { filePaths: [KEY_V1], currentVersionId: 'v1', verificationStatus: DocumentVerification.VERIFIED },
      [{ id: 'v1', version: 1, filePath: KEY_V1, verificationStatus: DocumentVerification.VERIFIED, evidenceReleasedAt: null }],
    );

    await service.detachFile(DOC, 0, 'user-1');

    const dto = audit.recordEventSafe.mock.calls[0][0];
    expect(dto.eventType).toBe('IDENTITY_DOCUMENT_FILE_DETACHED');
    expect(dto.entityId).toBe(ASSAYER);
    expect(dto.metadata).toMatchObject({
      removedObjectKey: KEY_V1,
      objectDestroyed: false,
      retainedByVersionIds: ['v1'],
      withdrewVerification: true,
    });
    // A bucket holding objects nothing references is only explicable if the reason is written
    // down. "the stored object is deleted" was written unconditionally before, and was false.
    expect(dto.remarks).toMatch(/stored object is KEPT/);
  });

  it('reports a destroyed object as destroyed', async () => {
    given(
      { filePaths: [KEY_V1], currentVersionId: 'v1', verificationStatus: DocumentVerification.PENDING },
      [{ id: 'v1', version: 1, filePath: KEY_V1, verificationStatus: DocumentVerification.PENDING, evidenceReleasedAt: null }],
    );

    await service.detachFile(DOC, 0, 'user-1');

    expect(audit.recordEventSafe.mock.calls[0][0].metadata.objectDestroyed).toBe(true);
  });

  it('still answers null for an index with no file, without touching anything', async () => {
    given({ filePaths: [], currentVersionId: null }, []);

    await expect(service.detachFile(DOC, 0, 'user-1')).resolves.toBeNull();
    expect(onboarding.save).not.toHaveBeenCalled();
    expect(audit.recordEventSafe).not.toHaveBeenCalled();
  });
});

describe('reaching the evidence that was kept', () => {
  let service: RosterRecordsService;
  let onboarding: any;
  let docVersions: any;

  const build = async (doc: any, version: any) => {
    onboarding = { findOne: jest.fn().mockResolvedValue(doc), find: jest.fn().mockResolvedValue([]), save: jest.fn() };
    docVersions = { findOne: jest.fn().mockResolvedValue(version), find: jest.fn().mockResolvedValue([]), update: jest.fn(), save: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: { findOne: jest.fn(), update: jest.fn() } },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: onboarding },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerDocumentVersionEntity), useValue: docVersions },
      ],
    }).compile();
    return mod.get(RosterRecordsService) as RosterRecordsService;
  };

  it('serves a retained object through the version that attests to it', async () => {
    // Retained evidence nobody can fetch is not evidence. `fileKey` cannot reach it — the index
    // it lived at is gone from `file_paths` — so the way back is the attestation's own id.
    service = await build(
      { id: DOC, assayerId: ASSAYER, requirement: OnboardingDocument.PAN_CARD, filePaths: [] },
      { id: 'v1', documentId: DOC, version: 1, filePath: KEY_V1, evidenceReleasedAt: null },
    );

    await expect(service.versionFileKey(DOC, 'v1')).resolves.toEqual({
      key: KEY_V1, requirement: OnboardingDocument.PAN_CARD, version: 1,
    });
  });

  it('refuses once the object really was released, rather than streaming a 500 from storage', async () => {
    service = await build(
      { id: DOC, assayerId: ASSAYER, requirement: OnboardingDocument.PAN_CARD, filePaths: [] },
      { id: 'v1', documentId: DOC, version: 1, filePath: KEY_V1, evidenceReleasedAt: new Date() },
    );

    await expect(service.versionFileKey(DOC, 'v1')).resolves.toBeNull();
  });

  it('answers null for a document that does not exist, like fileKey does', async () => {
    service = await build(null, null);

    await expect(service.versionFileKey(DOC, 'v1')).resolves.toBeNull();
  });
});

describe('verifying a version whose scan has been deleted', () => {
  it('is refused with a sentence, not a database constraint violation', async () => {
    const row: any = {
      id: DOC,
      assayerId: ASSAYER,
      requirement: OnboardingDocument.PAN_CARD,
      filePaths: [KEY_V2],
      currentVersionId: 'v1',
      verificationStatus: DocumentVerification.PENDING,
    };
    const version = { id: 'v1', documentId: DOC, version: 1, filePath: KEY_V1, verificationStatus: DocumentVerification.PENDING, evidenceReleasedAt: new Date() };
    const onboarding = { findOne: jest.fn().mockResolvedValue(row), find: jest.fn().mockResolvedValue([]), save: jest.fn((v: any) => Promise.resolve(v)) };
    const docVersions = { findOne: jest.fn().mockResolvedValue(version), find: jest.fn().mockResolvedValue([]), update: jest.fn(), save: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: { findOne: jest.fn().mockResolvedValue({ id: ASSAYER, displayName: 'Person One', panNumber: 'ABCDE1234F' }), update: jest.fn() } },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: onboarding },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerDocumentVersionEntity), useValue: docVersions },
      ],
    }).compile();
    const service = mod.get(RosterRecordsService) as RosterRecordsService;

    // `file_paths` is NOT empty — a second scan is attached — so the existing "no scan on file"
    // guard does not catch this. The version and the parent can disagree, and it is the version
    // the verification binds to.
    await expect(service.verifyDocument(DOC, DocumentVerification.VERIFIED, 'user-1', undefined, {
      holderName: 'Person One', holderDateOfBirth: '1990-01-01', holderGuardianName: 'Parent One',
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * The controller's half of the rule.
 *
 * `detachFile` can decide whatever it likes; the destroy happens in `removeDocumentFile`, and the
 * whole defect was one line there assuming a returned key meant "delete this file". Read out of
 * the source because mounting the controller drags in the entire assayer module — and because
 * what matters is that the call is CONDITIONAL, which is a property of the code rather than of
 * any one execution of it.
 */
describe('the delete route destroys an object only when told it may', () => {
  const controller = readFileSync(join(__dirname, 'assayer.controller.ts'), 'utf8');
  const route = controller.slice(
    controller.indexOf("@Delete('document/:id/file/:index')"),
    controller.indexOf("@Post('document/:id/verify')"),
  );

  it('gates storage.deleteFile on the service\'s answer', () => {
    expect(route).toMatch(/if \(detached\?\.mayDestroy\)\s*await this\.storage\.deleteFile\(detached\.key\)/);
  });

  it('never destroys unconditionally', () => {
    // The pre-fix line, exactly: `if (key) await this.storage.deleteFile(key)...`. A returned key
    // is a fact about the reference, not permission to erase the bytes behind it.
    expect(route).not.toMatch(/if \(key\)\s*await this\.storage\.deleteFile/);
  });

  it('is the only place in the assayer module that deletes a stored object', () => {
    // One home for the rule. A second caller of deleteFile would be a second policy.
    const deletions = controller.match(/this\.storage\.deleteFile\(/g) ?? [];
    expect(deletions).toHaveLength(1);
  });
});

/**
 * And the database's half, which holds even against a caller that has not read any of the above.
 */
describe('the migration makes the invariant structural', () => {
  const migration = readFileSync(
    join(__dirname, '..', '..', 'infrastructure', 'database', 'migrations', '1797500000000-VerifiedDocumentEvidenceRetention.ts'),
    'utf8',
  );

  it('refuses to record a release against a VERIFIED version', () => {
    expect(migration).toMatch(/CHECK \(verification_status <> 'VERIFIED' OR evidence_released_at IS NULL\)/);
  });

  it('adds the column the release is recorded in', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS evidence_released_at timestamptz NULL/);
  });

  it('rewrites no existing attestation', () => {
    // Reporting the population at risk is right; inventing a release timestamp for a deletion
    // nobody recorded, or downgrading somebody's signature, is not.
    expect(migration).not.toMatch(/UPDATE assayer_document_versions/);
  });
});
