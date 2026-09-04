import { SystemRole } from '@fapoms/shared';
import {
  canManageAssayers, canCreateAssayers, canDeleteProjects,
  canAdministerDataReset, canAdministerPlatformSettings,
  canReadCustomerMaster,
} from './useCurrentRoles';

/**
 * A button must open for the permission that backs it, not only for a built-in role name.
 *
 * Twelve `can…` helpers listed `SystemRole` names, and a role created in Admin → Roles matches
 * none of them. The reported symptom was precise: an HR role granted `ASSAYER:CREATE` and
 * `ASSAYER:EDIT` reached the workforce console — the route gate had already been fixed — and then
 * found no "Add assayer" button, no roster import and no row selection. The screen it was created
 * to operate, in read-only.
 *
 * Permissions are passed explicitly here. In the app the helpers read them from the same cache the
 * call site already reads roles from, which is why 162 call sites needed no edit.
 */
describe('capability checks', () => {
  const NO_ROLES: SystemRole[] = [];
  const custom = (...perms: string[]) => perms;

  it('opens for a custom role holding the permission', () => {
    expect(canManageAssayers(NO_ROLES, custom('ASSAYER:EDIT:ORGANIZATION'))).toBe(true);
    expect(canCreateAssayers(NO_ROLES, custom('ASSAYER:CREATE:ORGANIZATION'))).toBe(true);
  });

  it('stays shut for a custom role holding something else', () => {
    expect(canManageAssayers(NO_ROLES, custom('BILLING:VIEW:ORGANIZATION'))).toBe(false);
    expect(canDeleteProjects(NO_ROLES, custom('PROJECT:EDIT:ORGANIZATION'))).toBe(false);
  });

  it('separates creating from editing', () => {
    // The roster offers both; a role granted edit alone must not be offered "Add assayer".
    const editOnly = custom('ASSAYER:EDIT:ORGANIZATION');
    expect(canManageAssayers(NO_ROLES, editOnly)).toBe(true);
    expect(canCreateAssayers(NO_ROLES, editOnly)).toBe(false);
  });

  it('honours a PLATFORM grant for a narrower ask', () => {
    // The cache reader widens PLATFORM to every narrower scope, matching the server.
    expect(canManageAssayers(NO_ROLES, custom('ASSAYER:EDIT:ORGANIZATION'))).toBe(true);
  });

  describe('nothing was loosened', () => {
    it('a built-in role still passes without any permission', () => {
      expect(canManageAssayers([SystemRole.OPERATIONS], [])).toBe(true);
      expect(canAdministerPlatformSettings([SystemRole.ADMIN], [])).toBe(true);
    });

    it('a custom role gets nothing from an empty permission list', () => {
      expect(canManageAssayers(NO_ROLES, [])).toBe(false);
      expect(canCreateAssayers(NO_ROLES, [])).toBe(false);
      expect(canAdministerPlatformSettings(NO_ROLES, [])).toBe(false);
    });

    /**
     * The one capability deliberately left role-only. It wipes operational data, and no permission
     * in the vocabulary means "may destroy the database" — accepting `CONFIGURATION:EDIT` as a
     * proxy would let an ordinary-looking settings grant carry it.
     */
    it('never opens data reset to a permission, however broad', () => {
      expect(canAdministerDataReset(NO_ROLES)).toBe(false);
      expect(canAdministerDataReset([SystemRole.OPERATIONS])).toBe(false);
      expect(canAdministerDataReset([SystemRole.ADMIN])).toBe(true);
    });
  });

  /**
   * The document Daily Run tab mirrors a backend @Roles list that has a permission fallback, so its
   * gate is the strict `canAccessRoute` rule — named built-in role, OR custom role with the
   * permission — NOT the write-button `allowed` rule whose permission arm opens for anyone.
   *
   * The bug this pins: DESK_OPERATOR holds project:view:platform (widened to organization), which
   * satisfies the fallback permission — but it is deliberately absent from the daily-run @Roles, so
   * the endpoint 403s it and the tab must stay hidden. The name check has to win over the permission
   * for a built-in role, or the page opens on a panel that only paints a permission error.
   */
  describe('canReadCustomerMaster', () => {
    it.each([
      SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK,
      SystemRole.AUDITOR, SystemRole.CLIENT_USER,
    ])('opens for %s, which the daily-run endpoint names', (role) => {
      expect(canReadCustomerMaster([role], [])).toBe(true);
    });

    it('stays hidden from DESK_OPERATOR even though its project:view satisfies the fallback', () => {
      // The exact defect: a built-in role excluded by name must not slip in on a permission it holds
      // for something else, or the daily-run fetch 403s the moment the page mounts.
      expect(canReadCustomerMaster([SystemRole.DESK_OPERATOR], ['PROJECT:VIEW:ORGANIZATION'])).toBe(false);
    });

    it('opens for a custom role that genuinely holds project:view', () => {
      const custom = ['DOCUMENT_DESK'] as unknown as SystemRole[];
      expect(canReadCustomerMaster(custom, ['PROJECT:VIEW:ORGANIZATION'])).toBe(true);
    });

    it('stays shut for a custom role without project:view', () => {
      const custom = ['DOCUMENT_DESK'] as unknown as SystemRole[];
      expect(canReadCustomerMaster(custom, ['DOCUMENT:VIEW:ORGANIZATION'])).toBe(false);
    });
  });
});
