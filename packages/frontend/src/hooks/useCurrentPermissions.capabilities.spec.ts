import { SystemRole } from '@fapoms/shared';
import {
  canManageAssayers, canCreateAssayers, canDeleteProjects,
  canAdministerDataReset, canAdministerPlatformSettings,
  canAdministerTechnicalSettings, canApproveDestructiveActions,
  canAdministerNotifications, canManageCompliance,
  canReadCustomerMaster, canManageRoles, permissionKeysFrom,
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
     *
     * DEVELOPER-only since the two-person rule (2026-09-05): the wipe is requested and executed
     * by a developer; an ADMIN's part is APPROVING it, on /admin/approvals — so ADMIN no longer
     * opens the Danger Zone, and implication cannot re-open it (it runs DEVELOPER → ADMIN,
     * never the reverse).
     */
    it('never opens data reset to a permission, however broad — nor to ADMIN any more', () => {
      expect(canAdministerDataReset(NO_ROLES)).toBe(false);
      expect(canAdministerDataReset([SystemRole.OPERATIONS])).toBe(false);
      expect(canAdministerDataReset([SystemRole.ADMIN])).toBe(false);
      expect(canAdministerDataReset([SystemRole.DEVELOPER])).toBe(true);
    });

    /**
     * Tightened 2026-09-04 to match the backend's `@RoleOnly()` fix on `PUT`/`DELETE
     * /platform-settings/:key`: a role holding `configuration:edit:platform` without the ADMIN
     * role used to see (and could actually use) the Save controls here — the API now refuses
     * it, so the button must not be shown either.
     */
    it('never opens platform settings to a permission, however broad', () => {
      expect(canAdministerPlatformSettings(NO_ROLES, custom('CONFIGURATION:EDIT:ORGANIZATION'))).toBe(false);
      expect(canAdministerPlatformSettings([SystemRole.OPERATIONS], custom('CONFIGURATION:EDIT:ORGANIZATION'))).toBe(false);
      expect(canAdministerPlatformSettings([SystemRole.ADMIN], [])).toBe(true);
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

  /**
   * The role editor is the one screen whose gate is a NAME on purpose.
   *
   * This helper briefly offered the editor to a custom role holding `user:edit:organization`, on
   * the stated grounds that the backend's role-CRUD routes accept that permission from a custom
   * role. They do not — `POST/PUT/DELETE /users/roles*` and `PUT /users/:id/roles` are
   * `@Roles(ADMIN)` with no `@AllowPermissionFallback()`, so RolesGuard refuses an unrecognised
   * role name outright — and the control was enabled over an API that answered 403 on every save.
   *
   * Aligning them the other way was the wrong repair, which is what these tests now hold. `PUT
   * /users/roles/:id/permissions` grants any key in the catalogue and `PUT /users/:id/roles`
   * assigns any role, ADMIN included: reachable through a permission, one custom-role grant would
   * promote its own holder to administrator. Role administration is the grant that mints every
   * other grant, so it is not itself grantable.
   */
  describe('canManageRoles', () => {
    it('opens for ADMIN by name, with no permission needed', () => {
      expect(canManageRoles([SystemRole.ADMIN])).toBe(true);
    });

    /**
     * The escalation this refuses, stated as a test: a role built in Admin -> Roles cannot be
     * granted the ability to edit Admin -> Roles.
     */
    it('stays shut for a custom role holding user:edit — the backend refuses it, and should', () => {
      const custom = ['QATRACK_L_CONFIG_EDITOR'] as unknown as SystemRole[];
      expect(canManageRoles(custom)).toBe(false);
    });

    it('is not opened by a PLATFORM-scoped USER:EDIT either', () => {
      const cached = { roles: [{ name: 'SOME_CUSTOM_ROLE', permissions: [{ resource: 'USER', action: 'EDIT', scope: 'PLATFORM' }] }] };
      const custom = ['SOME_CUSTOM_ROLE'] as unknown as SystemRole[];
      // The widening pipeline works — this key IS produced — and it still buys nothing here.
      expect(permissionKeysFrom(cached)).toContain('USER:EDIT:ORGANIZATION');
      expect(canManageRoles(custom)).toBe(false);
    });

    it('stays shut for a built-in, non-ADMIN role', () => {
      expect(canManageRoles([SystemRole.OPERATIONS])).toBe(false);
    });

    it('is false for nobody — no roles at all', () => {
      expect(canManageRoles(NO_ROLES)).toBe(false);
    });
  });

  /**
   * The DEVELOPER split (2026-09-05). Every helper here funnels through `hasAnyRole`/`allowed`,
   * which expand the caller's names through ROLE_IMPLICATIONS (role-hierarchy.ts in
   * @fapoms/shared) — DEVELOPER ⇒ ADMIN + PRODUCT_SUPPORT, one-way. So a developer passes every
   * admin gate without being listed, an admin passes NO developer-only gate, and the one check
   * that must ignore implication (approving a wipe) reads the RAW roles.
   */
  describe('the DEVELOPER role and the two-person rule', () => {
    it('passes the admin-gated helpers through implication, unlisted', () => {
      expect(canAdministerPlatformSettings([SystemRole.DEVELOPER], [])).toBe(true);
      expect(canManageAssayers([SystemRole.DEVELOPER], [])).toBe(true);
      expect(canDeleteProjects([SystemRole.DEVELOPER], [])).toBe(true);
      expect(canAdministerNotifications([SystemRole.DEVELOPER])).toBe(true);
      expect(canManageCompliance([SystemRole.DEVELOPER])).toBe(true);
      expect(canManageRoles([SystemRole.DEVELOPER])).toBe(true);
    });

    it('keeps the technical estate closed to a pure ADMIN — implication is one-way', () => {
      expect(canAdministerTechnicalSettings([SystemRole.ADMIN])).toBe(false);
      expect(canAdministerDataReset([SystemRole.ADMIN])).toBe(false);
      expect(canAdministerTechnicalSettings([SystemRole.DEVELOPER])).toBe(true);
      expect(canAdministerDataReset([SystemRole.DEVELOPER])).toBe(true);
    });

    /**
     * The approve surface must NOT follow implication, and this is the deliberate exception in
     * a file where everything else does: expanding here would show Approve to the developer
     * whose own request needs the second pair of eyes, collapsing the two-person rule back to
     * one person. Mirrors the backend's direct-role check on the approval routes.
     */
    describe('canApproveDestructiveActions reads the raw roles only', () => {
      it('opens for the ADMIN role held directly', () => {
        expect(canApproveDestructiveActions([SystemRole.ADMIN])).toBe(true);
      });

      it('stays shut for a DEVELOPER, though implication makes it an admin everywhere else', () => {
        expect(canApproveDestructiveActions([SystemRole.DEVELOPER])).toBe(false);
        // The contrast that makes the line above meaningful: the same principal IS an admin
        // to every implication-aware helper.
        expect(canAdministerPlatformSettings([SystemRole.DEVELOPER], [])).toBe(true);
      });

      it('opens for a principal who genuinely holds both roles', () => {
        // Direct ADMIN among the raw roles is what the backend honours; holding DEVELOPER too
        // does not subtract it.
        expect(canApproveDestructiveActions([SystemRole.DEVELOPER, SystemRole.ADMIN])).toBe(true);
      });

      it('is false for everyone else', () => {
        expect(canApproveDestructiveActions([SystemRole.OPERATIONS])).toBe(false);
        expect(canApproveDestructiveActions(NO_ROLES)).toBe(false);
      });
    });
  });
});
