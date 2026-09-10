import { ALL_GRANTED_PERMISSIONS } from '../../modules/auth/role-permissions';

/**
 * The three decisions the seed makes about grants, made where they can be tested.
 *
 * All three used to be inline in `seed()`, and all three were wrong in the same direction — each
 * one quietly produced a smaller set than was asked for, and the run still reported success. On
 * the live deployment that came to nineteen grants missing across four roles: an ADMIN that could
 * not approve a data wipe, a DEVELOPER with none of the technical estate the role exists for, and
 * an OPERATIONS and a DESK_OPERATOR that could not open the records their screens are built on.
 *
 * A seed may add. It may not narrow, and it may not decide on its own that a declared grant was
 * not important.
 */

/** One row of the `permissions` table, as the seed describes it before it is written. */
export interface PermissionSpec {
  resource: string;
  action: string;
  scope: string;
  description: string;
}

export const permissionKey = (p: { resource: string; action: string; scope: string }): string =>
  `${p.resource}:${p.action}:${p.scope}`;

/**
 * Every permission the seed must create: the hand-written list, plus a row for every grant
 * `ROLE_PERMISSIONS` hands out that the list forgot.
 *
 * The list had fallen twelve keys behind the grant table — the four `*:VIEW:ORGANIZATION` reads,
 * the three ORGANIZATION grants, both OCR grants and all three SYSTEM grants. A grant whose row
 * does not exist cannot be given to anybody, so those twelve were unreachable on any database
 * built by this seed.
 *
 * Deriving them rather than asking somebody to remember means the list can go on being a
 * convenience — it carries readable descriptions for the permissions a human wrote down — without
 * being load-bearing. `ReconcileRolePermissions` derives the same rows the same way at migration
 * time; this keeps the two paths agreeing.
 */
export function buildPermissionCatalogue(listed: readonly PermissionSpec[]): PermissionSpec[] {
  const already = new Set(listed.map(permissionKey));
  const derived = ALL_GRANTED_PERMISSIONS.filter(key => !already.has(key)).map((key): PermissionSpec => {
    const [resource, action, scope] = key.split(':');
    return { resource, action, scope, description: `${action} ${resource} (${scope})` };
  });
  return [...listed, ...derived];
}

/**
 * Look up something a role, capability or responsibility is declared to hold, and treat a miss as
 * the bug it is.
 *
 * Every call site did `.map(k => map.get(k)).filter(Boolean)`, so a name with nothing behind it
 * narrowed whatever asked for it and said nothing. Silence is the whole problem: a role missing a
 * grant behaves exactly like a role that was never meant to have it, which is why this survived
 * three separate reconciliations.
 */
export function resolveGrant<T>(map: ReadonlyMap<string, T>, key: string, heldBy: string): T {
  const found = map.get(key);
  if (!found) {
    throw new Error(
      `${heldBy} is declared to hold ${key}, which this seed never creates. Add ${key} to the `
      + 'seed definitions, or stop declaring it — dropping it quietly is how nineteen grants went '
      + 'missing.',
    );
  }
  return found;
}

/**
 * Union a relation with what the row already had — and refuse when the caller cannot know.
 *
 * TypeORM syncs a many-to-many by deleting every junction row the assigned array does not name.
 * So `role.permissions = [...]` is only a merge if `role.permissions` was actually loaded, and
 * `roleRepository.find()` does not load it: the merge started from an empty map and became a
 * replace. That is how a seed whose own comment says "merge, never replace" removed grants three
 * migrations had been written to install.
 *
 * `undefined` here means the relation was not requested. There is no safe assumption available —
 * treating it as empty is the bug, and skipping the write would hide a missing grant — so it
 * stops and names the relation.
 */
export function mergeRelation<T extends { id: string }>(
  existing: T[] | undefined,
  incoming: readonly T[],
  what: string,
): T[] {
  if (existing === undefined) {
    throw new Error(
      `${what} was loaded without its relation, so assigning it would DELETE every row not named `
      + 'in the new list. Load the entity with { relations: [...] } before merging.',
    );
  }
  const byId = new Map(existing.map(e => [e.id, e]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}
