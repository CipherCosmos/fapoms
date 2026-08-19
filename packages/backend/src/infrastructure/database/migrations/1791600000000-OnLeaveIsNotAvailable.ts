import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An assayer on leave stops being offered work.
 *
 * `assayers.status` is the operational projection of `lifecycle_status`, and every planner
 * filters on it — the recommendation engine, the day planner, the command centre's daily
 * capacity figure, the operations snapshot. `ON_LEAVE` projected to `ACTIVE`, so marking
 * somebody on leave in HR left them in the candidate pool and still counted them toward
 * capacity, while the roster showed them as not active. The projection is fixed in
 * `AssayerStateMachine`; this re-syncs the rows already stored, which would otherwise keep
 * their stale `ACTIVE` until their next lifecycle transition.
 *
 * Dated leave (`ConstraintEvaluator.checkLeaves`) is unaffected and still answers the
 * per-date question.
 */
export class OnLeaveIsNotAvailable1791600000000 implements MigrationInterface {
  name = 'OnLeaveIsNotAvailable1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE assayers SET status = 'INACTIVE'
       WHERE lifecycle_status = 'ON_LEAVE' AND status = 'ACTIVE'
    `);
  }

  /**
   * Restores the old projection for anyone still on leave. Deliberately narrow: it must not
   * reactivate someone who was made INACTIVE for any other reason.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE assayers SET status = 'ACTIVE'
       WHERE lifecycle_status = 'ON_LEAVE' AND status = 'INACTIVE'
    `);
  }
}
