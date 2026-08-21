import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { SystemRole } from '@fapoms/shared';
import {
  canManageAssayers, canManageBranches, canManageProjects, canDeleteProjects,
  canManageTransportRates, canAdministerPlatformSettings, canManagePlanningRules,
  canReadTravelSettings,
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
  /**
   * Every source file in the app, not a hand-kept list of six.
   *
   * The first version of this test named the files to scan. Four of the files that actually
   * carried duplicates were not among them, so it certified a tree it had never looked at.
   * Walking the sources removes the possibility.
   */
  const SRC = join(__dirname, '..');
  const sourceFiles = (): string[] =>
    execSync(`find ${SRC} -name '*.ts' -o -name '*.tsx'`, { encoding: 'utf8' })
      .trim().split('\n')
      .filter((f) => f && !f.endsWith('.spec.ts') && !f.endsWith('.spec.tsx'));

  /**
   * A bracketed list of roles, however it is laid out.
   *
   * The first version required the closing bracket to follow the last entry immediately, so it
   * matched only single-line arrays — and every list long enough to be formatted across lines,
   * which is every list long enough to grow a duplicate, was invisible to it. It passed while
   * eight duplicates sat in the tree, one of them inside a file it was scanning.
   *
   * The trailing `\s*` before the bracket is the whole fix.
   */
  const ROLE_LIST = /[[(]((?:\s*SystemRole\.[A-Z_]+\s*,?)+\s*)[\])]/g;

  it('names each role at most once, anywhere in the app', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const list of source.matchAll(ROLE_LIST)) {
        const names = [...list[1].matchAll(/SystemRole\.([A-Z_]+)/g)].map((m) => m[1]);
        if (names.length !== new Set(names).size) {
          const line = source.slice(0, list.index).split('\n').length;
          offenders.push(`${file.replace(SRC, 'src')}:${line} → ${names.join(', ')}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('actually finds role lists, so a passing run cannot mean it scanned nothing', () => {
    const total = sourceFiles()
      .reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(ROLE_LIST)].length, 0);
    expect(total).toBeGreaterThan(20);
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

/**
 * Folding a page into Platform Settings must not change who can reach it.
 *
 * Two pages moved in: `/rules`, which Operations owned, and `/transport-costs`, which Auditors
 * could read. Platform Settings itself is administrator-only and stays that way, so both would
 * have lost their feature to the move. Each reaches its own section and nothing else.
 */
describe('sections folded into Platform Settings', () => {
  const only = (can: (r: SystemRole[]) => boolean) =>
    Object.values(SystemRole).filter((r) => can([r]));

  it('keeps eligibility rules with the roles that owned them', () => {
    expect(only(canManagePlanningRules).sort()).toEqual([SystemRole.ADMIN, SystemRole.OPERATIONS].sort());
  });

  it('keeps the travel rate card readable by the roles that could read it', () => {
    expect(only(canReadTravelSettings).sort())
      .toEqual([SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR].sort());
  });

  it('does not widen Platform Settings itself to either of them', () => {
    for (const role of [SystemRole.OPERATIONS, SystemRole.AUDITOR]) {
      expect(canAdministerPlatformSettings([role])).toBe(false);
    }
  });

  it('leaves every other role out of both sections', () => {
    for (const role of [SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.ASSAYER, SystemRole.CLIENT_USER, SystemRole.PRODUCT_SUPPORT]) {
      expect({ role, rules: canManagePlanningRules([role]), travel: canReadTravelSettings([role]) })
        .toEqual({ role, rules: false, travel: false });
    }
  });
});
