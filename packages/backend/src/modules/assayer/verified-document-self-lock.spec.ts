import { ForbiddenException } from '@nestjs/common';
import { ASSAYER_ERROR_CODES, AssayerLifecycleStatus, AssayerUnavailableReason, DocumentRejectionReason, DocumentVerification, OnboardingDocument, hasPassedFinalApproval } from '@fapoms/shared';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { RosterRecordsService } from './roster-records.service';
import { AssayerController } from './assayer.controller';
import { ROLES_KEY, PERMISSIONS_KEY } from '../auth/guards';

/**
 * Owner decision, 2026-09-24: "verified details can't be tampered with until HR asks for that."
 *
 * An approved assayer could re-upload a VERIFIED PAN or Aadhaar from the phone, and the new scan
 * silently withdrew the verification HR had recorded against the original. The assayer is now
 * refused while the row is VERIFIED; once HR takes it off VERIFIED (sends it back, or a staff edit
 * withdraws the verification) the assayer's upload goes through as before. Staff are unaffected.
 */
describe('an assayer may not replace a document HR has verified', () => {
  const ASSAYER = 'asr-1';

  const serviceWith = (row: any, person: any = { id: ASSAYER, displayName: 'Ramesh Kumar' }) => {
    const svc: any = Object.create(RosterRecordsService.prototype);
    svc.onboarding = {
      findOne: jest.fn(async () => row),
      find: jest.fn(async () => []),
      create: jest.fn((d: any) => ({ ...d })),
      save: jest.fn(async (d: any) => ({ id: 'doc-new', ...d })),
    };
    svc.assayers = { findOne: jest.fn(async () => person), update: jest.fn(), save: jest.fn(async (p: any) => p) };
    svc.auditService = { recordEventSafe: jest.fn() };
    svc.notifications = { emitSafe: jest.fn() };
    // `attachFile` is exercised elsewhere; here it only has to prove it was (or was not) reached.
    svc.attachFile = jest.fn(async () => ({ ok: true }));
    return svc;
  };

  const docRow = (verificationStatus: DocumentVerification | null, requirement = OnboardingDocument.PAN_CARD) => ({
    id: 'doc-1',
    assayerId: ASSAYER,
    requirement,
    filePaths: ['scans/original.jpg'],
    verificationStatus,
    verifiedAt: verificationStatus === DocumentVerification.VERIFIED ? new Date() : null,
    verifiedBy: verificationStatus === DocumentVerification.VERIFIED ? 'hr-1' : null,
    isActive: true,
  });

  const controllerWith = (svc: any) => {
    const c: any = Object.create(AssayerController.prototype);
    c.rosterRecords = svc;
    c.regionGuard = { assertAssayerInScope: jest.fn(async () => undefined) };
    c.storage = { saveFile: jest.fn(async () => 'stored/new-scan.jpg') };
    return c;
  };

  const file = { buffer: Buffer.from('\xff\xd8\xff\xe0 jpeg'), size: 9, mimetype: 'image/jpeg', originalname: 'pan.jpg' };
  const self = { user: { id: ASSAYER, roles: [{ name: 'ASSAYER' }] } };
  const hr = { user: { id: 'hr-1', roles: [{ name: 'OPERATIONS' }] } };

  describe('RosterRecordsService.assertSelfMayChangeDocument', () => {
    it('refuses a VERIFIED document with DOCUMENT_VERIFIED_LOCKED and the plain sentence', async () => {
      const svc = serviceWith(docRow(DocumentVerification.VERIFIED));
      const err = await svc.assertSelfMayChangeDocument(ASSAYER, OnboardingDocument.PAN_CARD).catch((e: any) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toBe('HR has verified this. Ask HR if it needs changing.');
      expect(err.code ?? err.getResponse?.().code).toBe(ASSAYER_ERROR_CODES.DOCUMENT_VERIFIED_LOCKED);
    });

    it.each([DocumentVerification.PENDING, DocumentVerification.REJECTED, null])(
      'lets a %s document through',
      async (status) => {
        const svc = serviceWith(docRow(status));
        await expect(svc.assertSelfMayChangeDocument(ASSAYER, OnboardingDocument.PAN_CARD)).resolves.toBeUndefined();
      },
    );

    it('lets a document that has never been filed through', async () => {
      const svc = serviceWith(null);
      await expect(svc.assertSelfMayChangeDocument(ASSAYER, OnboardingDocument.AADHAAR_FRONT)).resolves.toBeUndefined();
    });
  });

  describe('POST :assayerId/document/:requirement/file', () => {
    it('refuses the assayer\'s own re-upload of a VERIFIED PAN before anything is stored', async () => {
      const svc = serviceWith(docRow(DocumentVerification.VERIFIED));
      const c = controllerWith(svc);
      await expect(c.attachDocumentFile(ASSAYER, 'PAN_CARD', file, self)).rejects.toBeInstanceOf(ForbiddenException);
      expect(c.storage.saveFile).not.toHaveBeenCalled();
      expect(svc.attachFile).not.toHaveBeenCalled();
    });

    it('accepts the assayer\'s re-upload once HR has sent the document back (REJECTED)', async () => {
      const svc = serviceWith(docRow(DocumentVerification.REJECTED));
      const c = controllerWith(svc);
      await expect(c.attachDocumentFile(ASSAYER, 'PAN_CARD', file, self)).resolves.toMatchObject({ success: true });
      expect(svc.attachFile).toHaveBeenCalled();
    });

    it('leaves staff uploads exactly as they were, even on a VERIFIED document', async () => {
      const svc = serviceWith(docRow(DocumentVerification.VERIFIED));
      const c = controllerWith(svc);
      await expect(c.attachDocumentFile(ASSAYER, 'PAN_CARD', file, hr)).resolves.toMatchObject({ success: true });
      expect(svc.onboarding.findOne).not.toHaveBeenCalled(); // the lock is not even asked
      expect(svc.attachFile).toHaveBeenCalled();
    });

    it('unlocks through a real HR action: a staff edit withdraws the verification, then the assayer may upload', async () => {
      // A driving licence carries its number on the row, so a staff correction of the expiry runs
      // the real `setDocument` → `undoVerification` path and leaves the row PENDING.
      const row = docRow(DocumentVerification.VERIFIED, OnboardingDocument.DRIVING_LICENCE);
      const svc = serviceWith(row);
      const c = controllerWith(svc);
      await expect(c.attachDocumentFile(ASSAYER, 'DRIVING_LICENCE', file, self)).rejects.toBeInstanceOf(ForbiddenException);

      await RosterRecordsService.prototype.setDocument.call(svc, ASSAYER, OnboardingDocument.DRIVING_LICENCE, { expiryDate: '2031-01-31' }, 'hr-1');
      expect(row.verificationStatus).toBe(DocumentVerification.PENDING);

      await expect(c.attachDocumentFile(ASSAYER, 'DRIVING_LICENCE', file, self)).resolves.toMatchObject({ success: true });
    });
  });

  describe('PUT :assayerId/document/:requirement', () => {
    it('refuses the assayer changing the expiry on a VERIFIED document, which would withdraw it', async () => {
      const svc = serviceWith(docRow(DocumentVerification.VERIFIED, OnboardingDocument.PASSPORT));
      svc.setDocument = jest.fn(async () => ({ ok: true }));
      const c = controllerWith(svc);
      await expect(c.setDocument(ASSAYER, 'PASSPORT', { expiryDate: '2035-01-01' }, self)).rejects.toBeInstanceOf(ForbiddenException);
      expect(svc.setDocument).not.toHaveBeenCalled();
    });

    it('still lets the assayer tick that a copy arrived on a VERIFIED document — nothing attested changes', async () => {
      const svc = serviceWith(docRow(DocumentVerification.VERIFIED, OnboardingDocument.PASSPORT));
      svc.setDocument = jest.fn(async () => ({ ok: true }));
      const c = controllerWith(svc);
      await c.setDocument(ASSAYER, 'PASSPORT', { hardCopyReceived: true }, self);
      expect(svc.setDocument).toHaveBeenCalled();
    });
  });

  /**
   * Owner decision: the photograph is locked once the assayer is approved ("Lock once approved"),
   * and only HR's "Ask to re-upload" opens it.
   */
  describe('the photograph is locked once approved', () => {
    const photoRow = (status: DocumentVerification | null = DocumentVerification.PENDING) =>
      ({ ...docRow(status, OnboardingDocument.PHOTOGRAPH), filePaths: ['photos/face.jpg'] });
    const approved = { id: ASSAYER, lifecycleStatus: AssayerLifecycleStatus.ACTIVE, unavailableReason: null, photograph: 'photos/face.jpg' };

    it.each([
      AssayerLifecycleStatus.TRAINING, AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ON_LEAVE,
      AssayerLifecycleStatus.SUSPENDED,
    ])('refuses the assayer replacing their own photo at %s, with PHOTOGRAPH_LOCKED', async (lifecycleStatus) => {
      const svc = serviceWith(photoRow(), { ...approved, lifecycleStatus });
      const c = controllerWith(svc);
      const err = await c.attachDocumentFile(ASSAYER, 'PHOTOGRAPH', file, self).catch((e: any) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toBe('Your photo is locked. Ask HR if it needs changing.');
      expect(err.code ?? err.getResponse?.().code).toBe(ASSAYER_ERROR_CODES.PHOTOGRAPH_LOCKED);
      expect(c.storage.saveFile).not.toHaveBeenCalled();
    });

    it.each([
      AssayerLifecycleStatus.INVITED, AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      AssayerLifecycleStatus.BACKGROUND_VERIFICATION, AssayerLifecycleStatus.FINAL_APPROVAL,
    ])('leaves it open while still joining (%s)', async (lifecycleStatus) => {
      const svc = serviceWith(photoRow(), { ...approved, lifecycleStatus });
      await expect(controllerWith(svc).attachDocumentFile(ASSAYER, 'PHOTOGRAPH', file, self)).resolves.toMatchObject({ success: true });
    });

    it('leaves it open for someone parked INACTIVE because they were never approved', async () => {
      const svc = serviceWith(photoRow(), {
        ...approved, lifecycleStatus: AssayerLifecycleStatus.INACTIVE, unavailableReason: AssayerUnavailableReason.APPROVAL_REJECTED,
      });
      await expect(svc.assertSelfMayChangeDocument(ASSAYER, OnboardingDocument.PHOTOGRAPH)).resolves.toBeUndefined();
    });

    it('lets an approved assayer with NO photo on file add one', async () => {
      const svc = serviceWith(null, { ...approved, photograph: null });
      await expect(svc.assertSelfMayChangeDocument(ASSAYER, OnboardingDocument.PHOTOGRAPH)).resolves.toBeUndefined();
    });

    it('leaves staff photo uploads exactly as they were', async () => {
      const svc = serviceWith(photoRow(), approved);
      await expect(controllerWith(svc).attachDocumentFile(ASSAYER, 'PHOTOGRAPH', file, hr)).resolves.toMatchObject({ success: true });
    });

    it('opens once HR has asked for it again (REJECTED)', async () => {
      const svc = serviceWith(photoRow(DocumentVerification.REJECTED), approved);
      await expect(controllerWith(svc).attachDocumentFile(ASSAYER, 'PHOTOGRAPH', file, self)).resolves.toMatchObject({ success: true });
    });

    it('the shared predicate reads approval off the lifecycle', () => {
      expect(hasPassedFinalApproval(AssayerLifecycleStatus.FINAL_APPROVAL)).toBe(false);
      expect(hasPassedFinalApproval(AssayerLifecycleStatus.TRAINING)).toBe(true);
      expect(hasPassedFinalApproval(AssayerLifecycleStatus.INACTIVE, AssayerUnavailableReason.BGV_FAILED)).toBe(false);
      expect(hasPassedFinalApproval(AssayerLifecycleStatus.INACTIVE, null)).toBe(true);
      expect(hasPassedFinalApproval(null)).toBe(false);
    });
  });

  describe("HR's Ask to re-upload", () => {
    const ask = { reason: DocumentRejectionReason.EXPIRED, note: 'Your PAN was reissued — please send the new card.' };

    it('sends a VERIFIED document back: REJECTED with the reason, file and version kept, audited, assayer notified', async () => {
      const row: any = { ...docRow(DocumentVerification.VERIFIED), currentVersionId: 'ver-1', remarks: null };
      const svc = serviceWith(row);
      svc.deriveLegalName = jest.fn(async () => undefined);

      const saved = await svc.requestReupload(ASSAYER, OnboardingDocument.PAN_CARD, 'hr-1', ask);

      expect(saved.verificationStatus).toBe(DocumentVerification.REJECTED);
      expect(saved.rejectionReason).toBe(DocumentRejectionReason.EXPIRED);
      expect(saved.verifiedBy).toBe('hr-1');
      expect(saved.filePaths).toEqual(['scans/original.jpg']); // nothing detached
      expect(saved.currentVersionId).toBe('ver-1'); // the verified version stays in the history
      expect(saved.remarks).toContain('Your PAN was reissued');
      expect(svc.deriveLegalName).toHaveBeenCalledWith(ASSAYER, 'hr-1');
      expect(svc.auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'DOCUMENT_REUPLOAD_REQUESTED',
        previousState: DocumentVerification.VERIFIED,
        newState: DocumentVerification.REJECTED,
        metadata: expect.objectContaining({ keptVersionId: 'ver-1', reason: DocumentRejectionReason.EXPIRED }),
      }));
      expect(svc.notifications.emitSafe).toHaveBeenCalledWith(expect.objectContaining({
        type: 'ASSAYER_IDENTITY_DOCUMENT_REJECTED',
        assayerId: ASSAYER,
        payload: expect.objectContaining({ guidance: ask.note }),
      }));
    });

    it('after it, the assayer can upload again; the new scan re-locks nothing until HR verifies it', async () => {
      const row: any = { ...docRow(DocumentVerification.VERIFIED) };
      const svc = serviceWith(row);
      svc.deriveLegalName = jest.fn(async () => undefined);
      const c = controllerWith(svc);
      await expect(c.attachDocumentFile(ASSAYER, 'PAN_CARD', file, self)).rejects.toBeInstanceOf(ForbiddenException);
      await svc.requestReupload(ASSAYER, OnboardingDocument.PAN_CARD, 'hr-1', ask);
      await expect(c.attachDocumentFile(ASSAYER, 'PAN_CARD', file, self)).resolves.toMatchObject({ success: true });
    });

    it('clears the passbook\'s vouching for the payout destination, as any withdrawal does', async () => {
      const svc = serviceWith({ ...docRow(DocumentVerification.VERIFIED, OnboardingDocument.BANK_PASSBOOK) });
      svc.deriveLegalName = jest.fn(async () => undefined);
      await svc.requestReupload(ASSAYER, OnboardingDocument.BANK_PASSBOOK, 'hr-1', ask);
      expect(svc.assayers.update).toHaveBeenCalledWith({ id: ASSAYER }, { identityVerifiedAt: null });
    });

    it('unlocks the photograph, creating its row when the photo only lived on the person', async () => {
      const person = { id: ASSAYER, lifecycleStatus: AssayerLifecycleStatus.ACTIVE, unavailableReason: null, photograph: 'photos/face.jpg' };
      const svc = serviceWith(null, person);
      const saved = await svc.requestReupload(ASSAYER, OnboardingDocument.PHOTOGRAPH, 'hr-1', { ...ask, reason: DocumentRejectionReason.NOT_THE_PERSON });
      expect(saved.verificationStatus).toBe(DocumentVerification.REJECTED);
      expect(saved.filePaths).toEqual(['photos/face.jpg']);
      svc.onboarding.findOne.mockResolvedValue(saved);
      await expect(svc.assertSelfMayChangeDocument(ASSAYER, OnboardingDocument.PHOTOGRAPH)).resolves.toBeUndefined();
    });

    it('refuses a document that is not verified — pending ones are sent back from their verification', async () => {
      const svc = serviceWith(docRow(DocumentVerification.PENDING));
      await expect(svc.requestReupload(ASSAYER, OnboardingDocument.PAN_CARD, 'hr-1', ask)).rejects.toBeInstanceOf(BadRequestException);
      expect(svc.onboarding.save).not.toHaveBeenCalled();
    });

    it('refuses a second request while the first is still waiting', async () => {
      const svc = serviceWith(docRow(DocumentVerification.REJECTED));
      await expect(svc.requestReupload(ASSAYER, OnboardingDocument.PAN_CARD, 'hr-1', ask)).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses without a sentence for the assayer', async () => {
      const svc = serviceWith(docRow(DocumentVerification.VERIFIED));
      await expect(svc.requestReupload(ASSAYER, OnboardingDocument.PAN_CARD, 'hr-1', { reason: ask.reason, note: 'redo' }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('the route is scoped to the assayer\'s region and returns the row for the envelope to wrap', async () => {
      const svc = serviceWith(docRow(DocumentVerification.VERIFIED));
      svc.requestReupload = jest.fn(async () => ({ id: 'doc-1', verificationStatus: 'REJECTED' }));
      const c = controllerWith(svc);
      const res = await c.requestDocumentReupload(ASSAYER, 'PAN_CARD', ask, hr, { regions: ['NORTH'] });
      expect(c.regionGuard.assertAssayerInScope).toHaveBeenCalledWith(ASSAYER, { regions: ['NORTH'] });
      expect(svc.requestReupload).toHaveBeenCalledWith(ASSAYER, 'PAN_CARD', 'hr-1', ask);
      expect(res).toEqual({ id: 'doc-1', verificationStatus: 'REJECTED' });
    });

    it('carries the same roles and permission as verifying a document', () => {
      const proto = AssayerController.prototype as any;
      for (const key of [ROLES_KEY, PERMISSIONS_KEY]) {
        const expected = Reflect.getMetadata(key, proto.verifyDocument);
        expect(expected).toBeDefined();
        expect(Reflect.getMetadata(key, proto.requestDocumentReupload)).toEqual(expected);
      }
    });
  });
});

/**
 * `GET /assayers/me/capabilities` — the same lock decisions, asked in advance, for the documents
 * the phone can produce, in two reads; and HR's re-upload note reaching the assayer as `hrNote`.
 */
describe('the assayer\'s own capabilities', () => {
  const ASSAYER = 'asr-1';
  const { AssayerSelfServiceController } = jest.requireActual('./assayer-self-service.controller');

  const serviceWith = (rows: any[], person: any) => {
    const svc: any = Object.create(RosterRecordsService.prototype);
    svc.onboarding = { find: jest.fn(async () => rows), findOne: jest.fn(), save: jest.fn(async (r: any) => r) };
    svc.assayers = { findOne: jest.fn(async () => person) };
    return svc;
  };

  it('selfDocumentGates reads the rows and the person once, and judges each requirement', async () => {
    const svc = serviceWith(
      [
        { requirement: OnboardingDocument.PAN_CARD, verificationStatus: DocumentVerification.VERIFIED, isActive: true },
        { requirement: OnboardingDocument.AADHAAR_FRONT, verificationStatus: DocumentVerification.REJECTED, isActive: true, reuploadNote: 'Retake in daylight.' },
      ],
      { id: ASSAYER, lifecycleStatus: AssayerLifecycleStatus.ACTIVE, photograph: 'p.jpg' },
    );
    const gates = await svc.selfDocumentGates(ASSAYER, [
      OnboardingDocument.PAN_CARD, OnboardingDocument.AADHAAR_FRONT, OnboardingDocument.PHOTOGRAPH, OnboardingDocument.NDA,
    ]);
    expect(svc.onboarding.find).toHaveBeenCalledTimes(1);
    expect(svc.assayers.findOne).toHaveBeenCalledTimes(1);
    expect(gates.map((g: any) => [g.requirement, g.mode])).toEqual([
      ['PAN_CARD', 'locked'], ['AADHAAR_FRONT', 'reopened'], ['PHOTOGRAPH', 'locked'], ['NDA', 'direct'],
    ]);
    expect(gates[1].hrNote).toBe('Retake in daylight.');
  });

  it('GET me/capabilities answers for the signed-in assayer only, raw (no envelope)', async () => {
    const c: any = Object.create(AssayerSelfServiceController.prototype);
    c.rosterRecords = { selfDocumentGates: jest.fn(async () => [{ requirement: 'PAN_CARD', mode: 'direct' }]) };
    const out = await c.myCapabilities({ user: { id: ASSAYER, roles: [{ name: 'ASSAYER' }] } });
    expect(c.rosterRecords.selfDocumentGates).toHaveBeenCalledWith(ASSAYER, expect.arrayContaining(['PHOTOGRAPH', 'PAN_CARD', 'PASSPORT']));
    expect(out).toEqual({ fields: expect.any(Array), documents: [{ requirement: 'PAN_CARD', mode: 'direct' }] });
    expect(out.success).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, AssayerSelfServiceController.prototype.myCapabilities)).toEqual(['ASSAYER']);
  });

  it('the old editable-fields route keeps its shape and gains the same field gates', () => {
    const c: any = Object.create(AssayerController.prototype);
    const out = c.getEditableFields({ user: { id: ASSAYER, roles: [{ name: 'ASSAYER' }] } });
    expect(out).toMatchObject({ unrestricted: false, selfEditable: expect.any(Array), hrMaintained: expect.any(Array) });
    expect(out.fields.find((f: any) => f.field === 'panNumber')).toMatchObject({ mode: 'locked', code: 'HR_MAINTAINED_FIELD' });
  });

  it('HR\'s re-upload note is stored where the capability list reads it', async () => {
    const row: any = { id: 'd', assayerId: ASSAYER, requirement: OnboardingDocument.PAN_CARD, verificationStatus: DocumentVerification.VERIFIED, isActive: true, filePaths: ['x'] };
    const svc: any = Object.create(RosterRecordsService.prototype);
    svc.onboarding = { findOne: jest.fn(async () => row), save: jest.fn(async (r: any) => r) };
    svc.assayers = { findOne: jest.fn(async () => ({ id: ASSAYER })), update: jest.fn() };
    svc.assertOwnedAssayer = jest.fn(async () => undefined);
    svc.deriveLegalName = jest.fn(async () => undefined);
    svc.auditService = { recordEventSafe: jest.fn() };
    svc.notifications = { emitSafe: jest.fn() };
    const saved = await svc.requestReupload(ASSAYER, OnboardingDocument.PAN_CARD, 'hr-1', {
      reason: DocumentRejectionReason.ILLEGIBLE, note: 'The number is not readable, please retake.',
    });
    expect(saved.reuploadNote).toBe('The number is not readable, please retake.');
  });
});
