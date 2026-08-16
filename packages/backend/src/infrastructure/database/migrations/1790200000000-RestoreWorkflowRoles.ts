import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Puts back the eight workflow roles the baseline squash dropped.
 *
 * `SystemRole` defines thirteen roles. Five of them are created by `seed.ts`; the other eight
 * were created by migrations — `AddHrManagerRole`, `UnifyBillingEngine`, `AddMissingWorkflowRoles`
 * and `FeedbackChannel` — which now live under `_historical` and never run. `BaselineSchema`
 * carries the tables but none of these rows, so a database built today holds five roles and
 * nothing can be staffed with the rest.
 *
 * That is precisely the defect `AddMissingWorkflowRoles` was written to fix, reintroduced:
 * "every route reserved for those roles was therefore reachable by nobody, and the work was
 * being done by over-privileged operations/administrator accounts instead."
 *
 * It also silently breaks notification fan-out. `DESK_SUBMIT_OVERDUE` is addressed to
 * DATA_ENTRY_HEAD and VALIDATION_MANAGER; with neither role in the table it resolves to zero
 * recipients, so an overdue desk submission notifies nobody at all — no bell, no email, and no
 * error either, because "no user holds this role" is indistinguishable from "everybody read it".
 *
 * ASSAYER is deliberately absent, as it was originally: assayers authenticate against the
 * `assayers` table, not `users`.
 *
 * Grants are copied verbatim from the migrations that first issued them, including keys whose
 * permission rows do not exist in this schema (OCR, COMMUNICATION). Those joins match nothing
 * and insert nothing, exactly as before — keeping them means the grant appears the moment such a
 * permission is introduced, rather than being silently forgotten.
 *
 * Idempotent: every statement is guarded, so re-running changes nothing.
 */
export class RestoreWorkflowRoles1790200000000 implements MigrationInterface {
  name = 'RestoreWorkflowRoles1790200000000';

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
    {
      name: 'HR_MANAGER',
      displayName: 'HR Manager',
      description:
        'Owns the assayer workforce record: onboarding, lifecycle, documents, identity and banking details.',
      grants: [
        'ASSAYER:CREATE:ORGANIZATION', 'ASSAYER:EDIT:ORGANIZATION', 'ASSAYER:DELETE:ORGANIZATION',
        'ASSIGNMENT:VIEW:PLATFORM', 'BRANCH:VIEW:PLATFORM', 'PROJECT:VIEW:PLATFORM',
        'SCHEDULING:VIEW:PLATFORM', 'PLANNING:VIEW:PLATFORM',
        'COMMUNICATION:CREATE:ORGANIZATION',
      ],
    },
    {
      name: 'FINANCE_MANAGER',
      displayName: 'Finance Manager',
      description: 'Owns receivables, payables, invoicing and financial reporting.',
      grants: [
        'BILLING:VIEW:PLATFORM', 'BILLING:CREATE:ORGANIZATION', 'BILLING:EDIT:ORGANIZATION',
        'BILLING:APPROVE:ORGANIZATION', 'BILLING:CANCEL:ORGANIZATION', 'BILLING:EXPORT:ORGANIZATION',
      ],
    },
    {
      // Feedback endpoints gate on role membership rather than RBAC permissions, so this role
      // needs no grants to work. It exists so it is assignable and so notification fan-out for
      // the two FEEDBACK_SLA_* events can reach it.
      name: 'PRODUCT_SUPPORT',
      displayName: 'Product Support',
      description:
        'Owns the feedback & collaboration channel: receives, triages and answers bug reports, '
        + 'enhancement requests and process ideas from every user.',
      grants: [],
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const role of RestoreWorkflowRoles1790200000000.ROLES) {
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
    // Only roles nobody has been given — dropping a staffed role would strip live users of
    // their access as a side effect of a schema rollback.
    const names = RestoreWorkflowRoles1790200000000.ROLES.map((r) => r.name);
    await queryRunner.query(
      `
      DELETE FROM role_permissions rp
      USING roles r
      WHERE rp.role_id = r.id
        AND r.name = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_id = r.id)
    `,
      [names],
    );
    await queryRunner.query(
      `
      DELETE FROM roles r
      WHERE r.name = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_id = r.id)
    `,
      [names],
    );
  }
}
