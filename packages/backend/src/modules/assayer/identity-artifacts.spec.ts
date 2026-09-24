import { AssayerLifecycleStatus, BackgroundCheckVerdict } from '@fapoms/shared';
import {
  ID_CARD_VALIDITY_DEFAULTS,
  assessBackgroundGate,
  assessIdentityArtifact,
  idCardValidTill,
} from './identity-artifacts';

/**
 * The December-31st table, and the artifact gate.
 *
 * The validity rule earns table-driven tests because its first version was pinned by a test
 * asserting the absurd case as correct: a card generated on December 31st expiring the same day.
 * The owner caught it by looking at a drawing of the process. Every case here is a date somebody
 * will actually join on.
 */
describe('when an ID card expires', () => {
  const calendarYear = { ...ID_CARD_VALIDITY_DEFAULTS };

  it('a mid-year card expires December 31st of its own year', () => {
    const v = idCardValidTill(new Date(2026, 8, 12), calendarYear);
    expect([v.getFullYear(), v.getMonth(), v.getDate()]).toEqual([2026, 11, 31]);
  });

  it('the December 31st joiner — the owner\'s own case — carries to the END OF NEXT YEAR', () => {
    const v = idCardValidTill(new Date(2026, 11, 31), calendarYear);
    expect([v.getFullYear(), v.getMonth(), v.getDate()]).toEqual([2027, 11, 31]);
  });

  it('anyone inside the grace window carries to next year; the day before it does not', () => {
    // graceDays = 45: November 17th has 44 days left (inside), November 16th has 45 (outside).
    const inside = idCardValidTill(new Date(2026, 10, 17), calendarYear);
    const outside = idCardValidTill(new Date(2026, 10, 16), calendarYear);
    expect(inside.getFullYear()).toBe(2027);
    expect(outside.getFullYear()).toBe(2026);
  });

  it('grace set to zero restores the strict rule, absurd case included', () => {
    const strict = { ...calendarYear, graceDays: 0 };
    const v = idCardValidTill(new Date(2026, 11, 31), strict);
    expect([v.getFullYear(), v.getDate()]).toEqual([2026, 31]);
  });

  it('rolling mode gives every card the same length from its own issue date', () => {
    const rolling = { ...calendarYear, mode: 'ROLLING_MONTHS' as const, rollingMonths: 12 };
    const v = idCardValidTill(new Date(2026, 11, 31), rolling);
    expect([v.getFullYear(), v.getMonth(), v.getDate()]).toEqual([2027, 11, 31]);
  });

  it('rolling mode clamps a month-end overflow instead of granting extra days', () => {
    // Jan 31 + 1 month: February has no 31st. The card ends on the last day of February,
    // not on March 2nd or 3rd.
    const rolling = { ...calendarYear, mode: 'ROLLING_MONTHS' as const, rollingMonths: 1 };
    const v = idCardValidTill(new Date(2026, 0, 31), rolling);
    expect([v.getMonth(), v.getDate()]).toEqual([1, 28]);
  });
});

describe('who may be handed the artifact', () => {
  const vetted = {
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
    identityOk: true,
    identityMissing: [],
    latestVerdict: BackgroundCheckVerdict.CLEAR,
  };

  it('a fully vetted active person: nothing refused, nothing gated', () => {
    expect(assessIdentityArtifact(vetted)).toEqual({ refusals: [], gated: [] });
  });

  it('not being active refuses in EVERY mode — there is no backlog argument for this one', () => {
    const a = assessIdentityArtifact({ ...vetted, lifecycleStatus: AssayerLifecycleStatus.INVITED });
    expect(a.refusals).toHaveLength(1);
    expect(a.refusals[0]).toContain('invited');
  });

  it('an unverified identity is gated, and names the documents', () => {
    const a = assessIdentityArtifact({ ...vetted, identityOk: false, identityMissing: ['PAN card', 'Aadhaar card'] });
    expect(a.refusals).toEqual([]);
    expect(a.gated[0]).toContain('PAN card and Aadhaar card');
  });

  it('no background check at all is gated, and NOT_CHECKED counts as none', () => {
    expect(assessIdentityArtifact({ ...vetted, latestVerdict: null }).gated[0]).toContain('no completed background check');
    expect(assessIdentityArtifact({ ...vetted, latestVerdict: BackgroundCheckVerdict.NOT_CHECKED }).gated[0])
      .toContain('no completed background check');
  });

  it('an adverse verdict is gated by name — recorded, not rounded to clear', () => {
    const a = assessIdentityArtifact({ ...vetted, latestVerdict: BackgroundCheckVerdict.CRIMINAL_CASE });
    expect(a.gated[0]).toContain('criminal case');
  });

  it('the gaps stack — an invited, unverified, unchecked person hears all of it', () => {
    const a = assessIdentityArtifact({
      lifecycleStatus: AssayerLifecycleStatus.INVITED,
      identityOk: false,
      identityMissing: [],
      latestVerdict: null,
    });
    expect(a.refusals).toHaveLength(1);
    expect(a.gated).toHaveLength(2);
  });
});

describe('the background-verification exit rule', () => {
  /**
   * MANDATORY (owner, 2026-09-23). Finishing onboarding needs a completed, clear check AND the
   * report it came from. There is no warn mode any more — it defaulted to warn, which let anybody
   * out of background verification with no check at all.
   */
  const ONBOARDING_EXITS = ['leave-bgv', 'finish-onboarding'] as const;

  it.each(ONBOARDING_EXITS)('%s passes with a clear verdict and the report on file', (site) => {
    expect(assessBackgroundGate(BackgroundCheckVerdict.CLEAR, site, true)).toEqual({ refusal: null });
  });

  it.each(ONBOARDING_EXITS)('%s refuses when no completed check is on file, whatever the settings', (site) => {
    expect(assessBackgroundGate(null, site, true).refusal).toMatch(/mandatory and no completed check/);
    expect(assessBackgroundGate(BackgroundCheckVerdict.NOT_CHECKED, site, true).refusal).toMatch(/mandatory/);
  });

  it.each(ONBOARDING_EXITS)('%s refuses a clear verdict whose report was never uploaded', (site) => {
    expect(assessBackgroundGate(BackgroundCheckVerdict.CLEAR, site, false).refusal).toMatch(/report has not been uploaded/);
  });

  /** Its address, CIBIL and court checks (2026-09-24) — a clear check from before them does not count. */
  it.each(ONBOARDING_EXITS)('%s refuses a clear check missing any of its three parts, and names them', (site) => {
    expect(assessBackgroundGate(BackgroundCheckVerdict.CLEAR, site, true, ['the court check']).refusal)
      .toMatch(/^the background check on file is missing the court check\. /);
    expect(assessBackgroundGate(BackgroundCheckVerdict.CLEAR, site, true, ['the address check (physical or digital)', 'the CIBIL check', 'the court check']).refusal)
      .toMatch(/missing the address check \(physical or digital\), the CIBIL check and the court check\./);
  });

  it('a working return is not asked for the parts either', () => {
    expect(assessBackgroundGate(BackgroundCheckVerdict.CLEAR, 'activate', false, ['the CIBIL check'])).toEqual({ refusal: null });
  });

  it.each([
    BackgroundCheckVerdict.CIVIL_CASE,
    BackgroundCheckVerdict.CRIMINAL_CASE,
    BackgroundCheckVerdict.ADVERSE_FINDING,
  ])('an adverse verdict (%s) refuses at every site, report or not', (verdict) => {
    for (const site of [...ONBOARDING_EXITS, 'activate'] as const) {
      expect(assessBackgroundGate(verdict, site, true).refusal).toContain('adverse');
    }
  });

  /**
   * A return from leave or suspension is not onboarding, and most of the working roster predates
   * these checks — locking their returns would stop the business without vetting anybody. The
   * adverse arm above still guards this site.
   */
  it('a working return to active needs no check, only the absence of an adverse one', () => {
    expect(assessBackgroundGate(null, 'activate', false)).toEqual({ refusal: null });
    expect(assessBackgroundGate(BackgroundCheckVerdict.NOT_CHECKED, 'activate', false)).toEqual({ refusal: null });
  });
});
