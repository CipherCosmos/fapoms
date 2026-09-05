import { SystemRole } from './enums';
import { ROLE_IMPLICATIONS, expandRoles, expandAudience, roleSatisfies } from './role-hierarchy';

describe('role hierarchy — the one implication map', () => {
  it('DEVELOPER implies exactly ADMIN and PRODUCT_SUPPORT, and nothing else implies anything', () => {
    // Widening this map widens gates all over the system — a new entry must be a deliberate
    // product decision, and it must come here first, breaking this test on purpose.
    expect(ROLE_IMPLICATIONS).toEqual({
      [SystemRole.DEVELOPER]: [SystemRole.ADMIN, SystemRole.PRODUCT_SUPPORT],
    });
  });

  describe('expandRoles (gating direction)', () => {
    it('expands DEVELOPER to include ADMIN and PRODUCT_SUPPORT', () => {
      expect(expandRoles([SystemRole.DEVELOPER])).toEqual([
        SystemRole.DEVELOPER,
        SystemRole.ADMIN,
        SystemRole.PRODUCT_SUPPORT,
      ]);
    });

    it('is one-way: ADMIN does NOT expand to DEVELOPER', () => {
      expect(expandRoles([SystemRole.ADMIN])).toEqual([SystemRole.ADMIN]);
    });

    it('passes custom role names through untouched', () => {
      expect(expandRoles(['REGIONAL_LEAD'])).toEqual(['REGIONAL_LEAD']);
    });

    it('is idempotent and de-duplicated', () => {
      const once = expandRoles([SystemRole.DEVELOPER, SystemRole.ADMIN]);
      expect(expandRoles(once)).toEqual(once);
      expect(new Set(once).size).toBe(once.length);
    });
  });

  describe('expandAudience (addressing direction)', () => {
    it('an event addressed to ADMIN also reaches DEVELOPER', () => {
      expect(expandAudience([SystemRole.ADMIN])).toEqual([SystemRole.ADMIN, SystemRole.DEVELOPER]);
    });

    it('an event addressed to PRODUCT_SUPPORT also reaches DEVELOPER', () => {
      expect(expandAudience([SystemRole.PRODUCT_SUPPORT])).toEqual([
        SystemRole.PRODUCT_SUPPORT,
        SystemRole.DEVELOPER,
      ]);
    });

    it('an event addressed to DEVELOPER reaches only developers — admins are not implied upward', () => {
      expect(expandAudience([SystemRole.DEVELOPER])).toEqual([SystemRole.DEVELOPER]);
    });
  });

  describe('roleSatisfies', () => {
    it('DEVELOPER satisfies a gate admitting ADMIN', () => {
      expect(roleSatisfies(SystemRole.DEVELOPER, [SystemRole.ADMIN])).toBe(true);
    });

    it('ADMIN does not satisfy a DEVELOPER-only gate — the technical fence', () => {
      expect(roleSatisfies(SystemRole.ADMIN, [SystemRole.DEVELOPER])).toBe(false);
    });
  });
});
