import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RetentionService, rowsAffected } from './retention.service';
import { CacheService } from '../cache/cache.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { AuthService } from '../../modules/auth/auth.service';

/**
 * This service is the only thing in FAPOMS that deletes anything, so the tests that matter are
 * not "does it delete" — they are the ones that stop it deleting the wrong thing, holding a long
 * transaction, or running unbounded.
 */
describe('RetentionService', () => {
  let service: RetentionService;

  /** Every statement issued, in order, so the tests can assert what was deleted and how. */
  let statements: Array<{ sql: string; params: unknown[] }>;
  /** Rows the next N delete statements should claim to have removed, consumed in order. */
  let deleteResults: number[];

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      statements.push({ sql, params });
      const n = deleteResults.length > 0 ? deleteResults.shift()! : 0;
      // How node-postgres reports a DELETE through TypeORM's raw `query`.
      return [[], n];
    }),
  };

  // Runs the body — the real one fails open too, so a test that skipped the body would be
  // testing a behaviour the production path does not have.
  const cache = { withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<any>) => fn()) };

  const settings = { get: jest.fn().mockResolvedValue(null) };
  const auth = { pruneRefreshTokens: jest.fn().mockResolvedValue(0) };

  const RETENTION_ENV = [
    'RETENTION_OUTBOX_DAYS',
    'RETENTION_REFRESH_TOKEN_GRACE_DAYS',
    'RETENTION_READ_NOTIFICATION_DAYS',
    'LOCATION_TRAIL_RETENTION_DAYS',
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    statements = [];
    deleteResults = [];
    jest.clearAllMocks();
    settings.get.mockResolvedValue(null);
    auth.pruneRefreshTokens.mockResolvedValue(0);

    // The service reads process.env directly; a stray value in the developer's shell must not
    // decide what these tests assert.
    savedEnv = Object.fromEntries(RETENTION_ENV.map((k) => [k, process.env[k]]));
    for (const k of RETENTION_ENV) delete process.env[k];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetentionService,
        { provide: getDataSourceToken(), useValue: dataSource as unknown as DataSource },
        { provide: CacheService, useValue: cache },
        { provide: PlatformSettingsService, useValue: settings },
        { provide: AuthService, useValue: auth },
      ],
    }).compile();
    service = module.get(RetentionService);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const sqlFor = (table: string) => statements.filter((s) => s.sql.includes(`DELETE FROM ${table}`));

  // -------------------------------------------------------------------------------------------
  // What it will and will not delete
  // -------------------------------------------------------------------------------------------

  describe('what it is allowed to touch', () => {
    it('never issues a delete against the compliance or operational record', async () => {
      await service.runOnce();
      const everything = statements.map((s) => s.sql).join('\n');
      // audit_events is the compliance record: its growth is a write-amplification problem
      // (fixed in rule-bypass.service.ts), never a deletion problem.
      for (const table of [
        'audit_events',
        'assignments',
        'workflow_history',
        'billing_history',
        'documents',
        'invoices',
        'assayers',
        'users',
      ]) {
        expect(everything).not.toContain(`DELETE FROM ${table}`);
      }
    });

    it('can only ever remove an outbox event that was dispatched', async () => {
      await service.runOnce();
      const [stmt] = sqlFor('outbox_events');
      // NULL fails every comparison, so an undispatched row cannot match this predicate even
      // if the window were misconfigured to zero. Deleting one would silently discard work.
      expect(stmt.sql).toMatch(/dispatched_at < \$1/);
      expect(stmt.sql).not.toMatch(/IS NULL/);
    });

    it('can only ever remove a notification that has been read', async () => {
      await service.runOnce();
      const [stmt] = sqlFor('notifications');
      // An unread notification is outstanding work, at any age.
      expect(stmt.sql).toMatch(/is_read = true/);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Bounded work
  // -------------------------------------------------------------------------------------------

  describe('bounded work', () => {
    it('deletes in batches rather than in one statement', async () => {
      await service.runOnce();
      for (const { sql, params } of statements) {
        // A single unbounded DELETE takes a lock and accumulates WAL for as long as it runs,
        // and on the first run after this ships the backlog is everything ever written.
        expect(sql).toMatch(/LIMIT \$\d+/);
        expect(params[params.length - 1]).toBe(5_000);
      }
    });

    it('stops issuing statements as soon as a batch comes back short', async () => {
      // 5000 then 12: the table is drained, so there must be no third statement for it.
      deleteResults = [5_000, 12];
      await service.runOnce();
      expect(sqlFor('outbox_events')).toHaveLength(2);
    });

    it('caps one tick even when every batch is full, so a backlog cannot monopolise the queue', async () => {
      deleteResults = new Array(200).fill(5_000);
      const report = await service.runOnce();
      expect(sqlFor('outbox_events')).toHaveLength(10);
      expect(report.outboxEvents).toBe(50_000);
    });

    it('runs under a cluster lock so two replicas do not purge the same rows twice', async () => {
      await service.runOnce();
      expect(cache.withLock).toHaveBeenCalledWith(
        'lock:retention:purge',
        expect.any(Number),
        expect.any(Function),
        // retries: 0 — the other replica is already doing it; queueing to do it again is waste.
        expect.objectContaining({ retries: 0 }),
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // Index-matching shape
  // -------------------------------------------------------------------------------------------

  describe('statements match the indexes that exist', () => {
    /**
     * `ORDER BY` is not cosmetic here. Measured on a 3M-row scratch clone: with the ordering and
     * `idx_location_pings_recorded_at`, selecting 5,000 rows reads 128 buffers; without the index
     * it is a 66,670-buffer sequential scan and top-N heapsort, and without the *ordering* it
     * degrades to 11,126 buffers once retention has recycled the early pages.
     */
    it.each([
      ['outbox_events', 'dispatched_at'],
      ['notifications', 'created_at'],
      ['assayer_location_pings', 'recorded_at'],
    ])('%s deletes oldest-first on its indexed column', async (table, column) => {
      await service.runOnce();
      const [stmt] = sqlFor(table);
      expect(stmt.sql).toMatch(new RegExp(`ORDER BY ${column}`));
    });
  });

  // -------------------------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------------------------

  describe('retention windows', () => {
    const cutoffOf = (table: string) => sqlFor(table)[0].params[0] as Date;
    const daysAgo = (d: Date) => Math.round((Date.now() - d.getTime()) / 86_400_000);

    it('applies the documented defaults when nothing is configured', async () => {
      await service.runOnce();
      expect(daysAgo(cutoffOf('outbox_events'))).toBe(7);
      expect(daysAgo(cutoffOf('notifications'))).toBe(180);
      expect(daysAgo(cutoffOf('assayer_location_pings'))).toBe(550);
    });

    it('honours an environment override', async () => {
      process.env.RETENTION_READ_NOTIFICATION_DAYS = '30';
      await service.runOnce();
      expect(daysAgo(cutoffOf('notifications'))).toBe(30);
    });

    it('falls back rather than throwing or silently disabling on a bad value', async () => {
      // A typo must not switch retention off silently, and must not stop the worker either.
      process.env.RETENTION_READ_NOTIFICATION_DAYS = 'ninety';
      await service.runOnce();
      expect(daysAgo(cutoffOf('notifications'))).toBe(180);
    });

    it('a window of zero switches that purge off entirely', async () => {
      process.env.RETENTION_OUTBOX_DAYS = '0';
      await service.runOnce();
      expect(sqlFor('outbox_events')).toHaveLength(0);
      // …and only that one.
      expect(sqlFor('notifications').length).toBeGreaterThan(0);
    });
  });

  describe('the location trail window, which is evidence for travel claims', () => {
    it('prefers what an administrator saved on the settings screen', async () => {
      settings.get.mockResolvedValue(365);
      await expect(service.locationPingRetentionDays()).resolves.toBe(365);
      expect(settings.get).toHaveBeenCalledWith('locationTrail.retentionDays');
    });

    it('falls back to the environment before the built-in default', async () => {
      process.env.LOCATION_TRAIL_RETENTION_DAYS = '400';
      await expect(service.locationPingRetentionDays()).resolves.toBe(400);
    });

    /**
     * 550 days ≈ 18 months. `getTravelVerification` recomputes the assessment from the raw fixes
     * every time it is opened — nothing is precomputed — so the window has to outlast the period
     * in which a claim can still be questioned, which for an audit performed in early April means
     * the whole of the following financial year's close.
     */
    it('defaults to 18 months when nobody has expressed a view', async () => {
      await expect(service.locationPingRetentionDays()).resolves.toBe(550);
    });

    /**
     * The previous behaviour — keep everything, forever — must remain reachable, but only by
     * someone deliberately choosing it. "Never asked" and "we decided to keep it" are different
     * answers and should not produce the same outcome by accident.
     */
    it('keeps everything forever when explicitly set to zero', async () => {
      settings.get.mockResolvedValue(0);
      await service.runOnce();
      expect(sqlFor('assayer_location_pings')).toHaveLength(0);
    });

    it('still purges everything else if the settings store is unreachable', async () => {
      settings.get.mockRejectedValue(new Error('settings table locked'));
      const report = await service.runOnce();
      expect(report.failures).toHaveLength(0);
      expect(sqlFor('assayer_location_pings')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Fault containment
  // -------------------------------------------------------------------------------------------

  describe('fault containment', () => {
    it('runs every remaining phase when one fails, then reports the tick as failed', async () => {
      // The phase most likely to fail is the one working on the biggest table; if that aborted
      // the run, the other three would silently stop being cleaned.
      dataSource.query.mockImplementationOnce(async () => {
        throw new Error('deadlock detected');
      });
      await expect(service.runOnce()).rejects.toThrow(/1 of 4 phases failed/);
      expect(sqlFor('notifications').length).toBeGreaterThan(0);
      expect(sqlFor('assayer_location_pings').length).toBeGreaterThan(0);
      expect(auth.pruneRefreshTokens).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------------------------
  // Refresh tokens
  // -------------------------------------------------------------------------------------------

  describe('refresh tokens', () => {
    it('delegates to the module that owns the table, and loops until it drains', async () => {
      auth.pruneRefreshTokens
        .mockResolvedValueOnce(5_000)
        .mockResolvedValueOnce(5_000)
        .mockResolvedValueOnce(9);
      const report = await service.runOnce();
      expect(report.refreshTokens).toBe(10_009);
      expect(auth.pruneRefreshTokens).toHaveBeenCalledTimes(3);
      expect(auth.pruneRefreshTokens).toHaveBeenCalledWith(2, 5_000);
    });

    it('never issues its own SQL against refresh_tokens', async () => {
      // "What counts as a dead token" is an auth question; this service owns the schedule only.
      await service.runOnce();
      expect(statements.map((s) => s.sql).join('\n')).not.toContain('refresh_tokens');
    });
  });
});

/**
 * Getting this wrong does not throw — it silently reports 0, the batch loop breaks on the first
 * pass, and retention appears to run successfully while deleting one batch an hour instead of ten.
 */
describe('rowsAffected', () => {
  it('reads the count out of the tuple TypeORM returns for a raw DELETE', () => {
    expect(rowsAffected([[], 4_211])).toBe(4_211);
  });

  it('reports zero rather than guessing when the shape is unfamiliar', () => {
    expect(rowsAffected(undefined)).toBe(0);
    expect(rowsAffected([[]])).toBe(0);
    expect(rowsAffected({ affected: 5 })).toBe(0);
  });
});
