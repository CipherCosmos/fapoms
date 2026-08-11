import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives the assayer workforce record a dedicated owner: HR.
 *
 * Until now OPERATIONS_MANAGER held ASSAYER create/edit/delete, so the team that
 * schedules work also controlled onboarding, banking details and identity
 * documents. Those are HR responsibilities. This migration creates HR_MANAGER,
 * grants it the workforce record plus read-only visibility of the operational
 * context an HR user needs (who is assigned where, when, on which branch), and
 * revokes the assayer write grants from operations — whose controller routes no
 * longer accept them either.
 *
 * Operations keep full *read* access to assayers: they cannot plan without it.
 * Field-level masking of banking/PAN is enforced separately in
 * `assayer-visibility.ts`, not by these grants.
 *
 * Idempotent: safe to re-run against a database built with synchronize:true.
 */
export class AddHrManagerRole1786600000000 implements MigrationInterface {
  name = 'AddHrManagerRole1786600000000';

  /** Everything HR_MANAGER may do, as `RESOURCE:ACTION:SCOPE`. */
  private static readonly HR_GRANTS = [
    // The workforce record itself — HR owns it end to end.
    'ASSAYER:CREATE:ORGANIZATION',
    'ASSAYER:EDIT:ORGANIZATION',
    'ASSAYER:DELETE:ORGANIZATION',
    // Read-only operational context: an assayer's profile shows their assignments,
    // branches, schedule and workload. Without these the HR view is a blank shell.
    'ASSIGNMENT:VIEW:PLATFORM',
    'BRANCH:VIEW:PLATFORM',
    'PROJECT:VIEW:PLATFORM',
    'SCHEDULING:VIEW:PLATFORM',
    'PLANNING:VIEW:PLATFORM',
    // HR raise remarks and notify assayers about onboarding and documents.
    'COMMUNICATION:CREATE:ORGANIZATION',
  ];

  /** Taken away from operations — HR own these now. */
  private static readonly OPS_REVOKE = [
    'ASSAYER:CREATE:ORGANIZATION',
    'ASSAYER:EDIT:ORGANIZATION',
    'ASSAYER:DELETE:ORGANIZATION',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `version` has no default on roles/permissions, so every column is explicit.
    await queryRunner.query(`
      INSERT INTO roles (id, name, display_name, description, version, is_active, created_by, updated_by, created_at, updated_at)
      SELECT uuid_generate_v4(), 'HR_MANAGER', 'HR Manager',
             'Owns the assayer workforce record: onboarding, lifecycle, documents, identity and banking details.',
             1, true, 'system', 'system', NOW(), NOW()
      WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'HR_MANAGER')
    `);

    for (const grant of AddHrManagerRole1786600000000.HR_GRANTS) {
      const [resource, action, scope] = grant.split(':');
      await queryRunner.query(
        `
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM roles r
        JOIN permissions p ON p.resource = $1 AND p.action = $2 AND p.scope = $3
        WHERE r.name = 'HR_MANAGER'
          AND NOT EXISTS (
            SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
          )
      `,
        [resource, action, scope],
      );
    }

    for (const revoke of AddHrManagerRole1786600000000.OPS_REVOKE) {
      const [resource, action, scope] = revoke.split(':');
      await queryRunner.query(
        `
        DELETE FROM role_permissions rp
        USING roles r, permissions p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
          AND r.name = 'OPERATIONS_MANAGER'
          AND p.resource = $1 AND p.action = $2 AND p.scope = $3
      `,
        [resource, action, scope],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const revoke of AddHrManagerRole1786600000000.OPS_REVOKE) {
      const [resource, action, scope] = revoke.split(':');
      await queryRunner.query(
        `
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM roles r
        JOIN permissions p ON p.resource = $1 AND p.action = $2 AND p.scope = $3
        WHERE r.name = 'OPERATIONS_MANAGER'
          AND NOT EXISTS (
            SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
          )
      `,
        [resource, action, scope],
      );
    }

    await queryRunner.query(`
      DELETE FROM role_permissions rp USING roles r
      WHERE rp.role_id = r.id AND r.name = 'HR_MANAGER'
    `);
    await queryRunner.query(`DELETE FROM roles WHERE name = 'HR_MANAGER'`);
  }
}
