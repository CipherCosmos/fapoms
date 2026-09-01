import { MigrationInterface, QueryRunner } from 'typeorm';
import { resolveRegion } from '@fapoms/shared';

/**
 * Fill in the region on branches that were imported without one.
 *
 * A branch's region is a pure function of its state — we know India — and it is what scopes the
 * branch to a desk and picks its holiday calendar. The Branches-page importer used to create
 * branches without resolving it (the Add-Branch form and the project importer did), leaving
 * thousands region-less and invisible to every region-scoped desk. The importer is fixed; this
 * repairs the rows already loaded.
 *
 * Runs in Node, so it uses the exact same `resolveRegion` the application uses rather than a second
 * copy of the state→region map transliterated into SQL. Idempotent: it only touches rows whose
 * region is still null, and states it cannot resolve are left null (a data-entry problem for a
 * human, not something to guess).
 */
export class BackfillBranchRegion1793900000000 implements MigrationInterface {
  name = 'BackfillBranchRegion1793900000000';

  public async up(q: QueryRunner): Promise<void> {
    const states: Array<{ state: string | null }> = await q.query(
      `SELECT DISTINCT "state" FROM "branches" WHERE "region" IS NULL AND "state" IS NOT NULL AND "state" <> ''`,
    );
    for (const { state } of states) {
      const region = resolveRegion(state);
      if (!region) continue;
      await q.query(
        `UPDATE "branches" SET "region" = $1 WHERE "state" = $2 AND "region" IS NULL`,
        [region, state],
      );
    }
  }

  public async down(): Promise<void> {
    // No-op: a backfilled region is indistinguishable from one set at import, and nulling it back
    // would only re-hide the branches. The forward migration is safe to leave in place.
  }
}
