import {
  AddressCheckMethod, AddressCheckResult, CourtCheckResult, addressCheckSummary, bgvClearGaps, bgvClearRefusal, bgvPartStates, cibilSummary,
} from './bgv-parts';
import { CibilBand } from './assayer-roster-vocabulary';

/**
 * A background verification is clear only with its address, CIBIL and court checks on it
 * (owner, 2026-09-24) — and not while one of them found something.
 */
describe('the three parts of a background verification', () => {
  const all = {
    addressCheckMethod: AddressCheckMethod.PHYSICAL,
    addressCheckResult: AddressCheckResult.VERIFIED,
    cibilBand: CibilBand.GOOD,
    courtCheckResult: CourtCheckResult.NO_RECORD,
  };

  it('lets a check with all three, all clean, be recorded as clear', () => {
    expect(bgvClearRefusal(all)).toBeNull();
    expect(bgvClearGaps(all)).toEqual([]);
    expect(bgvClearRefusal({ ...all, addressCheckMethod: AddressCheckMethod.DIGITAL })).toBeNull();
  });

  it('names every part still to fill in', () => {
    expect(bgvClearRefusal({})).toMatch(/Still to fill in: the address check \(physical or digital\), the CIBIL check and the court check\./);
    expect(bgvClearRefusal({ ...all, courtCheckResult: null })).toMatch(/Still to fill in: the court check\.$/);
    expect(bgvClearGaps({ ...all, cibilBand: undefined })).toEqual(['the CIBIL check']);
  });

  it('wants both how the address was checked and what it found', () => {
    expect(bgvClearRefusal({ ...all, addressCheckMethod: null })).toMatch(/Still to fill in: the address check/);
    expect(bgvClearRefusal({ ...all, addressCheckResult: null })).toMatch(/Still to fill in: the address check/);
  });

  it('does not count a CIBIL check that never came back', () => {
    for (const band of [CibilBand.NOT_CHECKED, CibilBand.CHECK_FAILED]) {
      expect(bgvClearRefusal({ ...all, cibilBand: band })).toMatch(/Still to fill in: the CIBIL check/);
    }
  });

  /** "No credit history" is an answer from the bureau, and a poor score is the approver's judgement. */
  it('counts any answer from the bureau, including no history and a poor score', () => {
    for (const band of [CibilBand.NO_CREDIT_HISTORY, CibilBand.POOR, CibilBand.BAD, CibilBand.AVERAGE]) {
      expect(bgvClearRefusal({ ...all, cibilBand: band })).toBeNull();
    }
  });

  it('refuses clear when the court or the address check found something', () => {
    expect(bgvClearRefusal({ ...all, courtCheckResult: CourtCheckResult.CRIMINAL_CASE }))
      .toBe('The court check found a criminal case, so the result cannot be clear — record what was found instead.');
    expect(bgvClearRefusal({ ...all, courtCheckResult: CourtCheckResult.CIVIL_CASE })).toMatch(/^The court check found a civil case/);
    expect(bgvClearRefusal({ ...all, addressCheckResult: AddressCheckResult.DISCREPANCY })).toMatch(/^The address check found a discrepancy/);
    expect(bgvClearRefusal({ ...all, addressCheckResult: AddressCheckResult.UNABLE_TO_VERIFY })).toMatch(/^The address could not be verified/);
  });

  it('says what is missing before what was found', () => {
    expect(bgvClearGaps({ ...all, cibilBand: null, courtCheckResult: CourtCheckResult.CIVIL_CASE }))
      .toEqual(['the CIBIL check', 'the court check found a civil case']);
  });

  it('does not take a value it does not know as recorded', () => {
    const states = bgvPartStates({ addressCheckMethod: 'DRONE', addressCheckResult: 'VERIFIED', cibilBand: 'EXCELLENT', courtCheckResult: 'MAYBE' });
    expect(states.map((s) => s.recorded)).toEqual([false, false, false]);
  });

  it('reads the CIBIL check back with its score', () => {
    expect(cibilSummary({ cibilBand: CibilBand.GOOD, cibilScore: 747 })).toBe('Good (747)');
    expect(cibilSummary({ cibilBand: CibilBand.NO_CREDIT_HISTORY, cibilScore: null })).toBe('No credit history');
    expect(cibilSummary({})).toBeNull();
  });

  it('reads the address check back in one line', () => {
    expect(addressCheckSummary(all)).toBe('Address verified (physical visit)');
    expect(addressCheckSummary({ addressCheckMethod: AddressCheckMethod.DIGITAL, addressCheckResult: AddressCheckResult.DISCREPANCY }))
      .toBe('Discrepancy found (digital)');
    expect(addressCheckSummary({})).toBeNull();
  });
});
