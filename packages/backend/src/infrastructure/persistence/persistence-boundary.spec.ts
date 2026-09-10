import * as fs from 'fs';
import * as path from 'path';

/**
 * Keeps the persistence boundary from eroding, and records exactly how far it has eroded.
 *
 * ## Why this is a test and not an ESLint rule
 *
 * The intended enforcement was a lint rule, but ESLint is not installed anywhere in this
 * monorepo — there is no config file at any level and no eslint package in the root or any
 * workspace, so `npm run lint` fails on a missing binary. A rule added there would enforce
 * nothing until someone installs and configures a toolchain, which is a larger decision than
 * this. A test runs today, in the suite that already runs, with no new dependency.
 *
 * ## Why it allowlists instead of failing outright
 *
 * 44 services import TypeORM directly. Failing on all of them would mean either a red suite or
 * a rewrite of 44 files in one change. The allowlist freezes that set: existing violations stay
 * green, a new one fails. It is a ratchet, not a clean bill of health.
 *
 * The check runs in both directions on purpose. Removing a file's TypeORM import without
 * removing its allowlist entry also fails — otherwise the list would silently accumulate names
 * of files that were fixed years ago and stop being a truthful account of what is left.
 */

const SRC = path.resolve(__dirname, '../..');

/**
 * Services that still reach for TypeORM directly. Every entry is a service that knows how its
 * data is stored. Shrink this list; never add to it.
 */
const IMPORTS_TYPEORM = [
  // Samples the connection pool's own counters for /metrics. It reads no table at all — the
  // DataSource is how you reach the pool object, and routing a diagnostic through a repository
  // would put it inside the layer it exists to observe.
  'infrastructure/observability/runtime-metrics.service.ts',
  // Batched retention deletes. Expressed as bounded raw DELETEs because the point is to bound
  // how long each statement holds locks on append-only tables, which the repository API cannot
  // express; it owns no domain concept and reads no entity.
  'infrastructure/retention/retention.service.ts',
  // The operator-invoked data reset. It clears whole tables named by the wipe registry, in an
  // order derived from the live foreign-key graph — a statement about *tables*, not entities, and
  // one no repository can express: routing it through the ~40 repositories whose tables it
  // touches would still not say "empty these, children first". Reads no entity and owns no
  // aggregate.
  'infrastructure/data-reset/data-reset.service.ts',
  // Reads foreign-key constraints out of information_schema. There is no entity to go through —
  // the subject is the schema itself, which is precisely why it is queried live rather than
  // transcribed into a list that would drift from it.
  'infrastructure/data-reset/fk-graph.service.ts',
  // The destructive-action approval trail, in the wipe module's own raw-DataSource style. Its
  // consume step must run on the WIPE's transaction manager (a wipe that cannot burn its
  // approval must not delete anything), and its rows must survive the users domain being
  // wiped — both are table-level concerns a repository port cannot express.
  'infrastructure/data-reset/destructive-approval.service.ts',
  'core/audit/audit-seal.service.ts',
  'core/audit/unified-audit.service.ts',
  // The region ceiling on detail routes. Read-only, and single-column region lookups by id
  // across five tables (branch, project_branch, assignment, assayer, schedule) — it exists
  // precisely because those aggregates have different paths to a region, so routing it through
  // five repositories would mean five injections to answer one question. No writes.
  'infrastructure/scope/region-guard.service.ts',
  // Coordinate precision. It reads and rewrites only the geo columns of branches and assayers,
  // and it exists in the geo module rather than in both feature modules because the rule it
  // enforces — a hand-placed pin is never overwritten — must have exactly one implementation.
  'modules/geo/geo-precision.service.ts',
  // The administrator rule-bypass window. It owns exactly one table, which exists only to
  // record when the platform's controls were suspended and what that window was used for —
  // there is no domain aggregate for it to sit behind, and routing an audit record through
  // another service is how such records end up incomplete.
  'modules/platform/rule-bypass/rule-bypass.service.ts',
  // The assayer movement trail. It owns one append-only table of raw GPS fixes and nothing else:
  // the evidence a travel claim is checked against. It stays a persistence-owning service on
  // purpose — what the fixes *mean* is decided by the pure functions in travel-track.ts, so the
  // judgement can be tested and re-run over history without a database, and this service is only
  // the narrow read/write boundary underneath it.
  'modules/assayer/location-trail.service.ts',
  // The boot-time self-check. Two read-only SELECTs against `roles` and `user_roles`, asking a
  // question no domain aggregate owns: does this *deployment* have the rows it needs to work.
  // Routing it through repositories would put a diagnostic inside the very layer it is checking,
  // and it must be able to report on a database whose domain services cannot start.
  'infrastructure/observability/startup-checks.service.ts',
  'infrastructure/ocr/ocr-processing.service.ts',
  // Read-only socket-room entitlement lookups (entity → branch region, users.regions);
  // three single-row queries, no writes, no transactions.
  'infrastructure/scope/region-guard.service.ts',
  'modules/assayer/assayer.service.ts',
  'modules/assayer/hr-workforce.service.ts',
  // The roster's repeating records — references, client standing, vetting, joining paperwork.
  // A plain repository service: it injects five repositories and needs `Repository` for their
  // types and `IsNull` for "still open". Its sibling `roster-import.service.ts` is deliberately
  // absent from both lists — that one takes `UnitOfWork` and reaches every table through the
  // transaction manager, which is the shape this list is asking for.
  'modules/assayer/roster-records.service.ts',
  // The roster's filtered/paginated query path, built with `createQueryBuilder` directly over
  // `AssayerEntity` so a filter maps to one WHERE clause across the whole table instead of a
  // client-side filter over one loaded page. Read-only, no transactions; kept separate from
  // `assayer.service.ts` so the two can change independently.
  'modules/assayer/roster-query.service.ts',
  // Qualification scoring: compute-on-read over the five vetting tables the roster edits.
  // Reads dominate; the only writes are the override rows (audited via recordActivity).
  'modules/assayer/qualification-score.service.ts',
  // The standing data-integrity scan. A plain repository service like its roster siblings —
  // and it MUST read through repositories rather than SQL: the duplicate checks compare
  // pan/aadhaar/bank values that the `encryptedColumn` transformer stores under a random IV,
  // so only the decrypting repository read can see two records agree once the key is set.
  'modules/assayer/data-integrity.service.ts',
  'modules/assignment/assignment.service.ts',
  // Read-only operational-invariant scanner (Phase 2 integrity audit); queries only, no writes,
  // no transactions. Holds a DataSource for the same reason operations-inbox does — it runs
  // aggregate queries across multiple tables that no single repository owns.
  'modules/assignment/operational-integrity.service.ts',
  // Read-only cross-aggregate queue aggregator (Operations Inbox); queries only, no writes.
  'modules/assignment/operations-inbox.service.ts',
  // LiveKit voice-call lifecycle (parallel feature work); writes call outcomes into query threads.
  'modules/calls/calls.service.ts',
  'modules/auth/auth.service.ts',
  // The session/refresh-token store behind login and the sessions & devices screen.
  // Repository-only: `Repository` for its two injected repositories' types, `IsNull` for "not
  // yet revoked". No DataSource, no transactions.
  'modules/auth/session.service.ts',
  'modules/billing-engine/billing-engine.service.ts',
  // Assayer invoicing (the invite → reveal → submit → approve consent flow over payables).
  // Sits beside billing-engine.service.ts and uses the same repository + transaction style —
  // its writes join the engine's own tx paths (approvePayableInTx), so raw TypeORM here is
  // the same deliberate choice the engine itself is on this list for.
  'modules/billing-engine/assayer-invoice.service.ts',
  'modules/branch/branch-query.service.ts',
  'modules/branch/branch.service.ts',
  'modules/client/client.service.ts',
  'modules/customer-master/customer-master.service.ts',
  // Read-only SLA breach detector for the data-entry desk; aggregate queries only, no writes.
  'modules/validation/desk-escalation.service.ts',
  // Feedback & collaboration channel: repository-only access (Repository/InjectRepository), no DataSource.
  'modules/feedback/feedback.service.ts',
  'modules/feedback/feedback-thread.service.ts',
  // Read-only SLA breach detector for the feedback desk; aggregate queries only, no writes.
  'modules/feedback/feedback-escalation.service.ts',
  // Staff remarks about assayers. Repository-only (Repository, In/IsNull/MoreThanOrEqual find
  // operators), no DataSource, no transactions; it owns the one table and is the single read
  // path the recommendation engine scores from (`loadScoringWindow`, one query per pool).
  'modules/assayer-remarks/assayer-remarks.service.ts',
  'modules/document/document.service.ts',
  'modules/expense/expense.service.ts',
  'modules/geo/geo-seed.service.ts',
  'modules/holiday/holiday.service.ts',
  'modules/notifications/notification-dispatch.service.ts',
  // The notification override table. One config table it alone owns — the operator's
  // deliberate departures from the code catalog; repository reads/writes only, no transactions.
  'modules/notifications/notification-settings.service.ts',
  'modules/notifications/notification.service.ts',
  'modules/notifications/push-notification.service.ts',
  'modules/organization/organization.service.ts',
  'modules/planning/command-center.service.ts',
  'modules/planning/day-planner.service.ts',
  'modules/planning/operations-planning.service.ts',
  'modules/planning/planning-orchestrator.service.ts',
  'modules/planning/planning.service.ts',
  'modules/planning/scenario-planning.service.ts',
  'modules/pricing/fee-policy.service.ts',
  // The transport rate card. One config table it alone owns, plus its scope-resolution reads —
  // the same shape as fee-policy above; both are the pricing module's narrow storage edge.
  'modules/pricing/transport-rate.service.ts',
  // The morning digest's read-only aggregates — same entry as in the DataSource list below.
  'infrastructure/scheduler/email-digest.service.ts',
  // Operator-owned platform configuration. One key/value table it alone owns; repository
  // reads and writes, no transactions.
  'infrastructure/settings/platform-settings.service.ts',
  'modules/project/call-log.service.ts',
  'modules/project/project-query.service.ts',
  'modules/project/project.service.ts',
  // Read-only cross-aggregate Excel report aggregator; queries only, no writes.
  'modules/reports/reports.service.ts',
  'modules/scheduling/scheduling.service.ts',
  'modules/search/search.service.ts',
  'modules/user/operations-snapshot.service.ts',
  'modules/user/user.service.ts',
  'modules/validation-query/query-thread.service.ts',
  'modules/validation-query/validation-query.service.ts',
  'modules/validation/validation.service.ts',
  'modules/zone/zone.service.ts',
  // The second-factor store behind MFA login (user_mfa + hashed recovery codes). Repository-only
  // access via @InjectRepository; no DataSource, no transactions. The TOTP secret rides the
  // field-encryption transformer, so the decrypting repository read is the only way to see it.
  'modules/auth/mfa.service.ts',
  // Compliance: the DPDP data-rights request log and the security-incident register. Each owns its
  // one table and reaches it through @InjectRepository only -- config/record tables with no
  // domain aggregate to sit behind.
  'modules/compliance/data-rights-request.service.ts',
  'modules/compliance/security-incident.service.ts',
  // Append-only activity telemetry. One table it alone owns; repository writes/reads, no transactions.
  'modules/telemetry/telemetry.service.ts',
];

/**
 * Services that still open their own transactions.
 *
 * This is the sharper of the two lists. A service holding a `DataSource` chooses its own
 * isolation level and decides for itself when domain events become visible — the two things
 * `UnitOfWork` exists to take away. Of the services here, the ones that publish events do so
 * from inside the transaction, so a subscriber sees state that can still roll back.
 */
const OPENS_ITS_OWN_TRANSACTIONS = [
  // Holds a DataSource to read pool counters for /metrics; issues no query and opens nothing.
  'infrastructure/observability/runtime-metrics.service.ts',
  // Batched deletes, each its own short statement. Deliberately NOT one transaction: the whole
  // design is that a purge never holds locks on an append-only table for long.
  'infrastructure/retention/retention.service.ts',
  // The opposite choice to retention above, for the opposite reason: a wipe spans many tables and
  // must be all-or-nothing, so it holds one transaction on purpose. Its audit row is written
  // inside that transaction unguarded — a reset that cannot be recorded must not commit — which
  // is exactly the coupling `UnitOfWork` could not express here.
  'infrastructure/data-reset/data-reset.service.ts',
  // Holds a DataSource to read information_schema; opens no transaction.
  'infrastructure/data-reset/fk-graph.service.ts',
  // Holds a DataSource for the approval-trail rows; the one transaction it participates in is
  // the wipe's own (its consume step runs on that manager so approval-burn and deletion are
  // atomic) — it opens none of its own.
  'infrastructure/data-reset/destructive-approval.service.ts',
  // Takes a DataSource for read-only region lookups only; opens no transaction.
  'infrastructure/scope/region-guard.service.ts',
  // Read-only morning-digest aggregates (pending payables/expenses/overdue invoices) and the
  // role-holder audience query; queries only, no writes, no transactions.
  'infrastructure/scheduler/email-digest.service.ts',
  // Boot-time self-check: two read-only SELECTs, no writes, no transaction.
  'infrastructure/observability/startup-checks.service.ts',
  'core/audit/audit-seal.service.ts',
  'core/audit/unified-audit.service.ts',
  // Holds a DataSource but never opens a transaction: read-only room entitlement lookups.
  'infrastructure/scope/region-guard.service.ts',
  'modules/assayer/hr-workforce.service.ts',
  'modules/assignment/assignment.service.ts',
  // Read-only operational-invariant scanner; holds a DataSource for aggregate queries, opens
  // no transaction.
  'modules/assignment/operational-integrity.service.ts',
  // Read-only cross-aggregate queue aggregator (Operations Inbox); queries only, no writes.
  'modules/assignment/operations-inbox.service.ts',
  'modules/customer-master/customer-master.service.ts',
  'modules/planning/command-center.service.ts',
  'modules/user/operations-snapshot.service.ts',
  'modules/project/project.service.ts',
  'modules/client/client.service.ts',
  'modules/branch/branch.service.ts',
  'modules/zone/zone.service.ts',
  'modules/assayer/assayer.service.ts',
];

/**
 * The one directory the boundary does not apply to, because it IS the boundary.
 *
 * Everything under `infrastructure/persistence/` is the TypeORM implementation the rest of the
 * codebase is being kept away from: `typeorm-unit-of-work.ts` wraps a `DataSource`,
 * `outbox.relay.ts` and `outbox.worker.ts` read and write `outbox_events` through repositories,
 * and `outbox.entity.ts` declares the table. Asking those files not to import TypeORM would be
 * asking them not to exist.
 *
 * They were invisible to this walker only because none of them happened to be named
 * `*.service.ts`. `outbox-dead-letter.service.ts` — the operator surface over the same table,
 * beside the relay that writes it — was the first that did, and it failed a rule that was never
 * about it. Naming the directory says so once, instead of adding a name to a list whose header
 * reads "never add to it" and leaving the next file in this directory to argue the same case.
 *
 * The exemption is a directory prefix and nothing wider, so it cannot be reached by a domain
 * service: moving one here to dodge the check would put a module's aggregate inside the
 * persistence layer, which is a change no review would pass and this file's own test below
 * would report as a stale allowlist entry.
 */
const PERSISTENCE_LAYER = 'infrastructure/persistence/';

const serviceFiles = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.service.ts') && !entry.name.endsWith('.spec.ts')) {
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        if (!rel.startsWith(PERSISTENCE_LAYER)) found.push(rel);
      }
    }
  };
  walk(SRC);
  return found.sort();
};

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Matches `from 'typeorm'` in an import, including `import type`. */
const IMPORTS_TYPEORM_PATTERN = /^\s*import\s[\s\S]*?from\s+['"]typeorm['"]/m;

/** `DataSource` as an identifier, so `dataSourceOptions` in a comment does not count. */
const USES_DATA_SOURCE_PATTERN = /\bDataSource\b/;

describe('persistence boundary', () => {
  const files = serviceFiles();

  it('finds the services to check', () => {
    // Guards the walker itself: a broken path would make every check below pass vacuously.
    expect(files.length).toBeGreaterThan(40);
  });

  it('exempts the persistence layer itself, and nothing outside it', () => {
    // The exemption has to be proven against a file that would otherwise fail, or widening it
    // later to `infrastructure/` — or to everything — would go unnoticed. This one imports
    // `Repository` and three query operators from typeorm and is not on the allowlist, so it
    // fails the check below the moment the prefix stops matching it.
    const deadLetter = 'infrastructure/persistence/outbox-dead-letter.service.ts';
    expect(fs.existsSync(path.join(SRC, deadLetter))).toBe(true);
    expect(IMPORTS_TYPEORM_PATTERN.test(read(deadLetter))).toBe(true);
    expect(IMPORTS_TYPEORM.includes(deadLetter)).toBe(false);
    expect(files).not.toContain(deadLetter);

    // And the exemption is that directory only: every other service is still walked, including
    // the ones in sibling infrastructure directories that the allowlist accounts for by name.
    expect(files.filter((f) => f.startsWith(PERSISTENCE_LAYER))).toEqual([]);
    expect(files).toContain('infrastructure/retention/retention.service.ts');
    expect(files).toContain('modules/assayer/assayer.service.ts');
  });

  describe('direct TypeORM imports', () => {
    const actual = files.filter((f) => IMPORTS_TYPEORM_PATTERN.test(read(f)));

    it('has no service importing TypeORM that is not already known to', () => {
      const added = actual.filter((f) => !IMPORTS_TYPEORM.includes(f));
      expect({ newViolations: added }).toEqual({ newViolations: [] });
    });

    it('has no stale entries left in the allowlist', () => {
      const fixed = IMPORTS_TYPEORM.filter((f) => !actual.includes(f));
      // Delete these lines from IMPORTS_TYPEORM — the boundary moved and the list should say so.
      expect({ fixedButStillListed: fixed }).toEqual({ fixedButStillListed: [] });
    });
  });

  describe('services opening their own transactions', () => {
    const actual = files.filter((f) => USES_DATA_SOURCE_PATTERN.test(read(f)));

    it('has no service taking a DataSource that is not already known to', () => {
      // Use `UnitOfWork` instead: it fixes the isolation level at READ COMMITTED and releases
      // domain events only after COMMIT.
      const added = actual.filter((f) => !OPENS_ITS_OWN_TRANSACTIONS.includes(f));
      expect({ newViolations: added }).toEqual({ newViolations: [] });
    });

    it('has no stale entries left in the allowlist', () => {
      const fixed = OPENS_ITS_OWN_TRANSACTIONS.filter((f) => !actual.includes(f));
      expect({ fixedButStillListed: fixed }).toEqual({ fixedButStillListed: [] });
    });
  });

  describe('the audit trail', () => {
    it('is reached only through its repository port', () => {
      // `AuditService` is the append-only trail. It went through `Repository<AuditEventEntity>`,
      // which offers delete/update/remove/clear — every one of which breaks the immutability
      // the module documents. `AuditRepository` cannot express them.
      expect(IMPORTS_TYPEORM_PATTERN.test(read('core/audit/audit.service.ts'))).toBe(false);
    });

    it('has exactly two files that know the trail is a TypeORM table', () => {
      const auditFiles = files.filter((f) => f.startsWith('core/audit/'));
      const reaching = auditFiles.filter((f) => IMPORTS_TYPEORM_PATTERN.test(read(f)));

      // `unified-audit.service.ts` merges four history tables with raw SQL across schemas no
      // single repository owns. `audit-seal.service.ts` computes each `audit_chain` row's hash
      // from the previous row's hash and must insert a whole batch under one Postgres advisory
      // lock (`pg_advisory_xact_lock`, scoped to the transaction that holds it) — `AuditRepository`
      // exposes insert/find on the events table alone, with neither the chain table nor a lock
      // primitive. Both are deliberately outside the repository port, not candidates to route
      // through it.
      expect(reaching).toEqual([
        'core/audit/audit-seal.service.ts',
        'core/audit/unified-audit.service.ts',
      ]);
    });
  });
});
