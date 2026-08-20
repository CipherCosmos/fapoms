import { MigrationInterface, QueryRunner } from 'typeorm';
import { ROLE_PERMISSIONS, ALL_GRANTED_PERMISSIONS } from '../../../modules/auth/role-permissions';

/**
 * Make the permission grants match the audiences the routes declare.
 *
 * A route names its audience with `@Roles(...)` and may also require a permission. Both guards
 * run, so a role named by `@Roles` that lacks the permission is refused — and the refusal is
 * indistinguishable from a role that was never meant to have access. Twenty-four routes were in
 * that state, and three more required permissions that existed for nobody at all:
 *
 *   - `OCR` and `ORGANIZATION` were not permission resources. Six routes — submit to OCR, its
 *     callback, retry a job, and create, edit or delete an organisation — could not be called by
 *     any principal, super administrator included.
 *   - An OPERATIONS_MANAGER could not create a branch, run or edit a plan, add a zone, edit the
 *     holiday calendar, validate a customer file or remove a branch from a project.
 *   - An ADMINISTRATOR could not create or edit an organisation.
 *   - A DATA_ENTRY_HEAD could not open a validation case.
 *
 * This is the third time this shape has been found — the holiday calendar and the business-rule
 * engine were each fixed alone, and the pattern was left to recur. `ROLE_PERMISSIONS` is now the
 * single table, and `route-permission-parity.spec.ts` fails the build on any new instance.
 *
 * Additive and idempotent: it inserts missing permission rows and missing grants, and removes
 * nothing. A deployment that already matches is unchanged.
 */
export class ReconcileRolePermissions1792000000000 implements MigrationInterface {
  name = 'ReconcileRolePermissions1792000000000';

  public async up(q: QueryRunner): Promise<void> {
    // 1. Every permission any role is granted must exist as a row.
    for (const key of ALL_GRANTED_PERMISSIONS) {
      const [resource, action, scope] = key.split(':');
      await q.query(
        `INSERT INTO permissions (resource, action, scope, description, created_by, updated_by, version, is_active)
         SELECT $1, $2, $3, $4, 'migration', 'migration', 1, true
          WHERE NOT EXISTS (
            SELECT 1 FROM permissions WHERE resource = $1 AND action = $2 AND scope = $3)`,
        [resource, action, scope, `${action} ${resource} (${scope})`],
      );
    }

    // 2. Every role holds what the routes it is named on require.
    for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
      for (const key of keys) {
        const [resource, action, scope] = key.split(':');
        await q.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT r.id, p.id
             FROM roles r, permissions p
            WHERE r.name = $1
              AND p.resource = $2 AND p.action = $3 AND p.scope = $4
              AND NOT EXISTS (
                SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
          [role, resource, action, scope],
        );
      }
    }
  }

  /**
   * Deliberately not reversible.
   *
   * `up` only ever adds, and it adds the access the routes already declare. Withdrawing it would
   * restore a state where six routes are callable by nobody and an operations manager cannot
   * create a branch — a bug, not a safer posture. Rolling this back means editing the grants.
   */
  public async down(): Promise<void> {
    // No-op by design; see above.
  }
}
