import { OnboardingDocument } from '@fapoms/shared';

/**
 * The same storage key twice is the same file, not a second page.
 *
 * Promotion re-homes an application's scans onto the new record by key, in the step between "the
 * person exists" and "the application is closed" — the step most likely to be repeated, because a
 * failure after it leaves the reviewer pressing Approve again. Appending blindly turned one retry
 * into two copies of every scan, and a document's file list is evidence in a bank audit.
 *
 * The rule itself lives in `RosterRecordsService.attachFile`; this pins the shape of it, which is
 * what the promotion loop depends on.
 */
describe('attaching a file the record already has', () => {
  const attach = (existing: string[], key: string, requirement: OnboardingDocument): string[] => {
    const alreadyAttached = existing ?? [];
    return requirement === OnboardingDocument.PHOTOGRAPH
      ? [key]
      : alreadyAttached.includes(key) ? alreadyAttached : [...alreadyAttached, key];
  };

  it('changes nothing when the key is already there', () => {
    expect(attach(['uploads/pan.png'], 'uploads/pan.png', OnboardingDocument.PAN_CARD))
      .toEqual(['uploads/pan.png']);
  });

  it('still appends a genuinely new page', () => {
    expect(attach(['uploads/a1.png'], 'uploads/a2.png', OnboardingDocument.AADHAAR_FRONT))
      .toEqual(['uploads/a1.png', 'uploads/a2.png']);
  });

  it('still replaces a photograph, because a face is not evidence that accumulates', () => {
    expect(attach(['uploads/old.jpg'], 'uploads/new.jpg', OnboardingDocument.PHOTOGRAPH))
      .toEqual(['uploads/new.jpg']);
  });
});
