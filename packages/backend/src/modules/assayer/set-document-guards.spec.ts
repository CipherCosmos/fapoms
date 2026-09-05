import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OnboardingDocument } from '@fapoms/shared';
import { RosterRecordsService } from './roster-records.service';
import { AssayerController } from './assayer.controller';

/**
 * The paperwork route is a fourth way into `assayers.pan_number` and `assayers.aadhaar_number`.
 *
 * For PAN and the two Aadhaar requirements the number is stored on the PERSON rather than the
 * document row, so `PUT :assayerId/document/:requirement` writes those two columns directly. It
 * took `@Body() body: any`, which leaves class-validator nothing to attach to, so it reached them
 * with no format check while `POST /assayers` and `PUT /assayers/:id` both refused a malformed
 * value through `@IsPanFormat()` / `@IsAadhaarNumber()`.
 *
 * The rule cannot live on a DTO: which of the two applies depends on the `:requirement` route
 * parameter, which a DTO cannot see. So it is enforced here, through the same `@fapoms/shared`
 * validators the DTOs use — one implementation, asked the same question by every path.
 */
describe('recording a document number', () => {
  const person = () => ({ id: 'asr-1', panNumber: null, aadhaarNumber: null, updatedBy: null });

  const serviceWith = (row: any) => {
    const svc: any = Object.create(RosterRecordsService.prototype);
    svc.assayers = { findOne: jest.fn().mockResolvedValue(row), save: jest.fn(async (p: any) => p) };
    svc.onboarding = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((d: any) => ({ ...d })),
      save: jest.fn(async (d: any) => d),
    };
    return svc;
  };

  const set = (svc: any, requirement: OnboardingDocument, documentNumber: string) =>
    svc.setDocument('asr-1', requirement, { documentNumber }, 'actor-1');

  it('refuses a PAN that is not shaped like a PAN', async () => {
    const svc = serviceWith(person());
    await expect(set(svc, OnboardingDocument.PAN_CARD, 'NOTAPAN12'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(svc.assayers.save).not.toHaveBeenCalled();
  });

  it('accepts a well-formed PAN', async () => {
    const svc = serviceWith(person());
    await set(svc, OnboardingDocument.PAN_CARD, 'ABCDE1234F');
    expect(svc.assayers.save).toHaveBeenCalled();
    expect(svc.assayers.save.mock.calls[0][0].panNumber).toBe('ABCDE1234F');
  });

  /**
   * Twelve digits is not the test — the check digit is. A mistyped Aadhaar that satisfies `\d{12}`
   * is indistinguishable from a real one afterwards, and this number is precisely what a human is
   * later asked to check the scan against.
   */
  it('refuses twelve digits whose Verhoeff check digit does not match', async () => {
    const svc = serviceWith(person());
    await expect(set(svc, OnboardingDocument.AADHAAR_FRONT, '123456789012'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('names a placeholder Aadhaar for what it is, rather than calling it a typo', async () => {
    const svc = serviceWith(person());
    await set(svc, OnboardingDocument.AADHAAR_FRONT, '000000000000').then(
      () => { throw new Error('should have been refused'); },
      (err: any) => expect(err.message).toMatch(/placeholder/i),
    );
  });

  it('accepts a valid Aadhaar', async () => {
    const svc = serviceWith(person());
    await set(svc, OnboardingDocument.AADHAAR_BACK, '234567890124');
    expect(svc.assayers.save.mock.calls[0][0].aadhaarNumber).toBe('234567890124');
  });

  it('leaves a blank number alone rather than validating emptiness', async () => {
    // Clearing the field is a legitimate edit; it must not be judged against the format rule.
    const svc = serviceWith(person());
    await set(svc, OnboardingDocument.PAN_CARD, '');
    expect(svc.assayers.save.mock.calls[0][0].panNumber).toBeNull();
  });
});

/**
 * The number on a PAN or Aadhaar card is HR's to enter, not the card-holder's.
 *
 * `panNumber` and `aadhaarNumber` are in `HR_MAINTAINED_ASSAYER_FIELDS`, and `PUT /assayers/:id`
 * refuses a non-staff caller who touches them. This route reaches the same two columns by a
 * different door, and `assertSelfOrPrivileged` guards only against editing SOMEBODY ELSE — so an
 * assayer could set their OWN PAN from the paperwork screen while the front door refused exactly
 * that write. Uploading the scan stays open to them; it is the number a human checks the scan
 * against that stays HR's.
 */
describe('who may record a PAN or Aadhaar number', () => {
  const controller = () => {
    const c: any = Object.create(AssayerController.prototype);
    c.rosterRecords = { setDocument: jest.fn().mockResolvedValue({ ok: true }) };
    // None of these calls pass a scope, so the real guard would no-op regardless — this mock
    // exists only so `setDocument`'s unconditional region-scope check has something to call.
    c.regionGuard = { assertAssayerInScope: jest.fn().mockResolvedValue(undefined) };
    return c;
  };

  const req = (roles: string[], id = 'asr-1') => ({ user: { id, roles } });

  it('refuses an assayer setting their own PAN number', async () => {
    const c = controller();
    await expect(
      c.setDocument('asr-1', 'PAN_CARD', { documentNumber: 'ABCDE1234F' }, req(['ASSAYER'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(c.rosterRecords.setDocument).not.toHaveBeenCalled();
  });

  it.each(['AADHAAR_FRONT', 'AADHAAR_BACK'])('refuses an assayer setting their own %s number', async (req_) => {
    const c = controller();
    await expect(
      c.setDocument('asr-1', req_, { documentNumber: '234567890124' }, req(['ASSAYER'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still lets an assayer record that the scan arrived', async () => {
    // The point of the guard is the number, not the paperwork. Blocking this too would take away
    // the whole reason the phone half of registration exists.
    const c = controller();
    await c.setDocument('asr-1', 'PAN_CARD', { softCopyReceived: true }, req(['ASSAYER']));
    expect(c.rosterRecords.setDocument).toHaveBeenCalled();
  });

  it('lets an assayer record a number on a document whose number is not on the person', async () => {
    const c = controller();
    await c.setDocument('asr-1', 'DRIVING_LICENCE', { documentNumber: 'MH0120220001234' }, req(['ASSAYER']));
    expect(c.rosterRecords.setDocument).toHaveBeenCalled();
  });

  it('lets HR set it, which is whose job it is', async () => {
    const c = controller();
    await c.setDocument('asr-1', 'PAN_CARD', { documentNumber: 'ABCDE1234F' }, req(['OPERATIONS'], 'u-9'));
    expect(c.rosterRecords.setDocument).toHaveBeenCalled();
  });
});

/**
 * What a reviewer must have in front of them before the record says somebody checked it.
 *
 * Both rules below were absent, and their absence pointed in opposite directions: one made the
 * commonest rejection impossible to record, and the other let a verification be recorded against
 * nothing at all.
 */
describe('verifying an identity document', () => {
  const rowWith = (over: Record<string, unknown> = {}) => ({
    id: 'doc-1',
    assayerId: 'asr-1',
    requirement: OnboardingDocument.PAN_CARD,
    filePaths: ['scans/pan.jpg'],
    verificationStatus: null,
    documentNumber: null,
    ...over,
  });

  const serviceFor = (row: any, person: any = { id: 'asr-1', panNumber: 'ABCDE1234F' }) => {
    const svc: any = Object.create(RosterRecordsService.prototype);
    svc.onboarding = {
      findOne: jest.fn().mockResolvedValue(row),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (d: any) => d),
    };
    svc.assayers = { findOne: jest.fn().mockResolvedValue(person), update: jest.fn() };
    svc.auditService = { recordEventSafe: jest.fn() };
    return svc;
  };

  /**
   * The bug this pins: the number was demanded for every verdict that was not PENDING, REJECTED
   * included. You reject an illegible scan precisely *because* you could not read the number off
   * it, so the guard asked the reviewer for the one thing they were reporting they could not get —
   * and the commonest rejection of all could never be recorded.
   */
  it('rejects a scan whose number could not be read', async () => {
    const svc = serviceFor(rowWith(), { id: 'asr-1', panNumber: null });
    await expect(svc.verifyDocument('doc-1', 'REJECTED', 'actor-1', undefined,
      { rejectionReason: 'ILLEGIBLE' as any })).resolves.toMatchObject({
      verificationStatus: 'REJECTED',
    });
  });

  /** What a PAN card prints, so the attestation rules are satisfied and the number rule is isolated. */
  const printed = {
    holderName: 'Ramesh Kumar', holderDateOfBirth: '1980-04-01', holderGuardianName: 'Suresh Kumar',
  };

  it('still refuses to VERIFY without a number, because there is nothing to have checked', async () => {
    const svc = serviceFor(rowWith(), { id: 'asr-1', panNumber: null, displayName: 'Ramesh Kumar' });
    await expect(svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1', undefined, printed))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * The roster import wrote 11,160 rows saying a document was received with no file behind any of
   * them. Without this rule every one could be marked verified in a click, and the record would
   * then carry a name and a timestamp asserting somebody checked a scan that does not exist —
   * worse than the tick it replaced.
   */
  it('refuses to verify a document with no scan on file', async () => {
    const svc = serviceFor(rowWith({ filePaths: [] }));
    await expect(svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1', undefined, printed))
      .rejects.toThrow(/no scan of this/i);
  });

  it('verifies when the scan, the number and the printed details are all there', async () => {
    const svc = serviceFor(rowWith(), { id: 'asr-1', panNumber: 'ABCDE1234F', displayName: 'Ramesh Kumar' });
    await expect(svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1', undefined, printed))
      .resolves.toMatchObject({ verificationStatus: 'VERIFIED' });
  });

  /** A rejection needs no scan either — "nothing arrived" is a thing a reviewer must be able to say. */
  it('rejects a document with no scan', async () => {
    const svc = serviceFor(rowWith({ filePaths: [] }), { id: 'asr-1', panNumber: null });
    await expect(svc.verifyDocument('doc-1', 'REJECTED', 'actor-1', undefined,
      { rejectionReason: 'INCOMPLETE_CAPTURE' as any })).resolves.toBeTruthy();
  });
});

/**
 * What a verification actually attests to.
 *
 * Before these rules a verification recorded that somebody had pressed a button. It compared
 * nothing, because the name printed on the card was never written down anywhere — so the record
 * could carry a confident VERIFIED against a document belonging to a different person entirely.
 */
describe('attesting to what the document says', () => {
  const docRow = (over: Record<string, unknown> = {}) => ({
    id: 'doc-1', assayerId: 'asr-1', requirement: OnboardingDocument.PAN_CARD,
    filePaths: ['scans/pan.jpg'], verificationStatus: null, documentNumber: 'ABCDE1234F',
    holderName: null, holderDateOfBirth: null, holderGender: null,
    holderGuardianName: null, holderAddress: null, remarks: null, rejectionReason: null,
    ...over,
  });

  const svcFor = (row: any, displayName = 'Ramesh Kumar') => {
    const svc: any = Object.create(RosterRecordsService.prototype);
    svc.onboarding = {
      findOne: jest.fn().mockResolvedValue(row),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (d: any) => d),
    };
    svc.assayers = {
      findOne: jest.fn().mockResolvedValue({
        id: 'asr-1', displayName, panNumber: 'ABCDE1234F', aadhaarNumber: '234123412346',
      }),
      update: jest.fn(),
    };
    svc.auditService = { recordEventSafe: jest.fn() };
    return svc;
  };

  const attest = (over: Record<string, unknown> = {}) => ({
    holderName: 'Ramesh Kumar', holderDateOfBirth: '1980-04-01',
    holderGuardianName: 'Suresh Kumar', ...over,
  });

  it('refuses to verify until the reviewer records what the card says', async () => {
    const svc = svcFor(docRow());
    await expect(svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1'))
      .rejects.toThrow(/record what it says/i);
  });

  /**
   * A PAN prints the father's name where other documents print an address, and an Aadhaar's
   * address is on the back. Asking for a field the card does not carry teaches a reviewer that the
   * form asks for things that are not there.
   */
  it('asks only for the fields this document actually prints', async () => {
    const svc = svcFor(docRow());
    await expect(svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1', undefined, attest()))
      .resolves.toMatchObject({ verificationStatus: 'VERIFIED' });

    const front = svcFor(docRow({ requirement: OnboardingDocument.AADHAAR_FRONT }));
    // No address: it is on the back, and the back is its own requirement.
    await expect(front.verifyDocument('doc-1', 'VERIFIED', 'actor-1', undefined, {
      holderName: 'Ramesh Kumar', holderDateOfBirth: '1980-04-01', holderGender: 'M',
    })).resolves.toBeTruthy();
  });

  it('records how well the name agreed, as evidence a human saw it', async () => {
    const svc = svcFor(docRow(), 'R Kumar');
    const saved = await svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1', undefined, attest());
    expect(saved.nameMatchGrade).toBe('STRONG');
  });

  it('refuses a name that does not agree, unless the reviewer says why', async () => {
    const svc = svcFor(docRow(), 'Suresh Kumar');
    await expect(svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1', undefined, attest()))
      .rejects.toThrow(/does not match the name on the record/i);

    const withReason = svcFor(docRow(), 'Suresh Kumar');
    const saved = await withReason.verifyDocument('doc-1', 'VERIFIED', 'actor-1', undefined,
      attest({ nameMismatchNote: 'Married name; deed poll on file with HR.' }));
    expect(saved.nameMatchGrade).toBe('MISMATCH');
    expect(saved.nameMatchNote).toMatch(/deed poll/);
  });

  it('refuses a rejection that does not say why', async () => {
    const svc = svcFor(docRow());
    await expect(svc.verifyDocument('doc-1', 'REJECTED', 'actor-1'))
      .rejects.toThrow(/say why/i);
  });

  it('keeps the reason on a rejection and clears it on a later verification', async () => {
    const svc = svcFor(docRow());
    const rejected = await svc.verifyDocument('doc-1', 'REJECTED', 'actor-1', undefined,
      { rejectionReason: 'ILLEGIBLE' });
    expect(rejected.rejectionReason).toBe('ILLEGIBLE');

    const again = svcFor(docRow({ verificationStatus: 'REJECTED', rejectionReason: 'ILLEGIBLE' }));
    const verified = await again.verifyDocument('doc-1', 'VERIFIED', 'actor-1', undefined, attest());
    expect(verified.rejectionReason).toBeNull();
  });
});

/**
 * The ways a verification stops being true.
 *
 * The number changing was covered. A new scan landing on a verified row was not, and neither was
 * the other side of the comparison moving — which is the one that matters, because it is reachable
 * in two ordinary steps.
 */
describe('withdrawing a verification whose evidence no longer stands', () => {
  const verifiedRow = (over: Record<string, unknown> = {}) => ({
    id: 'doc-1', assayerId: 'asr-1', requirement: OnboardingDocument.AADHAAR_FRONT,
    filePaths: ['scans/aadhaar.jpg'], verificationStatus: 'VERIFIED',
    holderName: 'Ramesh Kumar', nameMatchGrade: 'EXACT', nameMatchNote: null,
    verifiedAt: new Date(), verifiedBy: 'actor-0', remarks: null, ...over,
  });

  const svc = (rows: any[]) => {
    const s: any = Object.create(RosterRecordsService.prototype);
    s.onboarding = {
      find: jest.fn().mockResolvedValue(rows),
      findOne: jest.fn().mockResolvedValue(rows[0]),
      create: jest.fn((d: any) => d),
      save: jest.fn(async (d: any) => d),
    };
    s.assayers = { findOne: jest.fn().mockResolvedValue({ id: 'asr-1' }), update: jest.fn() };
    s.auditService = { recordEventSafe: jest.fn() };
    return s;
  };

  /**
   * Verify a genuine document under the name it matches, then rename the record to anything at all.
   * Without this the attestation survives, still saying VERIFIED, having compared a name that is no
   * longer on the record.
   */
  it('undoes a verification when the name it was checked against changes', async () => {
    const s = svc([verifiedRow()]);
    const count = await s.revalidateAfterNameChange('asr-1', 'actor-1');

    expect(count).toBe(1);
    expect(s.onboarding.save.mock.calls[0][0]).toMatchObject({
      verificationStatus: 'PENDING', verifiedAt: null, nameMatchGrade: null,
    });
    expect(s.auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'IDENTITY_DOCUMENT_VERIFICATION_INVALIDATED' }),
    );
  });

  it('leaves the address side alone, because it never carried a name', async () => {
    const s = svc([verifiedRow({ requirement: OnboardingDocument.AADHAAR_BACK })]);
    expect(await s.revalidateAfterNameChange('asr-1', 'actor-1')).toBe(0);
  });

  it('undoes a verification when a different scan replaces the one that was checked', async () => {
    const s = svc([verifiedRow()]);
    const saved = await s.attachFile('asr-1', OnboardingDocument.AADHAAR_FRONT, 'scans/new.jpg', 'actor-1');
    expect(saved.verificationStatus).toBe('PENDING');
  });

  /** A retake answers the rejection, so the row stops saying "sent back". */
  it('clears a rejection when the replacement arrives', async () => {
    const s = svc([verifiedRow({ verificationStatus: 'REJECTED', rejectionReason: 'ILLEGIBLE' })]);
    const saved = await s.attachFile('asr-1', OnboardingDocument.AADHAAR_FRONT, 'scans/new.jpg', 'actor-1');
    expect(saved.verificationStatus).toBe('PENDING');
    expect(saved.rejectionReason).toBeNull();
  });

  /**
   * A face is not evidence with a history. Appending would grow the array every time somebody
   * retakes their photo, while `assayers.photograph` silently followed the last one anyway.
   */
  it('replaces a photograph rather than accumulating every retake', async () => {
    const s = svc([verifiedRow({ requirement: OnboardingDocument.PHOTOGRAPH, filePaths: ['old.jpg'] })]);
    const saved = await s.attachFile('asr-1', OnboardingDocument.PHOTOGRAPH, 'new.jpg', 'actor-1');
    expect(saved.filePaths).toEqual(['new.jpg']);
  });

  it('still keeps every page of a document that is not a photograph', async () => {
    const s = svc([verifiedRow({ filePaths: ['page1.jpg'] })]);
    const saved = await s.attachFile('asr-1', OnboardingDocument.AADHAAR_FRONT, 'page2.jpg', 'actor-1');
    expect(saved.filePaths).toEqual(['page1.jpg', 'page2.jpg']);
  });
});
