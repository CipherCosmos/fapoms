import { SETTING_BY_KEY } from './settings.registry';

/**
 * The shipped default of a security setting is the posture a fresh deployment inherits before
 * anyone touches the admin screen. Two of these settings are access/segregation boundaries whose
 * absence is silent — nothing fails, no user complains, the system behaves normally right up until
 * the boundary is needed. This pins their safe default so a future edit that loosens it is a
 * visible, reviewed change, not a one-character diff nobody notices.
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
});
