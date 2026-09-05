import { SystemRole } from './enums';

/**
 * The role hierarchy — one map, consumed by BOTH sides of the wire.
 *
 * The backend RolesGuard and the frontend's hasAnyRole/canAccessRoute each match a caller's
 * role names against a route's allowed list. Rather than editing every `@Roles(ADMIN)` route
 * (and every frontend route entry) to also name DEVELOPER, the implication lives here once:
 * a caller's names are expanded through this map before matching, so a DEVELOPER passes any
 * gate that admits ADMIN or PRODUCT_SUPPORT.
 *
 * Two properties this deliberately gives the system:
 *  - A DEVELOPER-only gate (`@Roles(DEVELOPER)` with ADMIN not listed) EXCLUDES admins —
 *    implication is one-way. That is how the technical estate is fenced off.
 *  - No `@Roles(ADMIN)` route can exclude DEVELOPER at the name-match layer. Where that
 *    matters (the destructive-action APPROVE route), the fence is the permission instead:
 *    SYSTEM:APPROVE:PLATFORM is granted to ADMIN and withheld from DEVELOPER, and the
 *    approval service additionally checks the approver's DIRECT role rows in the database.
 *
 * Keep this map tiny. Every entry here widens gates all over the system; an entry is a
 * product decision (this one: 2026-09-05, "developer has max access"), not a convenience.
 */
export const ROLE_IMPLICATIONS: Partial<Record<SystemRole, readonly SystemRole[]>> = {
  [SystemRole.DEVELOPER]: [SystemRole.ADMIN, SystemRole.PRODUCT_SUPPORT],
};

/**
 * A caller's role names, plus every role each of them implies. Unknown names (custom roles
 * built in Admin → Roles) pass through untouched — implication is only defined between
 * built-in roles, and the custom-role permission fallback stays a separate mechanism.
 * Idempotent; preserves first-seen order; never returns duplicates.
 */
export function expandRoles(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const name of names) {
    push(name);
    const implied = ROLE_IMPLICATIONS[name as SystemRole];
    if (implied) for (const i of implied) push(i);
  }
  return out;
}

/**
 * The inverse expansion, for ADDRESSING rather than gating: given the roles an event is
 * addressed to, add every role that implies one of them — so a notification aimed at ADMIN
 * also reaches a pure DEVELOPER. (expandRoles answers "what may this caller enter?";
 * expandAudience answers "who should hear this?".)
 */
export function expandAudience(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const name of names) {
    push(name);
    for (const [implier, implied] of Object.entries(ROLE_IMPLICATIONS)) {
      if ((implied as readonly string[] | undefined)?.includes(name)) push(implier);
    }
  }
  return out;
}

/** Does holding `role` satisfy a gate that admits any of `allowed`? (Implication-aware.) */
export function roleSatisfies(role: string, allowed: readonly string[]): boolean {
  return expandRoles([role]).some((name) => allowed.includes(name));
}
