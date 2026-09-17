import { OnboardingDocument } from '@fapoms/shared';
import { scanPlanFor, scanFileName } from './document-scan-options';

/**
 * The phone and the browser answer to the same table. These pin the half of it the phone can act
 * on — what the shapes and finishes mean here is Google's editor's business, and what the table
 * itself says is pinned in `shared/document-scan-profile.spec.ts`.
 */
describe('opening the scanner for a particular document', () => {
  it('caps a card at the one side it has', () => {
    expect(scanPlanFor(OnboardingDocument.PAN_CARD).options.pageLimit).toBe(1);
    expect(scanPlanFor(OnboardingDocument.AADHAAR_FRONT).options.pageLimit).toBe(1);
    expect(scanPlanFor(OnboardingDocument.PHOTOGRAPH).options.pageLimit).toBe(1);
  });

  it('leaves a form uncapped, because nobody knows how long theirs is', () => {
    expect(scanPlanFor(OnboardingDocument.NDA).options.pageLimit).toBeUndefined();
    expect(scanPlanFor(OnboardingDocument.JOINING_FORM).options.pageLimit).toBeUndefined();
  });

  it('keeps the gallery open as this platform’s "choose a file"', () => {
    expect(scanPlanFor(OnboardingDocument.PAN_CARD).options.galleryImportAllowed).toBe(true);
    expect(scanPlanFor(null).options.galleryImportAllowed).toBe(true);
  });

  it('asks for the pages and the assembled PDF, as the upload path expects', () => {
    expect(scanPlanFor(OnboardingDocument.NDA).options.resultFormat).toBe('both');
  });

  /** An audit packet or a photo on a query has no requirement, and must still scan. */
  it('falls back to an uncapped scan for anything it does not recognise', () => {
    expect(scanPlanFor('NOT_A_DOCUMENT').options.pageLimit).toBeUndefined();
    expect(scanPlanFor(undefined).profile.shape).toBe('free');
  });

  it('carries the same profile the browser scanner reads', () => {
    const plan = scanPlanFor(OnboardingDocument.AADHAAR_BACK);
    expect(plan.profile.shape).toBe('card');
    expect(plan.profile.hintKey).toBe('aadhaarBack');
  });
});

describe('naming a scan', () => {
  const when = new Date(2026, 8, 16, 14, 5, 11);

  it('names it after the document, the way the browser does', () => {
    expect(scanFileName('PAN card', 'pdf', when)).toBe('pan-card.pdf');
    expect(scanFileName('Aadhaar (back)', 'jpg', when)).toBe('aadhaar-back.jpg');
  });

  /**
   * Eight documents on a record all called `Scan_2026-09-16_…` is what this replaces. The timestamp
   * survives only where there is genuinely nothing better — an audit packet the assayer names, a
   * photo attached to a query.
   */
  it('falls back to the timestamp when nothing says what the document is', () => {
    expect(scanFileName(null, 'pdf', when)).toBe('Scan_2026-09-16_14-05-11.pdf');
    expect(scanFileName('', 'pdf', when)).toBe('Scan_2026-09-16_14-05-11.pdf');
    expect(scanFileName('!!!', 'pdf', when)).toBe('Scan_2026-09-16_14-05-11.pdf');
  });
});
