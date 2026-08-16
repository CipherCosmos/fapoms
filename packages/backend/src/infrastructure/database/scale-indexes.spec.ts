import * as fs from 'fs';
import * as path from 'path';

/**
 * The scale indexes must exist in the ACTIVE migration chain and on the entities.
 *
 * ## Why this test exists
 *
 * In August 2026 the migration chain was regenerated from the entity classes into one baseline.
 * Every index that lived only as raw SQL in a migration moved to `_historical/`, which the loader
 * does not read, and quietly stopped being applied. Nothing failed — an index is invisible to
 * correctness — so the live database ran with sequential scans on the operations list, the inbox,
 * the dashboard tiles, the SLA sweeps and the recommendation geo prefilter until an audit checked
 * `pg_indexes` on the server and found zero of them.
 *
 * Two things stop that recurring. Each btree is now declared as an `@Index` on its entity, so an
 * entity-generated baseline carries it. And this test asserts that (a) an active, non-historical
 * migration creates every index by name, and (b) the entities declare the ones they can. If a
 * future consolidation drops the migration, or someone "tidies" a decorator, this goes red.
 *
 * The functional GiST on `assayers (location::geography)` cannot be declared on an entity —
 * TypeORM has no expression indexes — so it is asserted only in the migration set.
 */

const DB_DIR = __dirname;
const SRC = path.resolve(__dirname, '../..');
const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');

/** Every index the restore migration must create, by its exact name. */
const REQUIRED_MIGRATION_INDEXES = [
  'idx_assignments_active_status_created',
  'idx_assignments_open_offers',
  'idx_assignments_assayer_day',
  'idx_assignments_branch_recent',
  'idx_assignments_sla_status_status_active',
  'idx_assayers_location_geography',
  'IDX_project_branches_scheduled_date_active',
  'IDX_notifications_assayer_created',
  'IDX_notifications_group_key',
  'IDX_audit_events_event_type_occurred',
  'IDX_refresh_tokens_token_hash',
  'IDX_billing_entries_invoice_id',
  'IDX_documents_type_status_received',
  'IDX_documents_assigned_to_user',
  'IDX_workflow_history_entity_timestamp',
  'IDX_billing_history_entity_created',
  'IDX_client_configurations_client_effective',
  'IDX_clients_organization',
  'IDX_clients_lifecycle_status',
];

/** The same set minus the functional index, mapped to the entity file that must declare it. */
const REQUIRED_ENTITY_DECLARATIONS: Record<string, string[]> = {
  'modules/assignment/assignment.entity.ts': [
    'idx_assignments_active_status_created',
    'idx_assignments_open_offers',
    'idx_assignments_assayer_day',
    'idx_assignments_branch_recent',
    'idx_assignments_sla_status_status_active',
  ],
  'modules/project/project-branch.entity.ts': ['IDX_project_branches_scheduled_date_active'],
  'modules/notifications/notification.entity.ts': ['IDX_notifications_assayer_created', 'IDX_notifications_group_key'],
  'core/audit/audit-event.entity.ts': ['IDX_audit_events_event_type_occurred'],
  'modules/auth/refresh-token.entity.ts': ['IDX_refresh_tokens_token_hash'],
  'modules/billing-engine/billing-entry.entity.ts': ['IDX_billing_entries_invoice_id'],
  'modules/document/document.entity.ts': ['IDX_documents_type_status_received', 'IDX_documents_assigned_to_user'],
  'modules/platform/workflow/workflow-history.entity.ts': ['IDX_workflow_history_entity_timestamp'],
  'modules/billing-engine/history.entity.ts': ['IDX_billing_history_entity_created'],
  'modules/client/client-configuration.entity.ts': ['IDX_client_configurations_client_effective'],
  'modules/client/client.entity.ts': ['IDX_clients_organization', 'IDX_clients_lifecycle_status'],
};

function activeMigrationSources(): string {
  // Single level only — mirrors the loader glob in database.config.ts. `_historical/` is exactly
  // the place these indexes were lost, so it must NOT count.
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

describe('scale indexes survive migration-chain changes', () => {
  const migrations = activeMigrationSources();

  it.each(REQUIRED_MIGRATION_INDEXES)('an active migration creates %s', (name) => {
    const createsIt = new RegExp(`CREATE\\s+(UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+"${name}"`, 'i');
    expect(migrations).toMatch(createsIt);
  });

  it('the functional geography index is created on the geography cast, which the entity cannot declare', () => {
    expect(migrations).toMatch(/"idx_assayers_location_geography"\s+ON\s+"assayers"\s+USING\s+gist\s+\(\("location"::geography\)\)/i);
  });

  describe.each(Object.entries(REQUIRED_ENTITY_DECLARATIONS))('%s declares', (file, names) => {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    it.each(names)('@Index %s', (name) => {
      expect(source).toMatch(new RegExp(`@Index\\('${name}'`));
    });
  });
});
