import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the standalone audit-lifecycle tables retired in ADR-006.
 *
 * `modules/audit` + `modules/audit-history` were a redundant parallel model of assignment
 * completion: closing an audit created an `audits` row and called the same idempotent
 * `syncPayableForAssignment` the live assignment-completion flow already triggers through the
 * transactional outbox. The modules had no UI caller and booked no money the assignment path
 * did not. They have been removed; these tables go with them.
 *
 * The tables were only ever created by dev-time `synchronize`, never by a migration, so a
 * production database may not have them — every drop is `IF EXISTS`. This is not the live
 * `core/audit` audit-log; that stays.
 */
export class DropRetiredAuditLifecycle1787800000000 implements MigrationInterface {
  name = 'DropRetiredAuditLifecycle1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_evidence"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_history"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audits"`);
  }

  public async down(): Promise<void> {
    // No-op: the retired lifecycle is not being reinstated. If it ever is, restore the entities
    // and let a fresh migration recreate the tables from their definitions — recreating empty
    // shells here would only invite the same drift ADR-006 removed.
  }
}
