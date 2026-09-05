import { useMemo } from 'react';
import { SystemRole, expandRoles } from '@fapoms/shared';

/**
 * The signed-in user's roles, read from the cache App.tsx already writes on login.
 *
 * Route access is enforced in ProtectedRoute, but pages also need to know whether
 * to *render* a write control: a viewer who sees an Edit button that always 403s
 * looks like a broken app rather than a permissions boundary.
 */
export function useCurrentRoles(): SystemRole[] {
  return useMemo(() => {
    try {
      const raw = localStorage.getItem('fapoms_user_cache');
      if (!raw) return [];
      const user = JSON.parse(raw);
      return (user?.roles ?? [])
        .map((r: any) => (typeof r === 'string' ? r : r?.name))
        .filter(Boolean) as SystemRole[];
    } catch {
      return [];
    }
  }, []);
}

/**
 * A PLATFORM grant implies the same resource and action at every narrower scope, so somebody
 * granted `DOCUMENT:VIEW:PLATFORM` satisfies a screen asking for `DOCUMENT:VIEW:ORGANIZATION`.
 * Copied from `permissionKeysHeldBy` in the backend's guards and written out rather than
 * computed, so the set of scopes is visible at the point it decides something.
 */
const NARROWER_THAN_PLATFORM = [
  'ORGANIZATION', 'CLIENT', 'STATE', 'REGION', 'DEPARTMENT', 'TEAM', 'SELF',
];

/**
 * Every permission key a cached user holds, in the `RESOURCE:ACTION:SCOPE` form routes declare.
 *
 * Two shapes reach the cache and both have to work. The sign-in response carries a flat,
 * already-widened `permissions` array. `/users/me` — which is what App.tsx actually writes to the
 * cache a moment later, and what is there on every subsequent page load — carries the raw rows
 * nested under each role instead, un-widened. Reading only the flat array would have worked for
 * the few hundred milliseconds after sign-in and then silently gone empty, which for a gate is
 * the worst available failure: it looks fixed while you test it and locks people out afterwards.
 *
 * Exported apart from the hook because the shell components (Sidebar, Header) already hold the
 * user object as a prop and should not re-read the cache to answer the same question.
 */
export function permissionKeysFrom(user: unknown): string[] {
  const held = new Set<string>();
  const add = (key: string) => {
    const upper = key.toUpperCase();
    held.add(upper);
    const [resource, action, scope] = upper.split(':');
    if (scope === 'PLATFORM' && resource && action) {
      for (const narrower of NARROWER_THAN_PLATFORM) held.add(`${resource}:${action}:${narrower}`);
    }
  };

  const cached = user as any;
  for (const key of cached?.permissions ?? []) {
    if (typeof key === 'string') add(key);
  }
  for (const role of cached?.roles ?? []) {
    for (const perm of role?.permissions ?? []) {
      if (perm?.resource && perm?.action && perm?.scope) {
        add(`${perm.resource}:${perm.action}:${perm.scope}`);
      }
    }
  }
  return [...held];
}

/**
 * The signed-in user's permissions, from the same cache `useCurrentRoles` reads.
 *
 * A cache written before this existed carries no permissions at all, and a session that predates
 * the change must degrade to "role name only" rather than throwing on the first render after a
 * deploy — hence an empty array for every shape this does not recognise.
 */
export function useCurrentPermissions(): string[] {
  return useMemo(() => {
    try {
      const raw = localStorage.getItem('fapoms_user_cache');
      if (!raw) return [];
      return permissionKeysFrom(JSON.parse(raw));
    } catch {
      return [];
    }
  }, []);
}

/**
 * The permission keys of the signed-in user, for a capability check that was given only roles.
 *
 * The twelve `can…` helpers below take `SystemRole[]` and are called from 162 places. Threading a
 * second argument through all of them would be a large, mechanical, error-prone edit for no
 * reader's benefit — and every one of those call sites is already reading the same cache one line
 * earlier, via `useCurrentRoles()`. So a caller may pass permissions explicitly (tests do), and
 * when it does not, the helper asks the cache itself.
 *
 * Not a hook: these are plain predicates called inside render, sometimes conditionally, and giving
 * them hook semantics would break the rules of hooks at call sites that already exist.
 */
function heldPermissions(explicit?: string[]): string[] {
  if (explicit) return explicit;
  try {
    const raw = localStorage.getItem('fapoms_user_cache');
    return raw ? permissionKeysFrom(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/**
 * Role name OR permission — the same rule the API applies, and the reason this file changed.
 *
 * Every helper below listed built-in role NAMES. A role built in Admin → Roles is a database row
 * that matches none of them, so an HR role granted `ASSAYER:CREATE` and `ASSAYER:EDIT` saw the
 * workforce console load and then had no "Add assayer" button, no import control, no row
 * selection — the screen it was created to operate, in read-only. The backend had already been
 * taught to authorise by permission; these buttons were the last place still asking only for a
 * name.
 *
 * Fails closed like the route gate: a capability with no permission named here stays role-only.
 */
function allowed(
  roles: SystemRole[],
  named: SystemRole[],
  permission: string | null,
  permissions?: string[],
): boolean {
  // Expanded through the role hierarchy (role-hierarchy.ts in @fapoms/shared): a DEVELOPER
  // implies ADMIN and PRODUCT_SUPPORT, so every helper naming those roles admits a developer
  // without listing it — the same expansion the backend RolesGuard applies. One-way: a gate
  // naming only DEVELOPER still excludes admins.
  if (expandRoles(roles).some((r) => named.includes(r as SystemRole))) return true;
  if (!permission) return false;
  return heldPermissions(permissions).includes(permission);
}

/**
 * Like `allowed`, but the permission arm is a fallback for CUSTOM roles only — a role built in
 * Admin → Roles whose name is not a `SystemRole`.
 *
 * This is the rule `canAccessRoute` and the backend `RolesGuard` both apply: a built-in role reaches
 * a capability iff it is NAMED, never because it happens to hold a permission granted for something
 * else. `allowed` above stays for the write-button checks whose `named` list already equals the set
 * of permission holders — there the two rules coincide. Use THIS one wherever a UI gate mirrors a
 * backend `@Roles(...)` list that deliberately excludes a role which nonetheless holds the fallback
 * permission for an unrelated reason, so the control shows exactly when the request behind it will
 * be served rather than 403.
 */
function allowedByNameOrCustomPermission(
  roles: SystemRole[],
  named: SystemRole[],
  permission: string,
  permissions?: string[],
): boolean {
  // Hierarchy-expanded like `allowed` above (see role-hierarchy.ts) — DEVELOPER ⇒ ADMIN,
  // PRODUCT_SUPPORT, one-way.
  if (expandRoles(roles).some((r) => named.includes(r as SystemRole))) return true;
  // Custom-role detection stays on the RAW names, never the expansion: expansion only ever adds
  // built-in names, and the fallback below must open exactly when the person actually carries a
  // role built in Admin → Roles.
  const known = new Set<string>(Object.values(SystemRole));
  const hasCustomRole = roles.some((r) => !known.has(r));
  if (!hasCustomRole) return false;
  return heldPermissions(permissions).includes(permission);
}

/**
 * The customer-master read surface behind the Branch Paperwork page's "Daily Run" and "Customer
 * Master" tabs — GET /customer-master/projects/:id/daily-run, /versions and /versions/:id/records,
 * all gated identically on the backend by @Roles(ADMIN, OPERATIONS, DESK, AUDITOR, CLIENT_USER) plus
 * project:view:organization.
 *
 * DESK_OPERATOR is on that page as a document VIEWER, not a dispatcher, so it is excluded from the
 * list by name — even though its project:view:platform grant widens to satisfy the permission.
 * Mounting either tab for it therefore fired a request that 403s and painted a permission banner the
 * instant the page opened. Gating both tabs on the same named-role-OR-custom-permission rule means
 * each view appears exactly when the fetch behind it will succeed, and a document viewer lands on
 * the branch view instead.
 */
export function canReadCustomerMaster(roles: SystemRole[], permissions?: string[]): boolean {
  return allowedByNameOrCustomPermission(
    roles,
    [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.AUDITOR, SystemRole.CLIENT_USER],
    'PROJECT:VIEW:ORGANIZATION',
    permissions,
  );
}

/** HR own the assayer workforce record; admins retain override. */
export function canManageAssayers(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS], 'ASSAYER:EDIT:ORGANIZATION', permissions);
}

/**
 * The role editor (RolesPermissionsPanel.tsx): create, rename, re-permission or delete a role.
 *
 * There is no dedicated `role:*` permission — UserController's own comment explains why: every
 * write here rides on `user:edit:organization`, the same grant `PUT /users/:id/roles` already
 * requires to change who holds which role, because granting one half without the other would
 * describe an access model nobody could actually administer. So a custom role built in
 * Admin -> Roles that holds `user:edit:organization` can administer roles too — the backend
 * genuinely allows it (`RolesGuard`'s fallback, same as everywhere else this hook mirrors it) —
 * and this screen must say so, rather than showing a permanent "requires an Administrator role"
 * notice to someone who could actually save a change.
 *
 * Named by name only (not `allowed()`, which would also admit any OTHER built-in role that
 * happens to hold this permission for an unrelated reason): today only ADMIN is granted
 * `USER:EDIT:PLATFORM`, so the two helpers agree, but a role editor is exactly the wrong screen
 * to have that stop being true silently.
 */
export function canManageRoles(roles: SystemRole[], permissions?: string[]): boolean {
  return allowedByNameOrCustomPermission(roles, [SystemRole.ADMIN], 'USER:EDIT:ORGANIZATION', permissions);
}

/**
 * Implication-aware since 2026-09-05 (see role-hierarchy.ts in @fapoms/shared): the caller's
 * names are expanded through ROLE_IMPLICATIONS before matching, so a DEVELOPER passes any check
 * that names ADMIN or PRODUCT_SUPPORT. The expansion is one-way — a DEVELOPER-only list still
 * excludes admins, which is how the technical estate is fenced off. Every capability helper in
 * this file routes through here (or `allowed`, which expands identically), so the hierarchy is
 * applied once at the match rather than remembered at 162 call sites.
 */
export function hasAnyRole(roles: SystemRole[], allowed: SystemRole[]): boolean {
  return expandRoles(roles).some((r) => allowed.includes(r as SystemRole));
}

/** Branch records are operations' to maintain; audit and finance only read them. */
export function canManageBranches(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS], 'BRANCH:EDIT:ORGANIZATION', permissions);
}

/**
 * Project writes. Operations executives and auditors can open the projects page —
 * they need the portfolio view — but hold no project:edit grant, so showing them
 * Create/Edit/Delete or transition buttons only produces a 403 on click.
 */
export function canManageProjects(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS], 'PROJECT:EDIT:ORGANIZATION', permissions);
}

/** Deleting a project is admin-only on the backend. */
export function canDeleteProjects(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN], 'PROJECT:DELETE:ORGANIZATION', permissions);
}

/**
 * Deleting a branch is admin-only on the backend (branch.controller.ts @Delete(':id')).
 * Gating the button on canManageBranches showed it to operations managers, whose click could
 * only ever return 403.
 */
export function canDeleteBranches(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN], 'BRANCH:DELETE:ORGANIZATION', permissions);
}

/** Deleting a planning rule is admin-only on the backend, as above. */
export function canDeleteRules(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN], 'PLANNING:DELETE:ORGANIZATION', permissions);
}

/** Holidays: operations own audit scheduling, so they can maintain the calendar too. */
export function canManageHolidays(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS], 'REFERENCE_DATA:EDIT:ORGANIZATION', permissions);
}

/**
 * Platform configuration — fees, tax, schedules, the mailbox the platform sends from, the
 * empanelment policy, the CERT-In/DPDP retention floors.
 *
 * Deliberately its own helper rather than reusing the notification one it happens to match
 * today: they gate different backends (SETTINGS_ADMIN_ROLES vs NOTIFICATION_ADMIN_ROLES), and
 * a page whose permission check is named after a different feature is a trap for whoever
 * changes either list next.
 *
 * Deliberately NOT permission-aware, as of 2026-09-04 — like `canAdministerDataReset` just
 * below, and for the matching reason: the backend write routes (`PUT`/`DELETE /platform-
 * settings/:key`) were tightened to `@RoleOnly()` the same day, after a role holding only
 * `configuration:edit:platform` was confirmed live to write and reset an arbitrary setting —
 * mail credentials, geofence distance, retention floors — with no ADMIN role on the account.
 * This helper used to admit that same permission via `allowed()`, which would have shown the
 * Save controls to exactly the account the backend now correctly refuses. `permissions` stays
 * an accepted (ignored) second argument only so existing call sites need no edit.
 *
 * Still named `[ADMIN]` after the DEVELOPER split: a developer arrives via the hierarchy
 * expansion inside `hasAnyRole`, and the SERVER decides which groups each of them actually
 * sees — `GET /platform-settings` returns only the caller's groups, and technical writes 403
 * anyone but a developer. This gate only decides whether edit controls render at all.
 */
export function canAdministerPlatformSettings(roles: SystemRole[], _permissions?: string[]): boolean {
  return hasAnyRole(roles, [SystemRole.ADMIN]);
}

/**
 * The "Danger Zone" data-reset tool. Named after its own feature rather than reusing
 * `canAdministerPlatformSettings` for the same reason the comment above it gives: they gate
 * different backends, and a wipe-the-database permission check should not silently ride along
 * with whatever platform-settings decides next.
 */
/**
 * DEVELOPER only, and deliberately NOT permission-aware, unlike most helpers here.
 *
 * This one wipes operational data. There is no permission in the vocabulary that means "may
 * destroy the database", and inventing one — or accepting `CONFIGURATION:EDIT` as a proxy — would
 * let an administrator hand out an ordinary-looking settings grant that turns out to include it.
 *
 * Since 2026-09-05 the wipe is the DEVELOPER's side of the destructive-action two-person rule
 * (see destructive-action.ts in @fapoms/shared): a developer requests and executes; an ADMIN only
 * ever approves, on the Approvals screen — see `canApproveDestructiveActions` below. ADMIN is
 * therefore not named here, and implication cannot add it (it runs DEVELOPER → ADMIN, never the
 * reverse). Mirrors `@Roles(SystemRole.DEVELOPER)` on `DataResetController`.
 */
export function canAdministerDataReset(roles: SystemRole[]): boolean {
  return hasAnyRole(roles, [SystemRole.DEVELOPER]);
}

/**
 * The technical settings groups — mail transport, schedules, retention clocks, security dials,
 * the Support SLA. DEVELOPER's estate alone: the server filters `GET /platform-settings` to the
 * groups the caller may see and 403s technical writes from anyone else, so this helper exists
 * for the few places the client decides whether to *offer* a technical control at all. ADMIN
 * keeps the business groups via `canAdministerPlatformSettings`, which implication lets a
 * developer pass too.
 */
export function canAdministerTechnicalSettings(roles: SystemRole[]): boolean {
  return hasAnyRole(roles, [SystemRole.DEVELOPER]);
}

/**
 * The approve side of the destructive-action two-person rule — the Approvals queue's buttons.
 *
 * Checked against the RAW role names, never the hierarchy expansion, and that is the point:
 * `expandRoles` makes every DEVELOPER an ADMIN, so an implication-aware check would show the
 * approve surface to the very person whose request needs the second pair of eyes — collapsing
 * the two-person rule back to one person. The backend approval service applies the same
 * direct-role check against the caller's stored role rows for the same reason; this mirrors it,
 * so the buttons appear exactly for the accounts whose click will be honoured.
 */
export function canApproveDestructiveActions(roles: SystemRole[]): boolean {
  return roles.includes(SystemRole.ADMIN);
}

/**
 * Registering a NEW assayer, as distinct from editing the ones already on the roster.
 *
 * `canManageAssayers` maps to `ASSAYER:EDIT` because that is what most of what it guards actually
 * does — bulk actions, row selection, the issues panel. The "Add assayer" button and the roster
 * import are creations, and a role granted edit but not create would otherwise be offered both.
 * The API makes the same distinction: `POST /assayers` requires `assayer:create:organization`.
 */
export function canCreateAssayers(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS], 'ASSAYER:CREATE:ORGANIZATION', permissions);
}

/**
 * Eligibility rules — the section folded into Platform Settings from the old `/rules` page.
 *
 * Operations own planning inputs and hold the write permission on `/planning/rules`, so they
 * had that page and must keep the section. Everything *else* on Platform Settings stays
 * administrator-only, which is why this is its own check rather than widening
 * `canAdministerPlatformSettings`: folding a page into another screen must not hand out that
 * screen's mailbox passwords and tax details along with it.
 */
export function canManagePlanningRules(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS], 'PLANNING:EDIT:ORGANIZATION', permissions);
}

/**
 * The travel section of Platform Settings — the rate card and the dials that read it.
 *
 * Auditors could read the rate card when it was a page of its own; they negotiate and check
 * offers against those numbers. Folding it into Platform Settings must not quietly take that
 * away, so they reach this section and nothing else on the screen. Managing the rates is still
 * `canManageTransportRates`, which the section applies itself.
 */
export function canReadTravelSettings(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR], 'CONFIGURATION:VIEW:ORGANIZATION', permissions);
}

/**
 * Transport rates price the travel in every offer. Operations own them — the finance role that
 * used to share this folded into OPERATIONS. Mirrors RATE_MANAGER_ROLES on the backend.
 */
export function canManageTransportRates(roles: SystemRole[], permissions?: string[]): boolean {
  return allowed(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS], 'CONFIGURATION:EDIT:ORGANIZATION', permissions);
}

/**
 * The security-incident register and DPDP rights-request queue: administrators run it (raise
 * incidents, record milestones, log and resolve rights requests), auditors read it. Mirrors
 * ComplianceController exactly — every write route there is `@Roles(SystemRole.ADMIN)` only, with
 * no `@RequirePermissions` declared at all, so there is no permission-fallback path in either
 * direction; this must stay name-only to match.
 */
export function canManageCompliance(roles: SystemRole[]): boolean {
  return hasAnyRole(roles, [SystemRole.ADMIN]);
}

/**
 * Notification & email administration. Deliberately narrower than the other config helpers:
 * these settings decide what reaches everyone's inbox and phone across the organisation, not
 * one desk's planning inputs. Mirrors NOTIFICATION_ADMIN_ROLES on the backend controller.
 */
export function canAdministerNotifications(roles: SystemRole[]): boolean {
  // Super administrators only, by decision (2026-08-17) — mirrors NOTIFICATION_ADMIN_ROLES.
  return hasAnyRole(roles, [SystemRole.ADMIN]);
}

/** Business rules feed candidate scoring directly — operations own this too. */
export function canManageZones(roles: SystemRole[]): boolean {
  return hasAnyRole(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS]);
}

/** Deletion is the only zone action reserved to admins — it can strand branches. */
export function canDeleteZones(roles: SystemRole[]): boolean {
  return hasAnyRole(roles, [SystemRole.ADMIN]);
}

/** Suspending operational rules is administrator-only — matches the backend's @Roles gate. */
export function canManageRuleBypass(roles: SystemRole[]): boolean {
  return hasAnyRole(roles, [SystemRole.ADMIN]);
}

export function canManageRules(roles: SystemRole[]): boolean {
  return hasAnyRole(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS]);
}

export function canDeleteClients(roles: SystemRole[]): boolean {
  return hasAnyRole(roles, [SystemRole.ADMIN]);
}

/**
 * Create, edit, and bulk lifecycle-transition a client — `POST /clients`, `PUT /clients/:id` and
 * `PATCH /clients/bulk/lifecycle` are all `@Roles(ADMIN, OPERATIONS)` server-side
 * (`client.controller.ts`). Unlike Delete just above, nothing on `Clients.tsx` read a role here
 * before today: the Create/Edit buttons and the bulk-transition toolbar rendered live for every
 * role that could reach the page, AUDITOR included — a live 403 on submit, not a leak, but a
 * control that invites a click it can never honour.
 */
export function canManageClients(roles: SystemRole[]): boolean {
  return hasAnyRole(roles, [SystemRole.ADMIN, SystemRole.OPERATIONS]);
}

/** The signed-in user's own id, from the same cache App.tsx populates on login. */
export function useCurrentUserId(): string | null {
  return useMemo(() => {
    try {
      const raw = localStorage.getItem('fapoms_user_cache');
      if (!raw) return null;
      return JSON.parse(raw)?.id ?? null;
    } catch {
      return null;
    }
  }, []);
}
