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
    svc.onboarding = { findOne: jest.fn().mockResolvedValue(row), save: jest.fn(async (d: any) => d) };
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
    await expect(svc.verifyDocument('doc-1', 'REJECTED', 'actor-1')).resolves.toMatchObject({
      verificationStatus: 'REJECTED',
    });
  });

  it('still refuses to VERIFY without a number, because there is nothing to have checked', async () => {
    const svc = serviceFor(rowWith(), { id: 'asr-1', panNumber: null });
    await expect(svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1'))
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
    await expect(svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1'))
      .rejects.toThrow(/no scan of this/i);
  });

  it('verifies when the scan and the number are both there', async () => {
    const svc = serviceFor(rowWith());
    await expect(svc.verifyDocument('doc-1', 'VERIFIED', 'actor-1')).resolves.toMatchObject({
      verificationStatus: 'VERIFIED',
    });
  });

  /** A rejection needs no scan either — "nothing arrived" is a thing a reviewer must be able to say. */
  it('rejects a document with no scan', async () => {
    const svc = serviceFor(rowWith({ filePaths: [] }), { id: 'asr-1', panNumber: null });
    await expect(svc.verifyDocument('doc-1', 'REJECTED', 'actor-1')).resolves.toBeTruthy();
  });
});
