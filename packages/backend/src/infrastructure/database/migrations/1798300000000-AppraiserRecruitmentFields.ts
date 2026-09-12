import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Three columns the Appraiser Recruitment spec asks for and the roster never carried:
 * `gender`, `current_employer`, and `employment_category` (Freelancer/Proprietor — asked only at
 * self-registration, to decide which extra documents that flow requests). All nullable: every
 * assayer admitted through the HR desk before this lands, and every one admitted through it
 * afterwards, has no reason to carry the last one at all.
 */
export class AppraiserRecruitmentFields1798300000000 implements MigrationInterface {
  name = 'AppraiserRecruitmentFields1798300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "assayers"
        ADD COLUMN IF NOT EXISTS "gender" varchar(30),
        ADD COLUMN IF NOT EXISTS "current_employer" varchar(200),
        ADD COLUMN IF NOT EXISTS "employment_category" varchar(20)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "assayers"
        DROP COLUMN IF EXISTS "employment_category",
        DROP COLUMN IF EXISTS "current_employer",
        DROP COLUMN IF EXISTS "gender"
    `);
  }
}
