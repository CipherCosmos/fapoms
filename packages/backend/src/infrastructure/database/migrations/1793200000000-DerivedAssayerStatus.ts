import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bring the operational status back in step with the HR lifecycle.
 *
 * `assayers.status` is a projection of `lifecycle_status`, and it is what every planner filters
 * on — the recommendation engine, the day planner, the command centre's capacity, the operations
 * snapshot. The state machine derived it correctly; the roster importer wrote the lifecycle
 * straight onto the entity and left `status` at its column default.
 *
 * The result: 536 of 1,163 people whose HR record says they resigned, were terminated, are
 * suspended or are inactive were operationally ACTIVE — passing the deployability gate and
 * offered as candidates for audits. Nothing failed. The two columns simply said different
 * things, and only one of them was read.
 *
 * That 536 counts those four statuses. The UPDATE below is wider, and deliberately so: it
 * rewrites `status` for EVERY lifecycle that is not ACTIVE, which on this roster is 615 people —
 * the extra 79 are INVITED, candidates who had not finished onboarding and were being offered
 * audit work. `derived-status.spec.ts` states it from that end. Both numbers are right for the
 * population each names; neither is a correction of the other.
 *
 * `AssayerEntity.deriveOperationalStatus` now applies the rule on every save, so this is the
 * one-off correction of what the drift already produced.
 */
export class DerivedAssayerStatus1793200000000 implements MigrationInterface {
  name = 'DerivedAssayerStatus1793200000000';

  public async up(q: QueryRunner): Promise<void> {
    const [{ count }] = await q.query(`
      SELECT COUNT(*)::int AS count FROM "assayers"
      WHERE "status"::text <> CASE
        WHEN "lifecycle_status"::text = 'ACTIVE' THEN 'ACTIVE'
        WHEN "lifecycle_status"::text = 'SUSPENDED' THEN 'SUSPENDED'
        ELSE 'INACTIVE' END
    `);

    await q.query(`
      UPDATE "assayers" SET "status" = (CASE
        WHEN "lifecycle_status"::text = 'ACTIVE' THEN 'ACTIVE'
        WHEN "lifecycle_status"::text = 'SUSPENDED' THEN 'SUSPENDED'
        ELSE 'INACTIVE' END)::assayers_status_enum
      WHERE "status"::text <> CASE
        WHEN "lifecycle_status"::text = 'ACTIVE' THEN 'ACTIVE'
        WHEN "lifecycle_status"::text = 'SUSPENDED' THEN 'SUSPENDED'
        ELSE 'INACTIVE' END
    `);

    // eslint-disable-next-line no-console
    console.log(`[DerivedAssayerStatus] corrected ${count} assayer(s) whose operational status contradicted their lifecycle.`);
  }

  /**
   * Not reversible. The previous values were the drift itself — restoring them would put people
   * who have left back into the candidate pool, which is the defect this removes.
   */
  public async down(): Promise<void> {
    // Intentionally empty — see above.
  }
}
