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
    [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER].includes(r),
  );
}

export function hasAnyRole(roles: SystemRole[], allowed: SystemRole[]): boolean {
  return roles.some((r) => allowed.includes(r));
}

/** Branch records are operations' to maintain; audit and finance only read them. */
export function canManageBranches(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER].includes(r),
  );
}

/**
 * Project writes. Operations executives and auditors can open the projects page —
 * they need the portfolio view — but hold no project:edit grant, so showing them
 * Create/Edit/Delete or transition buttons only produces a 403 on click.
 */
export function canManageProjects(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER].includes(r),
  );
}

/** Deleting a project is admin-only on the backend. */
export function canDeleteProjects(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR].includes(r));
}

/**
 * Deleting a branch is admin-only on the backend (branch.controller.ts @Delete(':id')).
 * Gating the button on canManageBranches showed it to operations managers, whose click could
 * only ever return 403.
 */
export function canDeleteBranches(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR].includes(r));
}

/** Deleting a planning rule is admin-only on the backend, as above. */
export function canDeleteRules(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR].includes(r));
}

/** Holidays: operations own audit scheduling, so they can maintain the calendar too. */
export function canManageHolidays(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER].includes(r),
  );
}

/** Business rules feed candidate scoring directly — operations own this too. */
export function canManageZones(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER].includes(r),
  );
}

/** Deletion is the only zone action reserved to admins — it can strand branches. */
export function canDeleteZones(roles: SystemRole[]): boolean {
  return roles.some((r) => [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR].includes(r));
}

export function canManageRules(roles: SystemRole[]): boolean {
  return roles.some((r) =>
    [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER].includes(r),
  );
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
