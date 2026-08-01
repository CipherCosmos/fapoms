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
    ],
  },
  {
    path: '/clients',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.CLIENT_USER,
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
    path: '/assayers',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.ASSAYER,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    path: '/assayers/:id',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.ASSAYER,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    path: '/documents',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.OPERATIONS_MANAGER,
      SystemRole.DOCUMENT_EXECUTIVE,
      SystemRole.VALIDATION_MANAGER,
      SystemRole.VALIDATOR,
    ],
  },
  {
    path: '/validation',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.VALIDATION_MANAGER,
      SystemRole.VALIDATOR,
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
