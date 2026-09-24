import { DOCUMENT_REJECTION_GUIDANCE, DocumentRejectionReason } from '@fapoms/shared';
import { en } from '../../i18n/locales/en';
import type { RegistrationDocument } from '../../services/self-registration.service';
import {
  FACE_PHOTO_CAMERA, capturePlanFor, conditionBadgeKey, missingSubmitDocument, photoRequirement, rejectionText,
  rowNoteKey, stillNeeded, uploadReplaceFlags,
} from './document-rows';

const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);

const doc = (requirement: string, files: number, extra: Partial<RegistrationDocument> = {}): RegistrationDocument => ({
  requirement, filePaths: Array.from({ length: files }, (_, i) => `k/${requirement}-${i}.jpg`), ...extra,
});

const ANDROID = { scannerAvailable: true, cameraAvailable: true };
const IOS = { scannerAvailable: false, cameraAvailable: true };
const OLD_APK = { scannerAvailable: true, cameraAvailable: false };

describe('which camera each document row opens', () => {
  it('papers go to the ML Kit scanner on Android, with "or choose file" under it', () => {
    expect(capturePlanFor('PAN_CARD', ANDROID)).toEqual({ primary: 'scanner', secondary: 'files', allowMultipleFiles: false, imagesOnly: false });
  });

  it('the face photo goes to the front camera with a gallery link — never the document scanner', () => {
    expect(capturePlanFor('PHOTOGRAPH', ANDROID)).toMatchObject({ primary: 'faceCamera', secondary: 'gallery', allowMultipleFiles: false });
    expect(capturePlanFor('PHOTOGRAPH', IOS).primary).toBe('faceCamera');
    expect(FACE_PHOTO_CAMERA).toMatchObject({ cameraType: 'front', allowsEditing: true, aspect: [7, 9], quality: 0.85 });
  });

  it('on iOS (no ML Kit) a paper is taken with the plain camera', () => {
    expect(capturePlanFor('PAN_CARD', IOS).primary).toBe('camera');
  });

  it('an APK from before the camera library still works: scanner for papers and the photo, files as the fallback', () => {
    expect(capturePlanFor('PAN_CARD', OLD_APK).primary).toBe('scanner');
    expect(capturePlanFor('PHOTOGRAPH', OLD_APK)).toMatchObject({ primary: 'scanner', imagesOnly: true });
    expect(capturePlanFor('PAN_CARD', { scannerAvailable: false, cameraAvailable: false })).toMatchObject({ primary: 'files', secondary: null });
  });

  it('lets several files be chosen only for documents that have pages', () => {
    expect(capturePlanFor('JOINING_FORM', ANDROID).allowMultipleFiles).toBe(true);
    expect(capturePlanFor('AADHAAR_FRONT', ANDROID).allowMultipleFiles).toBe(false);
  });
});

describe('uploading every file picked', () => {
  it('adds every file on a first capture', () => {
    expect(uploadReplaceFlags(3, false)).toEqual([false, false, false]);
  });

  it('on a retake the first file replaces what was there and the rest are added after it', () => {
    expect(uploadReplaceFlags(3, true)).toEqual([true, false, false]);
    expect(uploadReplaceFlags(1, true)).toEqual([true]);
  });
});

describe('what a row says', () => {
  it('the passbook says a cancelled cheque or statement is fine too', () => {
    expect(rowNoteKey('BANK_PASSBOOK')).toBe('selfRegistration.documents.passbookNote');
    expect(lookup('selfRegistration.documents.passbookNote')).toMatch(/cancelled cheque or bank statement/);
  });

  it('the photo row is one line', () => {
    expect(rowNoteKey('PHOTOGRAPH')).toBe('selfRegistration.documents.photoRow');
    expect(lookup('selfRegistration.documents.photoRow')).toBe('Clear face photo, for your ID card.');
  });

  it('every other row has its tip, and every tip is in the catalogue', () => {
    for (const r of ['PAN_CARD', 'AADHAAR_FRONT', 'JOINING_FORM', 'RENT_AGREEMENT']) {
      const key = rowNoteKey(r);
      expect(key).not.toBeNull();
      expect(typeof lookup(key!)).toBe('string');
    }
  });

  it('only a conditional document carries a badge, and it says when', () => {
    expect(conditionBadgeKey('PAN_CARD')).toBeNull();
    expect(conditionBadgeKey('BANK_PASSBOOK')).toBeNull();
    expect(lookup(conditionBadgeKey('RENT_AGREEMENT')!)).toMatch(/^Only if/);
    expect(lookup(conditionBadgeKey('ELECTRICITY_BILL')!)).toMatch(/^Only if/);
  });
});

describe('a sent-back document always has words', () => {
  it('uses HR’s ask first, then HR’s note', () => {
    const sent = doc('PAN_CARD', 1, { reviewStatus: 'NEEDS_RESUBMIT', rejectionNote: 'Note', rejectionReason: DocumentRejectionReason.ILLEGIBLE });
    expect(rejectionText(sent, [{ kind: 'document', key: 'PAN_CARD', label: 'PAN', message: 'Ask' } as never])).toBe('Ask');
    expect(rejectionText(sent, [])).toBe('Note');
  });

  it('falls back to the standard guidance when HR only picked a reason', () => {
    const sent = doc('PAN_CARD', 1, { reviewStatus: 'NEEDS_RESUBMIT', rejectionReason: DocumentRejectionReason.ILLEGIBLE });
    expect(rejectionText(sent, [])).toBe(DOCUMENT_REJECTION_GUIDANCE[DocumentRejectionReason.ILLEGIBLE]);
  });

  it('says nothing about a document that was not sent back', () => {
    expect(rejectionText(doc('PAN_CARD', 1), [])).toBeNull();
    expect(rejectionText(undefined, [])).toBeNull();
  });
});

describe('still needed before submit', () => {
  const requested = ['PHOTOGRAPH', 'PAN_CARD', 'BANK_PASSBOOK'];
  const ready = { otpVerified: true, hasName: true, hasCategory: true, documentsRequested: requested };

  it('is empty — and so hidden — when everything is in', () => {
    expect(stillNeeded({ ...ready, documents: [doc('PHOTOGRAPH', 1), doc('BANK_PASSBOOK', 1)] })).toEqual([]);
  });

  it('lists only what is missing, each with where to fix it', () => {
    const items = stillNeeded({ ...ready, otpVerified: false, hasCategory: false, documents: [] });
    expect(items).toEqual([
      { key: 'selfRegistration.checklist.phone', step: 1 },
      { key: 'selfRegistration.checklist.category', step: 3 },
      { key: 'selfRegistration.checklist.photo', requirement: 'PHOTOGRAPH' },
      { key: 'selfRegistration.checklist.document', vars: { document: 'Bank Passbook' }, requirement: 'BANK_PASSBOOK' },
    ].map((i) => (i.key === 'selfRegistration.checklist.document' ? { ...i, vars: expect.anything() } : i)));
    items.forEach((i) => expect(typeof lookup(i.key)).toBe('string'));
  });

  it('names the document that is actually missing', () => {
    expect(missingSubmitDocument(requested, [])).toBe('BANK_PASSBOOK');
    expect(missingSubmitDocument(requested, [doc('BANK_PASSBOOK', 1)])).toBeNull();
    expect(missingSubmitDocument(['PAN_CARD'], [])).toBeNull();
  });

  it('finds the face photo by its shape', () => {
    expect(photoRequirement(requested)).toBe('PHOTOGRAPH');
  });
});
