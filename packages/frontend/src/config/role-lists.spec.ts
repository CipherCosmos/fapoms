import { readFileSync } from 'fs';
import { join } from 'path';
import { SystemRole } from '@fapoms/shared';
import {
  canManageAssayers, canManageBranches, canManageProjects, canDeleteProjects,
  canManageTransportRates, canAdministerPlatformSettings, canManagePlanningRules,
} from '../hooks/useCurrentRoles';

/**
 * A role appears once in a list, or the list is a rename that went wrong.
 *
 * Thirteen roles collapsed onto eight, and every list naming them was rewritten in place. Where
 * two old roles mapped to the same new one the duplicate was left behind:
 * `[ADMIN, ADMIN, OPERATIONS]`, `[ADMIN, ADMIN]`, and a billing check reading
 * `[ADMIN, ADMIN, OPERATIONS, OPERATIONS]`. None of them changed who could do what — a
 * duplicate in an `includes` test is inert — but they made the lists unreadable, and they hid
 * the thing that did change: two lists that used to differ now being identical.
 */
describe('role lists', () => {
  const FILES = [
    '../hooks/useCurrentRoles.ts',
    '../pages/Billing.tsx',
    '../pages/dataentry/deskRoles.ts',
    '../pages/dataentry/CaseWorkspace.tsx',
    '../pages/hr/HrDocumentsPage.tsx',
    './route-permissions.ts',
  ];

  it.each(FILES)('names each role at most once in %s', (relative) => {
    const source = readFileSync(join(__dirname, relative), 'utf8');
    const lists = [...source.matchAll(/[[(]((?:\s*SystemRole\.[A-Z_]+\s*,?){2,})[\])]/g)];
    for (const list of lists) {
      const names = [...list[1].matchAll(/SystemRole\.([A-Z_]+)/g)].map((m) => m[1]);
      expect({ list: names.join(', '), unique: names.length }).toEqual({
        list: names.join(', '),
        unique: new Set(names).size,
      });
    }
  });

  /** The helpers still answer the same question they did before the duplicates came out. */
  it.each([
    ['manage assayers', canManageAssayers, [SystemRole.ADMIN, SystemRole.OPERATIONS]],
    ['manage branches', canManageBranches, [SystemRole.ADMIN, SystemRole.OPERATIONS]],
    ['manage projects', canManageProjects, [SystemRole.ADMIN, SystemRole.OPERATIONS]],
    ['delete projects', canDeleteProjects, [SystemRole.ADMIN]],
    ['manage transport rates', canManageTransportRates, [SystemRole.ADMIN, SystemRole.OPERATIONS]],
    ['administer platform settings', canAdministerPlatformSettings, [SystemRole.ADMIN]],
    ['manage planning rules', canManagePlanningRules, [SystemRole.ADMIN, SystemRole.OPERATIONS]],
  ])('lets exactly the right roles %s', (_name, can, allowed) => {
    for (const role of Object.values(SystemRole)) {
      expect({ role, allowed: can([role]) }).toEqual({ role, allowed: allowed.includes(role) });
    }
  });

  it('keeps eligibility rules reachable by operations without opening the rest of settings', () => {
    // The whole point of folding /rules into Platform Settings without widening it.
    expect(canManagePlanningRules([SystemRole.OPERATIONS])).toBe(true);
    expect(canAdministerPlatformSettings([SystemRole.OPERATIONS])).toBe(false);
  });
});
