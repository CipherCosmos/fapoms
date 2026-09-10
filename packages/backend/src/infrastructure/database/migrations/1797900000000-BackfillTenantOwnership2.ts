import { MigrationInterface, QueryRunner } from 'typeorm';
import { BackfillTenantOwnership1796500000000 } from './1796500000000-BackfillTenantOwnership';

/**
 * Give the seeded branches and the seeded project an owner.
 *
 * `BackfillTenantOwnership` assigns every unowned row to the single organisation, and its own
 * comment names seeds as a creation path that had not been audited. It had not: the seed set
 * `organizationId` on users, clients and assayers and left it null on branches and projects. On a
 * fresh database the backfill also runs BEFORE the seed creates the organisation, so it has
 * nothing to assign and the rows arrive unowned a moment later.
 *
 * Measured on the live deployment on 2026-09-10: 10 of 10 branches and 1 of 1 projects had a null
 * `organization_id`. A tenant-scoped read filters on the caller's organisation, so those rows are
 * invisible to it rather than visible to everyone — the safe direction, and still wrong.
 *
 * The seed is fixed, so new databases come up owned. This is for the ones already built. Same
 * delegate as `ReconcileRolePermissions3`: the original class, run again, additive and idempotent.
 * It changes nothing on a database that has no unowned rows, and it still refuses to guess when
 * there is more than one active organisation.
 */
export class BackfillTenantOwnership21797900000000 implements MigrationInterface {
  name = 'BackfillTenantOwnership21797900000000';

  public async up(q: QueryRunner): Promise<void> {
    await new BackfillTenantOwnership1796500000000().up(q);
  }

  public async down(): Promise<void> {
    // Un-assigning ownership would put the rows back where a scoped read cannot see them.
  }
}
