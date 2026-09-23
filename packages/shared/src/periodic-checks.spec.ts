import {
  CheckType, DEFAULT_RECHECK_POLICY, addMonthsToDateKey, complianceWorkBlockers, recheckStanding,
  checkTypeForReport, isAdverseVerdict, isRecheckedLifecycle,
} from './periodic-checks';
import { BackgroundCheckVerdict, OnboardingDocument } from './assayer-roster-vocabulary';

/** Checks done over time — when each falls due, and when it starts holding somebody from work. */
describe('re-checks over time', () => {
  const policy = { ...DEFAULT_RECHECK_POLICY, graceDays: 30, remindDaysBefore: 30, firstRoundDueOn: '2026-12-31' };
  const at = (today: string, lastCheckedOn: string | null, type = CheckType.POLICE, extra: Record<string, unknown> = {}) =>
    recheckStanding({ type, lastCheckedOn, policy, today, ...extra });

  it('falls due one interval after the last check (police: 12 months)', () => {
    expect(at('2026-01-01', '2025-06-15')).toMatchObject({ dueOn: '2026-06-15', blockFrom: '2026-07-15', status: 'OK' });
  });

  it('goes due soon, due, then holds them from work after the grace period', () => {
    expect(at('2026-05-16', '2025-06-15').status).toBe('DUE_SOON');
    expect(at('2026-06-15', '2025-06-15').status).toBe('DUE');
    expect(at('2026-07-14', '2025-06-15').status).toBe('DUE');
    expect(at('2026-07-15', '2025-06-15').status).toBe('BLOCKED');
  });

  /** The roster predates these checks: never-checked people fall due on a date the operator sets. */
  it('makes a never-checked person due on the first-round date, not today', () => {
    expect(at('2026-09-23', null)).toMatchObject({ dueOn: '2026-12-31', status: 'OK', because: expect.stringMatching(/Never checked/) });
  });

  it('uses each check type\'s own interval (background: 24 months)', () => {
    expect(at('2026-01-01', '2025-01-10', CheckType.BGV).dueOn).toBe('2027-01-10');
  });

  it('brings the identity re-check forward to an identity document\'s expiry', () => {
    const s = at('2026-09-23', '2026-01-01', CheckType.IDENTITY, { earliestIdentityExpiry: '2026-10-15' });
    expect(s).toMatchObject({ dueOn: '2026-10-15', status: 'DUE_SOON', because: expect.stringMatching(/expires/) });
    // An expiry before the last re-check was already seen by it.
    expect(at('2026-09-23', '2026-01-01', CheckType.IDENTITY, { earliestIdentityExpiry: '2025-12-01' }).dueOn).toBe('2028-01-01');
  });

  it('adds months to a calendar date without spilling into the next month', () => {
    expect(addMonthsToDateKey('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDateKey('2024-02-29', 12)).toBe('2025-02-28');
  });

  it('says what holds somebody from new work — the hold, and every overdue check', () => {
    expect(complianceWorkBlockers(
      [{ type: CheckType.POLICE, status: 'BLOCKED', dueOn: '2026-06-15' }, { type: CheckType.BGV, status: 'DUE', dueOn: '2026-09-01' }],
      { checkType: CheckType.CREDIT },
    )).toEqual([
      'Credit (CIBIL) check came back adverse — held from new work until a senior decides',
      'Police verification overdue since 2026-06-15',
    ]);
    expect(complianceWorkBlockers([{ type: CheckType.BGV, status: 'DUE', dueOn: '2026-09-01' }], null)).toEqual([]);
  });

  it('knows which report belongs to which check, and who is re-checked', () => {
    expect(checkTypeForReport(OnboardingDocument.POLICE_CERTIFICATE)).toBe(CheckType.POLICE);
    expect(checkTypeForReport(OnboardingDocument.PAN_CARD)).toBeNull();
    expect(isRecheckedLifecycle('ACTIVE')).toBe(true);
    expect(isRecheckedLifecycle('TRAINING')).toBe(false);
    expect(isAdverseVerdict(BackgroundCheckVerdict.CIVIL_CASE)).toBe(true);
    expect(isAdverseVerdict(BackgroundCheckVerdict.CLEAR)).toBe(false);
  });
});
