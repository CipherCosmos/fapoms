import * as fs from 'fs';
import * as path from 'path';

/**
 * A project may have exactly one approved customer master, and the database must be what says so.
 *
 * `approveVersion` supersedes the previous version then approves the new one inside a
 * transaction. That is correct against one caller and insufficient against two: under READ
 * COMMITTED, concurrent approvals of different versions each see the other's row as still
 * un-superseded, each supersede "all APPROVED" and find nothing, and both commit.
 *
 * The failure is quiet. The only consumer — the assignment service building an assayer's customer
 * list — orders by `versionNumber DESC`, so it keeps reading the newer version and no audit runs
 * against stale data. What breaks is the record itself: the older row stays APPROVED for good,
 * and "which version is approved" starts having two answers.
 *
 * These assertions are deliberately structural rather than behavioural. Proving the race needs
 * two real concurrent transactions against Postgres, which this suite has no database for — and
 * a unit test with mocked repositories would prove only that mocks can be called twice. What can
 * be checked without a database is that the guarantee is written down in both places it has to
 * live, which is exactly what went missing before.
 */
describe('one approved customer master per project', () => {
  const entity = fs.readFileSync(
    path.join(__dirname, 'customer-master-version.entity.ts'), 'utf8',
  );
  const migrations = path.resolve(__dirname, '../../infrastructure/database/migrations');

  it('is enforced by a unique index on the entity, not left to callers', () => {
    // Application-level "check then write" cannot hold this invariant across concurrent
    // transactions. Only the database can.
    expect(entity).toMatch(/@Index\(\s*'uq_customer_master_approved_per_project'/);
    expect(entity).toMatch(/unique:\s*true/);
  });

  it('scopes the index to APPROVED and active rows only', () => {
    // Without the status predicate every version would collide. Without `is_active`, a
    // soft-deleted approved version would permanently block approving a live one.
    const where = entity.match(/where:\s*`([^`]+)`/)?.[1] ?? '';
    expect(where).toContain("status = 'APPROVED'");
    expect(where).toContain('is_active = true');
  });

  it('ships as a migration too, because synchronize drops what it cannot see', () => {
    // An index declared only in a migration is removed the first time anyone runs with
    // DB_SYNCHRONIZE on, silently and with no error — the guarantee would vanish while the
    // migration history still claimed it was there.
    const files = fs.readdirSync(migrations).filter((f) => f.endsWith('.ts'));
    const declaring = files.filter((f) =>
      fs.readFileSync(path.join(migrations, f), 'utf8')
        .includes('uq_customer_master_approved_per_project'),
    );
    expect(declaring.length).toBeGreaterThan(0);
  });

  it('demotes pre-existing duplicates before creating the index', () => {
    // Creating a unique index on data that already violates it fails, taking the whole migration
    // run with it. The older rows are demoted first, keeping the newest — which is the one every
    // reader was already resolving to.
    const file = fs.readdirSync(migrations).find((f) =>
      fs.readFileSync(path.join(migrations, f), 'utf8')
        .includes('uq_customer_master_approved_per_project'),
    )!;
    const sql = fs.readFileSync(path.join(migrations, file), 'utf8');
    expect(sql).toMatch(/UPDATE customer_master_versions/);
    expect(sql).toMatch(/SUPERSEDED/);
    expect(sql.indexOf('UPDATE customer_master_versions')).toBeLessThan(
      sql.indexOf('CREATE UNIQUE INDEX'),
    );
  });
});
