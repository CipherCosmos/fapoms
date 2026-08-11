import { SystemRole } from '@fapoms/shared';

/**
 * Every internal staff role.
 *
 * Read routes across most controllers carried no `@Roles` at all, and RolesGuard
 * treats absent metadata as "no restriction" — so any authenticated principal,
 * including a field assayer's mobile token and an external CLIENT_USER, could
 * read the entire client book, branch list, project portfolio and validation
 * queue. Applying this at controller level closes that by default; individual
 * routes still override it where a narrower or wider list is correct.
 *
 * CLIENT_USER is deliberately excluded: `users` has no client_id column, so a
 * client user cannot yet be scoped to their own client, and unscoped access to
 * everyone's data is worse than no access. ASSAYER is excluded for the same
 * reason — the mobile app reaches its own records through assayer-scoped routes
 * that set their own `@Roles`.
 */
export const STAFF_ROLES: SystemRole[] = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.HR_MANAGER,
  SystemRole.OPERATIONS_MANAGER,
  SystemRole.OPERATIONS_EXECUTIVE,
  SystemRole.FINANCE_MANAGER,
  SystemRole.VALIDATION_MANAGER,
  SystemRole.VALIDATOR,
  SystemRole.DOCUMENT_EXECUTIVE,
  SystemRole.DATA_ENTRY_HEAD,
  SystemRole.READ_ONLY_AUDITOR,
];
