import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes a real gap found live this session: `roles.name` (the internal system reference) has
 * always had a unique constraint, but `roles.display_name` — the only name any picker, table or
 * dropdown in the app actually shows — did not. A second role literally named "HR" saved
 * successfully alongside the existing `HR_OPERATOR` ("HR"), because the frontend's "System
 * Reference" field (meant to auto-derive `name` from `display_name` as an admin types) doesn't
 * stay in sync, so the two rows' auto-derived `name` values never collided against the
 * constraint that does exist.
 *
 * Case-insensitive on purpose — "HR" and "hr" read as the same role to a human picking one from
 * a list, and a case-only duplicate would be exactly as confusing as an exact one.
 */
export class UniqueRoleDisplayName1794950000000 implements MigrationInterface {
  name = 'UniqueRoleDisplayName1794950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_roles_display_name_lower" ON "roles" (LOWER("display_name"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_roles_display_name_lower"`);
  }
}
