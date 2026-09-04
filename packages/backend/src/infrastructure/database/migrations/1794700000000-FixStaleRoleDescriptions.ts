import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRODUCT_SUPPORT's description still claims a desk it no longer owns.
 *
 * `ConsolidateRoles1792100000000` carried a corrected description for PRODUCT_SUPPORT in its
 * `DISPLAY` map, but wrote it with `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name =
 * $1)` — an insert that only fires for a role row that does not exist yet. PRODUCT_SUPPORT already
 * existed (created earlier by `RestoreWorkflowRoles1790200000000`, and explicitly left "unchanged"
 * by the consolidation), so that guard silently skipped it forever. The role kept its original text
 * — "Owns the feedback & collaboration channel: receives, triages and answers bug reports,
 * enhancement requests and process ideas from every user" — through a later, separate product
 * decision (`feedback-roles.ts`, 2026-08-17) that restricted the feedback desk to ADMIN only.
 * PRODUCT_SUPPORT has held zero permissions since, but its own description in the Roles &
 * Permissions screen still tells an administrator the opposite.
 *
 * This corrects the description directly, in place, rather than repeating the same
 * insert-only-if-missing mistake — the bug here was specifically that an existing row's text
 * never gets revisited, so the fix has to be an UPDATE.
 */
export class FixStaleRoleDescriptions1794700000000 implements MigrationInterface {
  name = 'FixStaleRoleDescriptions1794700000000';

  private static readonly STALE_DESCRIPTION =
    'Owns the feedback & collaboration channel: receives, triages and answers bug reports, '
    + 'enhancement requests and process ideas from every user.';

  private static readonly CURRENT_DESCRIPTION =
    'Reserved for product support work. The feedback queue is limited to Admin for now — '
    + 'this role does not currently hold that access.';

  public async up(q: QueryRunner): Promise<void> {
    // Only touches the row if it still carries the exact stale text, so this stays a no-op
    // against a database where an administrator has already edited the description by hand.
    await q.query(
      `UPDATE roles SET description = $1, updated_by = 'migration'
        WHERE name = 'PRODUCT_SUPPORT' AND description = $2`,
      [FixStaleRoleDescriptions1794700000000.CURRENT_DESCRIPTION, FixStaleRoleDescriptions1794700000000.STALE_DESCRIPTION],
    );
  }

  /** Restores the exact prior text, only where this migration is the one that changed it. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE roles SET description = $1, updated_by = 'migration'
        WHERE name = 'PRODUCT_SUPPORT' AND description = $2`,
      [FixStaleRoleDescriptions1794700000000.STALE_DESCRIPTION, FixStaleRoleDescriptions1794700000000.CURRENT_DESCRIPTION],
    );
  }
}
