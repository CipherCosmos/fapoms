import { SystemRole } from '@fapoms/shared';

export type RoutePermission = {
  path: string;
  allowedRoles: SystemRole[];
};

export const ROUTE_PERMISSIONS: RoutePermission[] = [
  {
    path: '/dashboard',
    allowedRoles: Object.values(SystemRole),
  },
  {
    path: '/executive-map',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    // Everyone who works the book needs to see which project a branch belongs to.
    path: '/projects',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
      SystemRole.VALIDATION_MANAGER,
      SystemRole.VALIDATOR,
      SystemRole.DOCUMENT_EXECUTIVE,
      SystemRole.DATA_ENTRY_HEAD,
      SystemRole.FINANCE_MANAGER,
      SystemRole.READ_ONLY_AUDITOR,
      SystemRole.HR_MANAGER,
    ],
  },
  {
    path: '/planning',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
    ],
  },
  {
    // Operations executives work this queue daily; finance needs it to see what was billable.
    path: '/assignments',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
      SystemRole.FINANCE_MANAGER,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    // Document dispatch is driven by the schedule, so the desk needs to see it.
    path: '/scheduling',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
      SystemRole.DOCUMENT_EXECUTIVE,
      SystemRole.HR_MANAGER,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    // CLIENT_USER stays out: `users` has no client_id, so an external user cannot be scoped.
    path: '/clients',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.FINANCE_MANAGER,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    path: '/billing',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.FINANCE_MANAGER,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    // Read-only for most; write controls are gated separately by canManageBranches().
    path: '/branches',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
      SystemRole.VALIDATION_MANAGER,
      SystemRole.VALIDATOR,
      SystemRole.DOCUMENT_EXECUTIVE,
      SystemRole.DATA_ENTRY_HEAD,
      SystemRole.FINANCE_MANAGER,
      SystemRole.READ_ONLY_AUDITOR,
      SystemRole.HR_MANAGER,
    ],
  },
  {
    path: '/hr',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.HR_MANAGER,
    ],
  },
  {
    path: '/assayers/:id',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.HR_MANAGER,
    ],
  },
  {
    path: '/documents',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
      SystemRole.DOCUMENT_EXECUTIVE,
      SystemRole.VALIDATION_MANAGER,
      SystemRole.VALIDATOR,
      SystemRole.DATA_ENTRY_HEAD,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    path: '/data-entry',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.DATA_ENTRY_HEAD,
      SystemRole.DOCUMENT_EXECUTIVE,
      SystemRole.VALIDATION_MANAGER,
      SystemRole.VALIDATOR,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    // Read for most; create/edit/delete is gated by canManageHolidays().
    path: '/holidays',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    // Operations own planning rules — they hold the write permission, so they need the page.
    path: '/rules',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
    ],
  },
  {
    path: '/users',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
    ],
  },
];

export function canAccessRoute(userRoles: SystemRole[], path: string): boolean {
  const routeConfig = ROUTE_PERMISSIONS.find((rp) => {
    if (rp.path.includes(':id')) {
      const pattern = new RegExp(
        `^${rp.path.replace(/:id/g, '[^/]+')}$`,
      );
      return pattern.test(path);
    }
    return rp.path === path;
  });

  if (!routeConfig) return true;

  return userRoles.some((role) => routeConfig.allowedRoles.includes(role));
}
