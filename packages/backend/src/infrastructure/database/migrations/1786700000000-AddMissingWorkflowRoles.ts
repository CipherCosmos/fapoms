import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the role rows for workflow roles that only ever existed in code.
 *
 * `SystemRole` and dozens of `@Roles(...)` lists reference VALIDATION_MANAGER,
 * DOCUMENT_EXECUTIVE, DATA_ENTRY_HEAD, READ_ONLY_AUDITOR and CLIENT_USER, and the
 * frontend route table gates pages on them — but the `roles` table only ever held
 * six rows, so no user could be given any of them. Every route reserved for those
 * roles was therefore reachable by nobody, and the work was being done by
 * over-privileged operations/administrator accounts instead.
 *
 * Grants are deliberately narrow: each role gets exactly what its part of the
 * workflow needs. ASSAYER is intentionally absent — assayers authenticate against
 * the `assayers` table, not `users`.
 *
 * Idempotent: safe to re-run.
 */
export class AddMissingWorkflowRoles1786700000000 implements MigrationInterface {
  name = 'AddMissingWorkflowRoles1786700000000';

  private static readonly ROLES: {
    name: string;
    displayName: string;
    description: string;
    grants: string[];
  }[] = [
    {
      name: 'VALIDATION_MANAGER',
      displayName: 'Validation Manager',
      description: 'Owns the validation queue: assigns cases, resolves queries, signs off reports.',
      grants: [
        'VALIDATION:CREATE:ORGANIZATION', 'VALIDATION:EDIT:ORGANIZATION',
        'DOCUMENT:DOWNLOAD:PLATFORM', 'DOCUMENT:EDIT:ORGANIZATION',
        'OCR:CREATE:ORGANIZATION', 'OCR:EDIT:ORGANIZATION',
        'ASSIGNMENT:VIEW:PLATFORM', 'BRANCH:VIEW:PLATFORM', 'PROJECT:VIEW:PLATFORM',
        'COMMUNICATION:CREATE:ORGANIZATION',
      ],
    },
    {
      name: 'DOCUMENT_EXECUTIVE',
      displayName: 'Document Executive',
      description: 'Prepares and dispatches audit packets to assayers and receives scanned returns.',
      grants: [
        'DOCUMENT:CREATE:ORGANIZATION', 'DOCUMENT:EDIT:ORGANIZATION',
        'DOCUMENT:UPLOAD:ORGANIZATION', 'DOCUMENT:GENERATE:ORGANIZATION',
        'DOCUMENT:DOWNLOAD:PLATFORM',
        'ASSIGNMENT:VIEW:PLATFORM', 'BRANCH:VIEW:PLATFORM', 'PROJECT:VIEW:PLATFORM',
        'SCHEDULING:VIEW:PLATFORM', 'COMMUNICATION:CREATE:ORGANIZATION',
      ],
    },
    {
      name: 'DATA_ENTRY_HEAD',
      displayName: 'Data Entry Head',
      description: 'Delegates returned audit packets to the data entry team and tracks processing.',
      grants: [
        'DOCUMENT:DOWNLOAD:PLATFORM', 'DOCUMENT:EDIT:ORGANIZATION',
        'OCR:CREATE:ORGANIZATION', 'OCR:EDIT:ORGANIZATION',
        'ASSIGNMENT:VIEW:PLATFORM', 'BRANCH:VIEW:PLATFORM', 'PROJECT:VIEW:PLATFORM',
        'COMMUNICATION:CREATE:ORGANIZATION',
      ],
    },
    {
      name: 'READ_ONLY_AUDITOR',
      displayName: 'Read-Only Auditor',
      description: 'Sees everything, changes nothing. For internal audit and compliance review.',
      grants: [
        'ASSIGNMENT:VIEW:PLATFORM', 'BRANCH:VIEW:PLATFORM', 'PROJECT:VIEW:PLATFORM',
        'CLIENT:VIEW:PLATFORM', 'SCHEDULING:VIEW:PLATFORM', 'PLANNING:VIEW:PLATFORM',
        'BILLING:VIEW:PLATFORM', 'AUDIT_LOG:VIEW:PLATFORM',
      ],
    },
    {
      name: 'CLIENT_USER',
      displayName: 'Client User',
      description: 'External client contact: sees their own projects, branches and coverage.',
      grants: ['PROJECT:VIEW:PLATFORM', 'BRANCH:VIEW:PLATFORM', 'SCHEDULING:VIEW:PLATFORM'],
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const role of AddMissingWorkflowRoles1786700000000.ROLES) {
      await queryRunner.query(
        `
        INSERT INTO roles (id, name, display_name, description, version, is_active, created_by, updated_by, created_at, updated_at)
        SELECT uuid_generate_v4(), $1::varchar, $2::varchar, $3::text, 1, true, 'system', 'system', NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = $1::varchar)
      `,
        [role.name, role.displayName, role.description],
      );

      for (const grant of role.grants) {
        const [resource, action, scope] = grant.split(':');
        await queryRunner.query(
          `
          INSERT INTO role_permissions (role_id, permission_id)
          SELECT r.id, p.id
          FROM roles r
          JOIN permissions p ON p.resource = $2::varchar AND p.action = $3::varchar AND p.scope = $4::varchar
          WHERE r.name = $1::varchar
            AND NOT EXISTS (
              SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
            )
        `,
          [role.name, resource, action, scope],
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const names = AddMissingWorkflowRoles1786700000000.ROLES.map((r) => r.name);
    await queryRunner.query(
      `DELETE FROM role_permissions rp USING roles r WHERE rp.role_id = r.id AND r.name = ANY($1)`,
      [names],
    );
    await queryRunner.query(`DELETE FROM roles WHERE name = ANY($1)`, [names]);
  }
}
