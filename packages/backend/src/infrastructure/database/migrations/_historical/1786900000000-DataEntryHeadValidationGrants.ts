import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The data entry head reviews OCR output, requests corrections, approves and
 * submits reports to the client — that whole stage is their job, described
 * directly by the business. But DATA_ENTRY_HEAD held no VALIDATION:* grant at
 * all, so every one of those actions 403'd even after the controller's @Roles
 * lists were widened to include them. Role membership without the matching
 * permission is exactly the class of gap this migration closes.
 *
 * Idempotent: safe to re-run.
 */
export class DataEntryHeadValidationGrants1786900000000 implements MigrationInterface {
  name = 'DataEntryHeadValidationGrants1786900000000';

  private static readonly GRANTS = [
    'VALIDATION:CREATE:ORGANIZATION',
    'VALIDATION:EDIT:ORGANIZATION',
    'VALIDATION:ASSIGN:ORGANIZATION',
    'VALIDATION:REVIEW:ASSIGNED_RECORDS',
    'VALIDATION:APPROVE:ORGANIZATION',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const grant of DataEntryHeadValidationGrants1786900000000.GRANTS) {
      const [resource, action, scope] = grant.split(':');
      await queryRunner.query(
        `
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM roles r
        JOIN permissions p ON p.resource = $2::varchar AND p.action = $3::varchar AND p.scope = $4::varchar
        WHERE r.name = $1::varchar
          AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)
      `,
        ['DATA_ENTRY_HEAD', resource, action, scope],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const grant of DataEntryHeadValidationGrants1786900000000.GRANTS) {
      const [resource, action, scope] = grant.split(':');
      await queryRunner.query(
        `
        DELETE FROM role_permissions rp
        USING roles r, permissions p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
          AND r.name = 'DATA_ENTRY_HEAD' AND p.resource = $1 AND p.action = $2 AND p.scope = $3
      `,
        [resource, action, scope],
      );
    }
  }
}
