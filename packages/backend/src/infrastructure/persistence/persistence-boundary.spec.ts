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
  'core/audit/unified-audit.service.ts',
  'infrastructure/ocr/ocr-processing.service.ts',
  'modules/assayer/assayer.service.ts',
  'modules/assayer/hr-workforce.service.ts',
  'modules/assignment/assignment.service.ts',
  // Read-only cross-aggregate queue aggregator (Operations Inbox); queries only, no writes.
  'modules/assignment/operations-inbox.service.ts',
  // LiveKit voice-call lifecycle (parallel feature work); writes call outcomes into query threads.
  'modules/calls/calls.service.ts',
  'modules/auth/auth.service.ts',
  'modules/billing-engine/billing-engine.service.ts',
  'modules/branch/branch-query.service.ts',
  'modules/branch/branch.service.ts',
  'modules/client/client.service.ts',
  'modules/communication/communication.service.ts',
  'modules/customer-master/customer-master.service.ts',
  'modules/document/document.service.ts',
  'modules/expense/expense.service.ts',
  'modules/geo/geo-seed.service.ts',
  'modules/holiday/holiday.service.ts',
  'modules/notifications/notification-dispatch.service.ts',
  'modules/notifications/notification.service.ts',
  'modules/notifications/push-notification.service.ts',
  'modules/organization/organization.service.ts',
  'modules/planning/command-center.service.ts',
  'modules/planning/day-planner.service.ts',
  'modules/planning/field-operations.service.ts',
  'modules/planning/operations-control-center.service.ts',
  'modules/planning/operations-execution.service.ts',
  'modules/planning/operations-planning.service.ts',
  'modules/planning/planning-orchestrator.service.ts',
  'modules/planning/planning.service.ts',
  'modules/planning/scenario-planning.service.ts',
  'modules/platform/audit/platform-audit.service.ts',
  'modules/pricing/fee-policy.service.ts',
  'modules/project/call-log.service.ts',
  'modules/project/project-query.service.ts',
  'modules/project/project.service.ts',
  'modules/scheduling/scheduling.service.ts',
  'modules/search/search.service.ts',
  'modules/user/operations-snapshot.service.ts',
  'modules/user/user.service.ts',
  'modules/validation-query/query-thread.service.ts',
  'modules/validation-query/validation-query.service.ts',
  'modules/validation/validation.service.ts',
  'modules/zone/zone.service.ts',
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
  'core/audit/unified-audit.service.ts',
  'modules/assayer/hr-workforce.service.ts',
  'modules/assignment/assignment.service.ts',
  // Read-only cross-aggregate queue aggregator (Operations Inbox); queries only, no writes.
  'modules/assignment/operations-inbox.service.ts',
  'modules/customer-master/customer-master.service.ts',
  'modules/planning/command-center.service.ts',
  'modules/user/operations-snapshot.service.ts',
];

const serviceFiles = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.service.ts') && !entry.name.endsWith('.spec.ts')) {
        found.push(path.relative(SRC, full).split(path.sep).join('/'));
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

    it('has exactly one file that knows the trail is a TypeORM table', () => {
      const auditFiles = files.filter((f) => f.startsWith('core/audit/'));
      const reaching = auditFiles.filter((f) => IMPORTS_TYPEORM_PATTERN.test(read(f)));

      // `unified-audit.service.ts` is the exception: it merges four history tables with raw
      // SQL across schemas no single repository owns. The adapter is not a `.service.ts`, so
      // it is deliberately outside this set.
      expect(reaching).toEqual(['core/audit/unified-audit.service.ts']);
    });
  });
});
