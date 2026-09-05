import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * In-app fee negotiation is removed, and `ProjectBranchStatus.NEGOTIATION` retires with it.
 *
 * The status was only ever entered by `proposeCounterFee` (the assayer's in-app counter-offer
 * flipped the branch from CONTACT_INITIATED to NEGOTIATION), and that path is deleted: fees are
 * an ops-internal fact settled on the phone now, and the assayer sees no money in the app at
 * all. A branch sitting in NEGOTIATION today is simply one whose assayer has been contacted and
 * whose price the desk is still finishing on a call — which is exactly what CONTACT_INITIATED
 * means — so the rows move there rather than being left in a state nothing can enter, nothing
 * counts as active work any more, and no screen has a lane for.
 *
 * The enum VALUE stays in `@fapoms/shared` (deprecated) and the display label stays in
 * `labels.ts`: this UPDATE cannot reach a database that is restored from an older backup, and a
 * stale row must render as "Negotiation", not crash a status map.
 */
export class RetireNegotiationBranchStatus1794500000000 implements MigrationInterface {
  name = 'RetireNegotiationBranchStatus1794500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE project_branches SET status = 'CONTACT_INITIATED', updated_by = 'migration'
        WHERE status = 'NEGOTIATION'`,
    );
  }

  /**
   * Deliberately a no-op. The counter-offer path that put branches into NEGOTIATION is deleted,
   * so restoring rows to a state no code can act on or leave would strand them, not restore
   * anything — a rolled-back deploy still has no negotiation feature for these rows to be in.
   * The rows are already in the state the old code treats as "assayer contacted, price being
   * settled", which is where a rollback wants them anyway.
   */
  public async down(): Promise<void> {
    // Intentionally empty — see above.
  }
}
