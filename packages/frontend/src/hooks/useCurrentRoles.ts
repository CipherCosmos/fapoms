import { useMemo } from 'react';
import { SystemRole } from '@fapoms/shared';

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

/** HR own the assayer workforce record; admins retain override. */
export function canManageAssayers(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.ADMIN, SystemRole.ADMIN, SystemRole.OPERATIONS].includes(r),
  );
}

export function hasAnyRole(roles: SystemRole[], allowed: SystemRole[]): boolean {
  return roles.some((r) => allowed.includes(r));
}

/** Branch records are operations' to maintain; audit and finance only read them. */
export function canManageBranches(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.ADMIN, SystemRole.ADMIN, SystemRole.OPERATIONS].includes(r),
  );
}

/**
 * Project writes. Operations executives and auditors can open the projects page —
 * they need the portfolio view — but hold no project:edit grant, so showing them
 * Create/Edit/Delete or transition buttons only produces a 403 on click.
 */
export function canManageProjects(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.ADMIN, SystemRole.ADMIN, SystemRole.OPERATIONS].includes(r),
  );
}

/** Deleting a project is admin-only on the backend. */
export function canDeleteProjects(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.ADMIN, SystemRole.ADMIN].includes(r));
}

/**
 * Deleting a branch is admin-only on the backend (branch.controller.ts @Delete(':id')).
 * Gating the button on canManageBranches showed it to operations managers, whose click could
 * only ever return 403.
 */
export function canDeleteBranches(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.ADMIN, SystemRole.ADMIN].includes(r));
}

/** Deleting a planning rule is admin-only on the backend, as above. */
export function canDeleteRules(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.ADMIN, SystemRole.ADMIN].includes(r));
}

/** Holidays: operations own audit scheduling, so they can maintain the calendar too. */
export function canManageHolidays(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.ADMIN, SystemRole.ADMIN, SystemRole.OPERATIONS].includes(r),
  );
}

/**
 * Platform configuration — fees, tax, schedules, the mailbox the platform sends from.
 *
 * Deliberately its own helper rather than reusing the notification one it happens to match
 * today: they gate different backends (SETTINGS_ADMIN_ROLES vs NOTIFICATION_ADMIN_ROLES), and
 * a page whose permission check is named after a different feature is a trap for whoever
 * changes either list next.
 */
export function canAdministerPlatformSettings(roles: SystemRole[]): boolean {
  // Super administrators only, by decision (2026-08-17) — mirrors SETTINGS_ADMIN_ROLES.
  return roles.includes(SystemRole.ADMIN);
}

/**
 * The "Danger Zone" data-reset tool. Named after its own feature rather than reusing
 * `canAdministerPlatformSettings` for the same reason the comment above it gives: they gate
 * different backends, and a wipe-the-database permission check should not silently ride along
 * with whatever platform-settings decides next. Mirrors the controller-level
 * `@Roles(SystemRole.ADMIN)` on `DataResetController`.
 */
export function canAdministerDataReset(roles: SystemRole[]): boolean {
  return roles.includes(SystemRole.ADMIN);
}

/**
 * Transport rates price the travel in every offer. Operations own planning inputs; finance
 * owns what things cost — both manage. Mirrors RATE_MANAGER_ROLES on the backend controller.
 */
export function canManageTransportRates(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [
      SystemRole.ADMIN,
      SystemRole.ADMIN,
      SystemRole.OPERATIONS,
      SystemRole.OPERATIONS,
    ].includes(r),
  );
}

/**
 * Notification & email administration. Deliberately narrower than the other config helpers:
 * these settings decide what reaches everyone's inbox and phone across the organisation, not
 * one desk's planning inputs. Mirrors NOTIFICATION_ADMIN_ROLES on the backend controller.
 */
export function canAdministerNotifications(roles: SystemRole[]): boolean {
  // Super administrators only, by decision (2026-08-17) — mirrors NOTIFICATION_ADMIN_ROLES.
  return roles.includes(SystemRole.ADMIN);
}

/** Business rules feed candidate scoring directly — operations own this too. */
export function canManageZones(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.ADMIN, SystemRole.ADMIN, SystemRole.OPERATIONS].includes(r),
  );
}

/** Deletion is the only zone action reserved to admins — it can strand branches. */
export function canDeleteZones(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.ADMIN, SystemRole.ADMIN].includes(r));
}

/** Suspending operational rules is administrator-only — matches the backend's @Roles gate. */
export function canManageRuleBypass(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.ADMIN, SystemRole.ADMIN].includes(r));
}

export function canManageRules(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.ADMIN, SystemRole.ADMIN, SystemRole.OPERATIONS].includes(r),
  );
}

export function canDeleteClients(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.ADMIN, SystemRole.ADMIN].includes(r));
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
