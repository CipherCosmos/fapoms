import { MigrationInterface, QueryRunner } from 'typeorm';
import { ROLE_PERMISSIONS } from '../../../modules/auth/role-permissions';

/**
 * Thirteen roles become eight, and each of the eight names a job someone does.
 *
 * The application could not tell most of the thirteen apart. Three had no capability of their
 * own at all — OPERATIONS_EXECUTIVE could reach no route an OPERATIONS_MANAGER could not, and
 * VALIDATION_MANAGER and VALIDATOR were both strict subsets of DATA_ENTRY_HEAD. ADMINISTRATOR
 * and SUPER_ADMINISTRATOR differed by seven routes, all of them the product-feedback queue. The
 * notification catalogue had already given up and addressed them in fixed pairs. Eleven of the
 * thirteen had nobody in them.
 *
 *   SUPER_ADMINISTRATOR, ADMINISTRATOR                              → ADMIN
 *   OPERATIONS_MANAGER, OPERATIONS_EXECUTIVE,
 *     FINANCE_MANAGER, HR_MANAGER                                   → OPERATIONS
 *   DOCUMENT_EXECUTIVE, DATA_ENTRY_HEAD, VALIDATION_MANAGER         → DESK
 *   VALIDATOR                                                       → DESK_OPERATOR
 *   READ_ONLY_AUDITOR                                               → AUDITOR
 *   PRODUCT_SUPPORT, CLIENT_USER, ASSAYER                           → unchanged
 *
 * Nobody loses an ability: each new role is granted the union of what the roles it replaces
 * held, and anyone holding an old role comes out holding the one that replaced it. Two things
 * do widen, both consequences of folding finance and workforce into operations, both chosen
 * deliberately: an operations user can now approve a payout for work they scheduled, and can
 * read an assayer's identity documents and bank details. ADMIN remains on the disbursement
 * path so a second pair of eyes is still possible.
 *
 * Idempotent, and safe to run against a database that has already been consolidated.
 */
export class ConsolidateRoles1792100000000 implements MigrationInterface {
  name = 'ConsolidateRoles1792100000000';

  /** old name → the role that replaces it. Roles absent from this map keep their name. */
  private static readonly MERGES: Array<[string, string]> = [
    ['SUPER_ADMINISTRATOR', 'ADMIN'],
    ['ADMINISTRATOR', 'ADMIN'],
    ['OPERATIONS_MANAGER', 'OPERATIONS'],
    ['OPERATIONS_EXECUTIVE', 'OPERATIONS'],
    ['FINANCE_MANAGER', 'OPERATIONS'],
    ['HR_MANAGER', 'OPERATIONS'],
    ['DOCUMENT_EXECUTIVE', 'DESK'],
    ['DATA_ENTRY_HEAD', 'DESK'],
    ['VALIDATION_MANAGER', 'DESK'],
    ['VALIDATOR', 'DESK_OPERATOR'],
    ['READ_ONLY_AUDITOR', 'AUDITOR'],
  ];

  private static readonly DISPLAY: Record<string, [string, string]> = {
    ADMIN: ['Admin', 'Runs the platform: settings, people and access, and everything the other roles can do.'],
    OPERATIONS: ['Operations', 'Runs the work: clients, projects, branches, planning and scheduling — and the money and the assayer workforce.'],
    DESK: ['Desk', 'Runs the paperwork end to end: packets out to the field, back again, through data entry and validation.'],
    DESK_OPERATOR: ['Desk Operator', 'Works their own share of the desk queue: takes a packet, types it up, hands it back.'],
    AUDITOR: ['Auditor', 'Sees everything and changes nothing.'],
    PRODUCT_SUPPORT: ['Product & Support', 'Answers feedback, bug reports and suggestions from staff, clients and assayers.'],
    CLIENT_USER: ['Client User', "The client's own people, seeing their own work."],
  };

  public async up(q: QueryRunner): Promise<void> {
    // 1. Every target role exists.
    for (const [name, [displayName, description]] of Object.entries(ConsolidateRoles1792100000000.DISPLAY)) {
      await q.query(
        // Cast for the same reason as in ReconcileRolePermissions: a parameter used both in a
        // SELECT list and in a comparison has no type Postgres can deduce on its own.
        `INSERT INTO roles (name, display_name, description, created_by, updated_by, version, is_active)
         SELECT $1::varchar, $2::varchar, $3::varchar, 'migration', 'migration', 1, true
          WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = $1)`,
        [name, displayName, description],
      );
    }

    for (const [from, to] of ConsolidateRoles1792100000000.MERGES) {
      // 2. Everyone holding the old role holds the new one. `ON CONFLICT DO NOTHING` covers the
      //    person who held two roles that merge into the same one.
      await q.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT ur.user_id, target.id
           FROM user_roles ur
           JOIN roles old    ON old.id = ur.role_id AND old.name = $1
           JOIN roles target ON target.name = $2
         ON CONFLICT DO NOTHING`,
        [from, to],
      );
      // 3. The old role is emptied and removed. Its grants go with it; step 4 re-establishes
      //    the union on the target, so nothing is lost by deleting them here.
      await q.query(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = $1)`, [from]);
      await q.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = $1)`, [from]);
      await q.query(`DELETE FROM roles WHERE name = $1`, [from]);
    }

    // 4. Each surviving role holds the union of what its predecessors held.
    for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
      for (const key of keys) {
        const [resource, action, scope] = key.split(':');
        await q.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT r.id, p.id
             FROM roles r, permissions p
            WHERE r.name = $1 AND p.resource = $2 AND p.action = $3 AND p.scope = $4
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
   * Splitting ADMIN back into a super administrator and an administrator, or OPERATIONS back
   * into four roles, means deciding which of them each person should get — and the information
   * needed to decide that is exactly what this migration merges away. Reversing it would have
   * to invent those answers. If the roles need separating again, that is a new design with a
   * new migration, not an undo.
   */
  public async down(): Promise<void> {
    // No-op by design; see above.
  }
}
