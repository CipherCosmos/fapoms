import { MigrationInterface, QueryRunner } from 'typeorm';
import { ReconcileRolePermissions1792000000000 } from './1792000000000-ReconcileRolePermissions';

/**
 * Replay the grant reconciliation against today's `ROLE_PERMISSIONS`.
 *
 * The 1792000000000 reconcile reads the code table live, so it is always current — but it only
 * runs once. Grants added to the code AFTER a database had already run it (the 2026-09-03
 * write-without-read batch: seven `*:VIEW:*` grants for roles that could already edit the same
 * resources) never reached that database. Found live on 2026-09-05: an OPERATIONS account was
 * refused `GET /hr/workforce` — `@Roles` admitted it by name, `PermissionsGuard` refused it on
 * `assayer:view:organization`, a grant the code table says it holds and its rows did not.
 * The DEVELOPER role (1795900000000) then copied ADMIN's drifted rows, inheriting the gap.
 *
 * Delegating to the original class rather than pasting its loops keeps one implementation:
 * whatever `ROLE_PERMISSIONS` says at deploy time is what every built-in role holds afterwards.
 * Additive and idempotent, same as the original — reruns are no-ops on a matching database.
 */
export class ReconcileRolePermissions21796000000000 implements MigrationInterface {
  name = 'ReconcileRolePermissions21796000000000';

  public async up(q: QueryRunner): Promise<void> {
    await new ReconcileRolePermissions1792000000000().up(q);
  }

  public async down(): Promise<void> {
    // Additive reconciliation has no meaningful inverse: removing grants the code table says
    // every role should hold would recreate the exact refusals this migration exists to end.
  }
}
