import { MigrationInterface, QueryRunner } from 'typeorm';
import { ReconcileRolePermissions1792000000000 } from './1792000000000-ReconcileRolePermissions';

/**
 * Put back the nineteen grants the seed took away.
 *
 * `1796000000000` left every deployed database matching `ROLE_PERMISSIONS` exactly. Running
 * `npm run seed` afterwards silently removed nineteen of those grants across four roles, because
 * the seed loaded each role without its `permissions` relation and then assigned the array — so
 * what its own comment calls a merge was a replace, against a list that was itself twelve keys
 * short of the grant table.
 *
 * Measured on the live deployment on 2026-09-10, before either fix:
 *
 *   ADMIN          63 declared, 57 held — no SYSTEM:APPROVE:PLATFORM, so no principal could
 *                  approve a destructive request and the two-person data-wipe rule could not be
 *                  completed by anyone at all
 *   DEVELOPER      64 declared, 57 held — no SYSTEM:VIEW or SYSTEM:EDIT, the whole technical
 *                  estate the role exists for
 *   OPERATIONS     39 declared, 36 held — could create, edit and DELETE an assayer, and not open
 *                  one
 *   DESK_OPERATOR   6 declared,  3 held — no ASSAYER, DOCUMENT or VALIDATION view, which is every
 *                  screen the role lands on
 *
 * Both causes are fixed in `seed.ts`, so this cannot recur. That does nothing for a database the
 * seed has already run against, which is every one of them — hence a third replay. Same delegate
 * as `1796000000000`: whatever `ROLE_PERMISSIONS` says at deploy time is what every built-in role
 * holds afterwards. Additive and idempotent, so a database that never ran the seed is unchanged.
 */
export class ReconcileRolePermissions31797800000000 implements MigrationInterface {
  name = 'ReconcileRolePermissions31797800000000';

  public async up(q: QueryRunner): Promise<void> {
    await new ReconcileRolePermissions1792000000000().up(q);
  }

  public async down(): Promise<void> {
    // Additive reconciliation has no meaningful inverse: removing grants the code table says
    // every role should hold would recreate the exact refusals this migration exists to end.
  }
}
