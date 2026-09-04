import { Repository } from 'typeorm';
import { SystemRole } from '@fapoms/shared';
import { UserEntity } from '../user/user.entity';
import { permissionKeysHeldBy } from '../auth/guards';

/**
 * Every active user who holds ALL of `permissions`, counting only permissions that arrive
 * through a role whose name `SystemRole` has never heard of.
 *
 * Mirrors `RolesGuard`'s own permission fall-through (guards.ts): a role built in Admin -> Roles
 * is judged by what it can do, because whoever names an audience by role — a route's `@Roles`,
 * or a notification/digest audience — never named it. A built-in role a caller also holds does
 * not get a second, coincidental way in through this path; only the unrecognised role's own
 * grants count, exactly as `RolesGuard` filters to `unrecognisedRoles` before computing `held`.
 * See that guard's comment for the CLIENT_USER incident this specific ordering exists to
 * prevent.
 *
 * Callers that already resolve an audience by role NAME union this in on top — the mechanism is
 * additive, never a replacement for the name match.
 */
export async function usersHoldingPermission(
  userRepository: Repository<UserEntity>,
  permissions: string[] | undefined,
): Promise<UserEntity[]> {
  if (!permissions?.length) return [];
  const knownRoleNames = new Set<string>(Object.values(SystemRole));

  const candidates = await userRepository
    .createQueryBuilder('u')
    .innerJoin('u.roles', 'anyRole')
    .leftJoinAndSelect('u.roles', 'allRoles')
    .leftJoinAndSelect('allRoles.permissions', 'perm')
    .where('anyRole.name NOT IN (:...knownRoleNames)', { knownRoleNames: [...knownRoleNames] })
    .andWhere('u.is_active = true')
    .andWhere('u.status = :status', { status: 'ACTIVE' })
    .getMany();

  const required = permissions.map((p) => p.toUpperCase());
  return candidates.filter((u) => {
    const unrecognised = (u.roles ?? []).filter((r) => !knownRoleNames.has(r.name));
    const held = permissionKeysHeldBy({ roles: unrecognised });
    return required.every((perm) => held.has(perm));
  });
}
