import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the PLANNING permissions and grants them, unblocking 18 endpoints that no role
 * could reach.
 *
 * `planning.controller.ts` guards candidate recommendation, day planning and the entire
 * business-rule management API with `planning:create|edit|delete:organization`. PermissionsGuard
 * resolves those against rows in `permissions` — but PLANNING was never a member of
 * `PermissionResource` and no such row existed, so every one of those endpoints returned 403
 * for *every* role, SUPER_ADMINISTRATOR included.
 *
 * The visible consequence: `business_rules` was empty, because creating a rule was impossible
 * through the API. The rule engine supports certification-with-expiry, skill, territory,
 * capacity and client-preference rules, and had nothing to evaluate — so candidate
 * recommendations applied no regulatory constraints at all.
 *
 * (The controller also asked for the action `update`, which is not in `PermissionAction`
 * either — the enum defines EDIT. That is corrected in the decorators alongside this.)
 *
 * Idempotent: permission rows and grants are inserted only when absent.
 */
export class AddPlanningPermissions1786100000000 implements MigrationInterface {
  name = 'AddPlanningPermissions1786100000000';

  /** Roles that may manage planning rules. Deliberately not VALIDATOR/ASSAYER/CLIENT_USER. */
  private static readonly GRANTEES = ['SUPER_ADMINISTRATOR', 'ADMINISTRATOR', 'OPERATIONS_MANAGER'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // VIEW at PLATFORM scope: the guard treats PLATFORM as implying all narrower scopes, so a
    // single row covers read access everywhere.
    const perms: { action: string; scope: string }[] = [
      { action: 'VIEW', scope: 'PLATFORM' },
      { action: 'CREATE', scope: 'ORGANIZATION' },
      { action: 'EDIT', scope: 'ORGANIZATION' },
      { action: 'DELETE', scope: 'ORGANIZATION' },
    ];

    for (const p of perms) {
      await queryRunner.query(
        `
        INSERT INTO permissions (resource, action, scope, version, is_active, created_by, updated_by)
        SELECT 'PLANNING', $1::varchar, $2::varchar, 1, true, 'SYSTEM', 'SYSTEM'
        WHERE NOT EXISTS (
          SELECT 1 FROM permissions
          WHERE resource = 'PLANNING' AND action = $1::varchar AND scope = $2::varchar
        )
      `,
        [p.action, p.scope],
      );
    }

    const granted = await queryRunner.query(
      `
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r
      CROSS JOIN permissions p
      WHERE r.name = ANY($1::varchar[])
        AND p.resource = 'PLANNING'
        AND NOT EXISTS (
          SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
        )
      RETURNING role_id
    `,
      [AddPlanningPermissions1786100000000.GRANTEES],
    );

    const count = Array.isArray(granted)
      ? Array.isArray(granted[0])
        ? granted[0].length
        : granted.length
      : 0;
    console.log(`[AddPlanningPermissions] granted ${count} role-permission link(s)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permissions
      WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'PLANNING')
    `);
    await queryRunner.query(`DELETE FROM permissions WHERE resource = 'PLANNING'`);
  }
}
