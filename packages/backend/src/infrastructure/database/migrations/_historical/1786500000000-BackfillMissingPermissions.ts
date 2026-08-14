import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the permission rows that 22 already-guarded endpoints require but which
 * were never seeded — so those endpoints returned 403 for every role, including
 * SUPER_ADMINISTRATOR.
 *
 * Found by diffing every `@RequirePermissions('resource:action:scope')` string in
 * the codebase against the resource/action/scope combinations actually granted to
 * a role. 22 of 36 had no satisfying row. The effect is not subtle: bulk assayer
 * import, branch create/delete, zone and holiday management, document create/edit
 * and organisation management were all unreachable through the API.
 *
 * This is the same defect class already repaired for PLANNING, CLIENT, BILLING and
 * CUSTOMER_MASTER; this migration closes the remaining set rather than leaving
 * them to be discovered one at a time.
 *
 * Grants follow the pattern of the existing seed: administrators get everything,
 * operations roles get the operational resources they work with day to day, and
 * nothing new is granted to field or read-only roles.
 */
export class BackfillMissingPermissions1786500000000 implements MigrationInterface {
  name = 'BackfillMissingPermissions1786500000000';

  /** resource → actions needed at ORGANIZATION scope. */
  private static readonly NEEDED: Record<string, string[]> = {
    ASSAYER: ['CREATE', 'EDIT', 'DELETE'],
    BRANCH: ['CREATE', 'DELETE'],
    ZONE: ['CREATE', 'EDIT', 'DELETE'],
    HOLIDAY: ['CREATE', 'EDIT', 'DELETE'],
    DOCUMENT: ['CREATE', 'EDIT'],
    ORGANIZATION: ['CREATE', 'EDIT', 'DELETE'],
    AUDIT: ['CREATE', 'EDIT'],
    OCR: ['CREATE', 'EDIT'],
    COMMUNICATION: ['CREATE'],
    PROJECT: ['DELETE'],
  };

  /** Which roles receive which resources. */
  private static readonly GRANTS: Record<string, string[]> = {
    SUPER_ADMINISTRATOR: ['ASSAYER', 'BRANCH', 'ZONE', 'HOLIDAY', 'DOCUMENT', 'ORGANIZATION', 'AUDIT', 'OCR', 'COMMUNICATION', 'PROJECT'],
    ADMINISTRATOR: ['ASSAYER', 'BRANCH', 'ZONE', 'HOLIDAY', 'DOCUMENT', 'ORGANIZATION', 'AUDIT', 'OCR', 'COMMUNICATION', 'PROJECT'],
    // Operations run the day-to-day book but do not administer the organisation itself.
    OPERATIONS_MANAGER: ['ASSAYER', 'BRANCH', 'ZONE', 'HOLIDAY', 'DOCUMENT', 'AUDIT', 'OCR', 'COMMUNICATION'],
    OPERATIONS_EXECUTIVE: ['DOCUMENT', 'COMMUNICATION'],
    DOCUMENT_EXECUTIVE: ['DOCUMENT'],
    DATA_ENTRY_HEAD: ['DOCUMENT', 'OCR'],
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [resource, actions] of Object.entries(BackfillMissingPermissions1786500000000.NEEDED)) {
      for (const action of actions) {
        await queryRunner.query(
          `INSERT INTO permissions (resource, action, scope, description, version, is_active, created_by, updated_by)
           SELECT $1::varchar, $2::varchar, 'ORGANIZATION'::varchar, $3::varchar, 1, true, 'SYSTEM'::varchar, 'SYSTEM'::varchar
           WHERE NOT EXISTS (
             SELECT 1 FROM permissions
              WHERE resource = $1::varchar AND action = $2::varchar AND scope = 'ORGANIZATION'
           )`,
          [resource, action, `${resource} ${action.toLowerCase()} (organization)`],
        );
      }
    }

    for (const [roleName, resources] of Object.entries(BackfillMissingPermissions1786500000000.GRANTS)) {
      for (const resource of resources) {
        const actions = BackfillMissingPermissions1786500000000.NEEDED[resource] ?? [];
        for (const action of actions) {
          await queryRunner.query(
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT r.id, p.id
               FROM roles r, permissions p
              WHERE r.name = $1::varchar
                AND p.resource = $2::varchar AND p.action = $3::varchar AND p.scope = 'ORGANIZATION'
                AND NOT EXISTS (
                  SELECT 1 FROM role_permissions rp
                   WHERE rp.role_id = r.id AND rp.permission_id = p.id
                )`,
            [roleName, resource, action],
          );
        }
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [resource, actions] of Object.entries(BackfillMissingPermissions1786500000000.NEEDED)) {
      for (const action of actions) {
        await queryRunner.query(
          `DELETE FROM role_permissions
            WHERE permission_id IN (
              SELECT id FROM permissions
               WHERE resource = $1::varchar AND action = $2::varchar AND scope = 'ORGANIZATION'
            )`,
          [resource, action],
        );
      }
    }
    // Permission rows themselves are left in place: they describe capabilities the
    // guarded endpoints genuinely require, and removing them would only recreate
    // the unreachable state this migration exists to fix.
  }
}
