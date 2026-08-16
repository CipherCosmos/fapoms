import * as fs from 'fs';
import * as path from 'path';
import { SystemRole } from '@fapoms/shared';
import { NOTIFICATION_CATALOG } from './notification-catalog';

/**
 * Every role a notification is addressed to must be a role somebody can actually hold.
 *
 * `roles: [...]` in the catalog is the whole of the fan-out: recipients are the users holding
 * those roles. A role that exists in `SystemRole` but has no row in the `roles` table can be
 * held by nobody, so an event addressed only to it resolves to zero recipients — no bell, no
 * email, and no error, because "nobody holds this role" is indistinguishable downstream from
 * "everybody has already read it".
 *
 * That is not hypothetical. `BaselineSchema` squashed the migrations that created eight of the
 * thirteen roles, and `seed.ts` creates only five, so a database built from the squash held
 * five. `DESK_SUBMIT_OVERDUE` — addressed to DATA_ENTRY_HEAD and VALIDATION_MANAGER, neither of
 * which existed — could not notify anyone, and an approved audit report sitting unsent past its
 * SLA went unannounced. `RestoreWorkflowRoles` put the rows back; this test is what stops the
 * next squash losing them again.
 *
 * The role rows are created in two places, so both are read here rather than trusting either:
 * `seed.ts` for the original five, and the restore migration for the rest. Parsing the real
 * sources — as `catalog-link-reachability.spec.ts` does with the frontend's route table — means
 * the test cannot be satisfied by a snapshot that has drifted from what actually runs.
 */

const SEED_FILE = path.resolve(__dirname, '../../infrastructure/database/seed.ts');
const RESTORE_MIGRATION = path.resolve(
  __dirname,
  '../../infrastructure/database/migrations/1790200000000-RestoreWorkflowRoles.ts',
);

/**
 * Assayers authenticate against the `assayers` table, not `users`, and so deliberately have no
 * row in `roles` — the original migration called this out explicitly. Notifications reach them
 * through `assayerId`, never through role fan-out.
 */
const NOT_A_USER_ROLE: string[] = [SystemRole.ASSAYER];

/** Every role name the running system creates a row for. */
function creatableRoles(): Set<string> {
  const names = new Set<string>();

  // seed.ts writes `name: SystemRole.X` inside its roleDefinitions list.
  const seed = fs.readFileSync(SEED_FILE, 'utf8');
  for (const m of seed.matchAll(/name:\s*SystemRole\.([A-Z_]+)/g)) names.add(m[1]);

  // The migration writes plain string literals, since migrations must not import app enums.
  const migration = fs.readFileSync(RESTORE_MIGRATION, 'utf8');
  for (const m of migration.matchAll(/name:\s*'([A-Z_]+)'/g)) names.add(m[1]);

  return names;
}

describe('every notification reaches a role somebody can hold', () => {
  const creatable = creatableRoles();

  it('creates a role row for every SystemRole a user can be given', () => {
    const missing = Object.values(SystemRole)
      .filter((r) => !NOT_A_USER_ROLE.includes(r))
      .filter((r) => !creatable.has(r));

    expect(missing).toEqual([]);
  });

  it('addresses no notification to a role that cannot be staffed', () => {
    const unstaffable: Array<{ type: string; role: string }> = [];

    for (const [type, entry] of Object.entries(NOTIFICATION_CATALOG)) {
      for (const role of entry.roles ?? []) {
        if (!creatable.has(role)) unstaffable.push({ type, role });
      }
    }

    expect(unstaffable).toEqual([]);
  });

  it('gives every role-addressed notification at least one holdable role', () => {
    // A weaker but sharper check than the one above: an entry could name three roles, two of
    // them dead, and still reach people. An entry whose every role is dead reaches nobody.
    const unreachable = Object.entries(NOTIFICATION_CATALOG)
      .filter(([, entry]) => (entry.roles?.length ?? 0) > 0)
      .filter(([, entry]) => !entry.roles!.some((r) => creatable.has(r)))
      .map(([type]) => type);

    expect(unreachable).toEqual([]);
  });
});
