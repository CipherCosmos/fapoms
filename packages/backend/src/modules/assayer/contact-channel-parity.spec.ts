import * as fs from 'fs';
import * as path from 'path';

/**
 * The contact channels are written down twice, and the two copies must agree.
 *
 * `CONTACT_CHANNELS` in `assayer.controller.ts` gates the HTTP path through `@IsIn`. The CHECK
 * constraint in migration `1794300000000-ContactChannelCheck` gates everything else — imports,
 * scripts, backfills, repository calls that never touch a DTO. SQL cannot import the TypeScript
 * list, so the duplication is unavoidable; what is avoidable is the two drifting.
 *
 * Drift here fails in the least helpful direction available. Add a fourth channel to the DTO
 * alone and the API accepts it, then Postgres rejects the write with a constraint violation —
 * a 500 on a value the validation layer just approved. Add it to the constraint alone and the
 * column can hold a value no code branch handles, so the assayer is never contacted by any route
 * and nothing anywhere reports a problem.
 *
 * Both files are read as text rather than imported: the migration's constraint lives inside a SQL
 * string, so there is nothing to import, and reading the controller the same way keeps the
 * comparison symmetrical.
 */
describe('the contact channels agree between the DTO and the database', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8');

  const CONTROLLER = 'assayer.controller.ts';
  const MIGRATION = '../../infrastructure/database/migrations/1794300000000-ContactChannelCheck.ts';

  /** The `as const` array the DTOs validate against. */
  const channelsFromController = (): string[] => {
    const source = read(CONTROLLER);
    const declaration = /const CONTACT_CHANNELS = \[([^\]]*)\]/.exec(source);
    if (!declaration) throw new Error('CONTACT_CHANNELS is no longer declared as an array literal in assayer.controller.ts');
    return [...declaration[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  /** The values inside the CHECK constraint's IN list. */
  const channelsFromMigration = (): string[] => {
    const source = read(MIGRATION);
    // Anchored on the column name so a second IN list elsewhere in the file could not be read
    // by mistake — a regex that simply found the first `IN (` would be exactly the kind of
    // wrong-region match this suite exists to catch.
    const check = /"preferred_contact_channel" IN \(([^)]*)\)/.exec(source);
    if (!check) throw new Error('The CHECK constraint on preferred_contact_channel is no longer in migration 1794300000000');
    return [...check[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  it('names the same channels in both places', () => {
    expect([...channelsFromMigration()].sort()).toEqual([...channelsFromController()].sort());
  });

  it('still names the three the code actually branches on', () => {
    // A guard against both copies being edited together into something no code handles: these
    // three are what `AUTO`'s resolution and the notification/call-task split are written for.
    expect([...channelsFromController()].sort()).toEqual(['APP', 'AUTO', 'PHONE']);
  });
});
