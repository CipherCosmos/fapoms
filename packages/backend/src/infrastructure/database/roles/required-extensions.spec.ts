import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { REQUIRED_EXTENSIONS } from './provision';

/**
 * TWO PLACES SAY WHAT THIS DATABASE NEEDS INSTALLED. THEY HAVE TO AGREE.
 *
 * `provision.ts` installs extensions as the administrative login. The migrations create them too,
 * with `CREATE EXTENSION IF NOT EXISTS`, so on a database the migration role owns the second is a
 * no-op and the first is what actually matters — three of the five are "trusted" in PostgreSQL 13+
 * and a non-superuser owning the database can create them itself.
 *
 * Which is exactly why the list falling behind is invisible. `pg_trgm` was missing and nothing
 * failed until a database the migrator did NOT own; `btree_gist` was missing behind it and was
 * only found by somebody running the whole path on a real stack. Both were added by hand, which is
 * the fix that does not last.
 *
 * So the list is checked against the migrations rather than remembered. A migration that adds an
 * extension now fails this test until `REQUIRED_EXTENSIONS` names it too.
 */
describe('the extensions provisioning installs cover the ones migrations create', () => {
  const MIGRATIONS = join(__dirname, '..', 'migrations');

  /**
   * Every `CREATE EXTENSION` in the live migration chain. Single-level, like the runtime glob:
   * `_historical/` holds the superseded files and nothing executes them.
   */
  const created = (() => {
    const found = new Map<string, string>();
    for (const file of readdirSync(MIGRATIONS)) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(join(MIGRATIONS, file), 'utf8')
        // Comments describe extensions at length; only statements count.
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
      for (const m of text.matchAll(/CREATE EXTENSION(?:\s+IF NOT EXISTS)?\s+"?([a-zA-Z0-9_-]+)"?/g)) {
        if (!found.has(m[1])) found.set(m[1], file);
      }
    }
    return found;
  })();

  /**
   * Needs `shared_preload_libraries=pg_stat_statements` on the server, which is a compose setting,
   * not something a provisioning step can arrange. Migration 1790700000000 creates it behind a
   * guard for that reason and tolerates its absence.
   */
  const PROVIDED_ELSEWHERE = new Set(['pg_stat_statements']);

  it('finds the CREATE EXTENSION statements at all, so a broken scan cannot pass as clean', () => {
    expect(created.size).toBeGreaterThanOrEqual(4);
    expect([...created.keys()]).toEqual(expect.arrayContaining(['postgis', 'pg_trgm', 'btree_gist']));
  });

  it('installs every extension the migrations create', () => {
    const missing = [...created.entries()]
      .filter(([name]) => !PROVIDED_ELSEWHERE.has(name) && !REQUIRED_EXTENSIONS.includes(name))
      .map(([name, file]) => `${name} (created by ${file})`);
    // Add it to REQUIRED_EXTENSIONS in provision.ts. A trusted extension will appear to work
    // without this, on any database the migration role happens to own — and fail on the ones it
    // does not, which is every deployment where the database was created for it.
    expect({ notInstalledByProvisioning: missing }).toEqual({ notInstalledByProvisioning: [] });
  });

  it('keeps no extension in the list that no migration asks for', () => {
    // The other direction, so the list stays a truthful account rather than accumulating names.
    const stale = REQUIRED_EXTENSIONS.filter((name) => !created.has(name));
    expect({ installedButUnused: stale }).toEqual({ installedButUnused: [] });
  });
});
