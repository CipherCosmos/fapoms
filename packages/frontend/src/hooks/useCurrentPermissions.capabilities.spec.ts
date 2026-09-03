import { SystemRole } from '@fapoms/shared';
import {
  canManageAssayers, canCreateAssayers, canDeleteProjects,
  canAdministerDataReset, canAdministerPlatformSettings,
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
});
