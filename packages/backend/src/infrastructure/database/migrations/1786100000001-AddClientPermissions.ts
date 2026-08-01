import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the CLIENT permissions and grants them, unblocking the client management
 * endpoints that no role could reach.
 *
 * `client.controller.ts` guards profile create/update/delete, lifecycle transitions,
 * and the contacts/contracts/billing endpoints with `client:create|edit|delete:organization`.
 * PermissionsGuard resolves those against rows in `permissions` — but CLIENT was never a
 * member of the seeded `defaultPermissions`, so no such rows existed and every one of those
 * endpoints returned 403 for *every* role, SUPER_ADMINISTRATOR included.
 *
 * The controller also asked for the action `update`, which is not in `PermissionAction`
 * (the enum defines EDIT). That is corrected in the decorators alongside this.
 *
 * Idempotent: permission rows and grants are inserted only when absent.
 */
export class AddClientPermissions1786100000001 implements MigrationInterface {
  name = 'AddClientPermissions1786100000001';

  /** Roles that may manage clients. Deliberately not VALIDATOR/ASSAYER/CLIENT_USER. */
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
        SELECT 'CLIENT', $1::varchar, $2::varchar, 1, true, 'SYSTEM', 'SYSTEM'
        WHERE NOT EXISTS (
          SELECT 1 FROM permissions
          WHERE resource = 'CLIENT' AND action = $1::varchar AND scope = $2::varchar
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
        AND p.resource = 'CLIENT'
        AND NOT EXISTS (
          SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
        )
      RETURNING role_id
    `,
      [AddClientPermissions1786100000001.GRANTEES],
    );

    const count = Array.isArray(granted)
      ? Array.isArray(granted[0])
        ? granted[0].length
        : granted.length
      : 0;
    console.log(`[AddClientPermissions] granted ${count} role-permission link(s)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permissions
      WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'CLIENT')
    `);
    await queryRunner.query(`DELETE FROM permissions WHERE resource = 'CLIENT'`);
  }
}
