import { SETTING_BY_KEY } from './settings.registry';

/**
 * The shipped default of a security setting is the posture a fresh deployment inherits before
 * anyone touches the admin screen. Two of these settings are access/segregation boundaries whose
 * absence is silent — nothing fails, no user complains, the system behaves normally right up until
 * the boundary is needed. This pins their safe default so a future edit that loosens it is a
 * visible, reviewed change, not a one-character diff nobody notices.
 *
 * The two are `security.regionScope.mode` and `security.segregationOfDuties.mode`. Naming them
 * here because "two of these settings" went four weeks with only one of them actually pinned, and
 * the unpinned one — the payout maker-checker — was found switched off in certification with one
 * OPERATIONS account approving and paying the same payable.
 *
 * `security.regionScope.mode` was confirmed leaking under its original 'log' default on 2026-09-04:
 * a SOUTH-scoped OPERATIONS account read WEST documents, billing, expenses and validation queries
 * (HTTP 200, with the guard logging "would refuse ... allowed through"). Enforce was then confirmed
 * to leave unrestricted (region=NULL) and correctly-scoped accounts untouched. See the assessment
 * findings log.
 */
describe('security settings ship with a safe default', () => {
  it('region scope enforces cross-region reads by default (not log, not off)', () => {
    const entry = SETTING_BY_KEY['security.regionScope.mode'];
    expect(entry).toBeDefined();
    expect(entry.default).toBe('enforce');
  });

  it('the region-scope setting still offers all three modes as an operator escape hatch', () => {
    const entry = SETTING_BY_KEY['security.regionScope.mode'];
    const values = (entry.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['enforce', 'log', 'off']);
  });

  /**
   * The second of the two. This file has said "two of these settings" since it was written and
   * only ever pinned one, and the consequence was exact: `security.segregationOfDuties.mode`
   * defaulted to 'off', no row was ever written to `platform_settings`, so `sodMode()` answered
   * 'off' on every call and BOTH `assertSegregationOfDuties` sites were skipped. Certification
   * had one OPERATIONS account approve a payable and pay it 122 ms later, HTTP 201 both times.
   *
   * The 'off' default was justified in the registry by "with two people on the roles today,
   * Enforce would mean neither could ever pay the other's work" — which is the opposite of what
   * the check does. It refuses one account on BOTH sides; two people is exactly the number it
   * needs. `expense.service.ts` already refuses the raiser of an expense claim their own
   * approval, unconditionally, for the same act (both write an `assayer_payables` row), so the
   * payout route was the one left configurable and switched off.
   */
  it('payout maker-checker enforces by default (not warn, not off)', () => {
    const entry = SETTING_BY_KEY['security.segregationOfDuties.mode'];
    expect(entry).toBeDefined();
    expect(entry.default).toBe('enforce');
  });

  it('the maker-checker setting still offers all three modes as an operator escape hatch', () => {
    const entry = SETTING_BY_KEY['security.segregationOfDuties.mode'];
    const values = (entry.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['enforce', 'off', 'warn']);
  });
});
