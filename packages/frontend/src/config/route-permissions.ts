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
    path: '/projects',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    path: '/planning',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
    ],
  },
  {
    path: '/assignments',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
    ],
  },
  {
    path: '/scheduling',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.OPERATIONS_EXECUTIVE,
      SystemRole.HR_MANAGER,
    ],
  },
  {
    path: '/clients',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.FINANCE_MANAGER,
      // CLIENT_USER deliberately absent: `users` has no client_id, so an external
      // client user cannot be scoped to their own record and would see every
      // client's data. Restore once per-client scoping exists.
    ],
  },
  {
    path: '/billing',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      // Finance owns billing; this route existed before the role did, so finance
      // staff previously had to be given an operations role to reach their own tools.
      SystemRole.FINANCE_MANAGER,
      SystemRole.OPERATIONS_MANAGER,
    ],
  },
  {
    path: '/branches',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    // The workforce console, roster included. Assayer administration belongs to HR
    // and admins only — other roles reach the assayer data they need through their
    // own tools (planning candidates, billing payees, client preferred-assayers),
    // not through a general-purpose roster.
    path: '/hr',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.HR_MANAGER,
    ],
  },
  {
    // Individual workforce record — same audience as the console it opens from.
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
      // Delegating returned packets to the data entry team is this role's whole
      // job, but it had no route to the page that does it.
      SystemRole.DATA_ENTRY_HEAD,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    // The data entry desk: returned packets, delegation, and clarifications with
    // the assayer. Validation sees it because they review what the desk produces.
    path: '/data-entry',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.DATA_ENTRY_HEAD,
      SystemRole.DOCUMENT_EXECUTIVE,
      SystemRole.VALIDATION_MANAGER,
      SystemRole.VALIDATOR,
    ],
  },
  {
    // Was absent entirely, and canAccessRoute() returns true for unknown routes —
    // so every role, including ASSAYER and CLIENT_USER, could open the internal
    // holiday administration page. Operations is included because holidays drive
    // audit scheduling, which they own.
    path: '/holidays',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
    ],
  },
  {
    path: '/rules',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
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
