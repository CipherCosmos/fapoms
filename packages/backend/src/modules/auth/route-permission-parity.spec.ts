import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { ROLE_PERMISSIONS } from './role-permissions';
import { STAFF_ROLES } from './staff-roles';
import { BILLING_ROLES, BILLING_READ_ROLES, DISBURSEMENT_ROLES } from '../billing-engine/billing-roles';

/**
 * A route must not name a role that cannot call it.
 *
 * Access is decided twice: `@Roles(...)` names the audience, and `@RequirePermissions(...)` is
 * resolved against each role's grants. Both must pass, so a role named by `@Roles` but missing
 * the permission is refused — silently, and indistinguishably from a role that was never meant
 * to have access. Twenty-four routes were in that state, and three more required permissions
 * that existed for nobody at all, so no principal could call them.
 *
 * This reads the controllers and the grant table and fails on any such pair. It is the check
 * that was missing: nothing else can tell the difference between "denied on purpose" and
 * "denied because two lists drifted".
 */
describe('routes and the permissions their roles hold', () => {
  const SRC = join(__dirname, '..', '..');

  /** Role-group constants a `@Roles(...)` line may spread. */
  const GROUPS: Record<string, readonly string[]> = {
    STAFF_ROLES, BILLING_ROLES, BILLING_READ_ROLES, DISBURSEMENT_ROLES,
  };

  const rolesIn = (blob: string): string[] => {
    const named = [...blob.matchAll(/SystemRole\.(\w+)/g)].map((m) => m[1]);
    const spread = [...blob.matchAll(/\.\.\.(\w+)/g)]
      .flatMap((m) => (GROUPS[m[1]] ?? []).map(String));
    return [...new Set([...named, ...spread])];
  };

  /** Every (route, roles, permissions) triple in the codebase. */
  const routes = (() => {
    const files = execSync(
      // Controllers only: the guard defines the decorator, and this spec quotes its name.
      "grep -rl '@RequirePermissions(' . --include '*.ts' "
        + "| grep -v _historical | grep 'controller\\.ts$'",
      { cwd: SRC, encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);

    const found: Array<{ where: string; roles: string[]; perms: string[] }> = [];
    for (const file of files) {
      const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
      const classAt = lines.findIndex((l) => /^export class /.test(l));

      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('@RequirePermissions(')) continue;
        const perms = [...lines[i].matchAll(/'([^']+)'/g)].map((m) => m[1].toUpperCase());

        // The nearest @Roles above, without crossing out of this handler's decorator block.
        let roles: string[] | null = null;
        for (let j = i - 1; j > Math.max(classAt, i - 25); j--) {
          if (/^ {2}\}\s*$/.test(lines[j])) break;
          if (lines[j].includes('@Roles(')) {
            let blob = lines[j];
            for (let k = j; blob.split('(').length > blob.split(')').length && k + 1 < lines.length; ) {
              blob += lines[++k];
            }
            roles = rolesIn(blob);
            break;
          }
        }
        found.push({ where: `${file}:${i + 1}`, roles: roles ?? [], perms });
      }
    }
    return found;
  })();

  it('finds the routes to check, so a broken search cannot pass as a clean result', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.every((r) => r.perms.length > 0)).toBe(true);
  });

  it('grants every role a route names the permission that route requires', () => {
    const holds = (role: string, perm: string): boolean => {
      const granted = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] ?? [];
      if (granted.includes(perm)) return true;
      // PLATFORM implies every narrower scope, exactly as PermissionsGuard expands it.
      const [resource, action] = perm.split(':');
      return granted.includes(`${resource}:${action}:PLATFORM`);
    };

    const broken = routes.flatMap((r) =>
      r.roles
        .filter((role) => role in ROLE_PERMISSIONS)
        .filter((role) => !r.perms.every((p) => holds(role, p)))
        .map((role) => `${r.where}: allows ${role} but does not grant it ${r.perms.join(', ')}`),
    );

    expect(broken).toEqual([]);
  });

  it('requires no permission that exists for nobody', () => {
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flat());
    // A PLATFORM grant satisfies every narrower scope, so it is not an orphan.
    const heldBySomeone = (perm: string): boolean => {
      if (granted.has(perm)) return true;
      const [resource, action] = perm.split(':');
      return granted.has(`${resource}:${action}:PLATFORM`);
    };
    const orphans = routes
      .filter((r) => r.perms.some((p) => !heldBySomeone(p)))
      .map((r) => `${r.where}: requires ${r.perms.join(', ')}, which no role holds`);

    expect(orphans).toEqual([]);
  });

  it('names a role only if the system knows it', () => {
    const unknown = routes.flatMap((r) =>
      r.roles.filter((role) => !(role in ROLE_PERMISSIONS)).map((role) => `${r.where}: ${role}`),
    );
    // ASSAYER is authenticated from its own table and holds no role row; a route that pairs it
    // with a permission would refuse it outright.
    expect(unknown).toEqual([]);
  });
});
