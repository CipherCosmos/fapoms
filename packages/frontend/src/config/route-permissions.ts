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
  {
    path: '/settings',
    allowedRoles: Object.values(SystemRole),
  },
  {
    // Everyone has a notification inbox; it only ever shows their own.
    path: '/notifications',
    allowedRoles: Object.values(SystemRole),
  },
  {
    // Redirect shims kept for old links. They forward to /data-entry and /hr respectively, and
    // must carry the same roles as their destination or the redirect lands on a denied page.
    path: '/validation',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.VALIDATION_MANAGER,
      SystemRole.VALIDATOR,
      SystemRole.DATA_ENTRY_HEAD,
      SystemRole.DOCUMENT_EXECUTIVE,
      SystemRole.READ_ONLY_AUDITOR,
    ],
  },
  {
    path: '/assayers',
    allowedRoles: [
      SystemRole.SUPER_ADMINISTRATOR,
      SystemRole.ADMINISTRATOR,
      SystemRole.HR_MANAGER,
    ],
  },
];

/**
 * Whether a role may open a path.
 *
 * Two things this used to get wrong, both of which matter more now that roles have several
 * pages each rather than one:
 *
 * 1. Matching was exact, so a sub-path like `/hr/roster` matched no entry at all — and an
 *    unmatched path fell through to "allow". Every page added under an existing section would
 *    therefore have been reachable by every role, including a read-only auditor. Matching is
 *    now longest-prefix, so a sub-path inherits its section's roles unless it declares its own.
 *
 * 2. The fallback was allow-by-default, which means forgetting an entry silently publishes a
 *    page. For a product whose whole purpose is controlled access to audit evidence, the safe
 *    default is the other way round: an unlisted path is denied, and the omission shows up as a
 *    missing page rather than as a leak.
 */
export function canAccessRoute(userRoles: SystemRole[], path: string): boolean {
  const matches = ROUTE_PERMISSIONS.filter((rp) => {
    if (rp.path.includes(':id')) {
      return new RegExp(`^${rp.path.replace(/:id/g, '[^/]+')}$`).test(path);
    }
    return path === rp.path || path.startsWith(`${rp.path}/`);
  });

  if (matches.length === 0) return false;

  // Most specific wins: `/hr/pay` beats `/hr` when both are declared.
  const routeConfig = matches.reduce((best, rp) => (rp.path.length > best.path.length ? rp : best));

  return userRoles.some((role) => routeConfig.allowedRoles.includes(role));
}
