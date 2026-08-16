import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A sequence for assignment numbers.
 *
 * Assignment numbers were `ASN-<year>-<four random digits>` against a UNIQUE constraint, with
 * no handling for a collision. Nine thousand possible values a year: the chance that the next
 * create collides with an existing number is N/9000, so at a thousand assignments in a year one
 * create in nine failed with a rolled-back transaction and a 500, at four and a half thousand it
 * was every other one, and past nine thousand it could not succeed at all. Nothing about that
 * looked like a capacity limit from the operator's chair — it looked like the button being flaky.
 *
 * `nextval` on a sequence is atomic across connections and never repeats. New numbers are
 * `ASN-<year>-<six digits, zero-padded>` — a different width from the legacy four-digit numbers,
 * so the two families cannot collide textually and existing rows keep their numbers. The
 * sequence is global rather than per-year: the year in the number is information, not a
 * namespace, and a per-year reset would need a reset job that could itself fail on 1 January.
 */
export class AssignmentNumberSequence1790400000000 implements MigrationInterface {
  name = 'AssignmentNumberSequence1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "assignment_number_seq" AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "assignment_number_seq"`);
  }
}
