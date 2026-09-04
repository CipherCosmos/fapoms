import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `users.client_id` — the missing structural link a CLIENT_USER account needs to be
 * scoped to its own client.
 *
 * Until now `users` had no client column at all (see `staff-roles.ts`'s comment on why
 * CLIENT_USER is excluded from STAFF_ROLES: "a client user cannot yet be scoped to their own
 * client, and unscoped access to everyone's data is worse than no access"). In practice that
 * meant the handful of endpoints a CLIENT_USER can actually reach today — `GET /scheduling`,
 * `GET /scheduling/:id`, the three `customer-master` read routes, and `GET
 * /system-dashboard/metrics` (reachable only via the permission-fallback in `RolesGuard`, not
 * an intended grant) — applied no client ceiling whatsoever: a client-user account could read
 * every other bank's schedules and customer-master records, not just its own.
 *
 * `NULL` mirrors `users.regions`' existing null-means-unrestricted convention: every staff
 * account (which never has a client) keeps working unchanged, and only an account a human
 * deliberately assigns a client to becomes scoped. See `resolveClientScope` in
 * `global-scope.ts` for the enforcement this column feeds.
 */
export class AddUserClientIdScope1794900000000 implements MigrationInterface {
  name = 'AddUserClientIdScope1794900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "client_id" uuid NULL REFERENCES "clients"("id")`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "users"."client_id" IS 'Assigned client (bank). NULL means unrestricted (every staff account). Non-null confines a CLIENT_USER to that client''s own data.'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_users_client_id" ON "users" ("client_id") WHERE "client_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_client_id"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "client_id"`);
  }
}
