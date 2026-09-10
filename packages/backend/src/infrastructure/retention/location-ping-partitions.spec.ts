import { Logger } from '@nestjs/common';
import {
  partitionNameFor,
  partitionBoundsFor,
  upcomingPartitions,
  droppablePartitions,
  dropExpiredPartitions,
  ensureFuturePartitions,
} from './location-ping-partitions';

/**
 * Two things matter here and nothing else: the name/boundary arithmetic is exactly what the
 * migration and the partition statements agree on, and retention now retires an old partition
 * rather than deleting its rows one at a time.
 *
 * Both the create and the drop go through `fapoms_manage_location_ping_partition`, a SECURITY
 * DEFINER function, because the API connects as a role that owns nothing and may not alter the
 * schema — see `database/roles/role-model.ts`. What these tests hold is that the module asks for
 * the partition it wants and issues no DDL of its own.
 */
describe('location-ping-partitions', () => {
  describe('partition naming and boundaries', () => {
    it('names a partition by UTC year and zero-padded month', () => {
      expect(partitionNameFor(new Date('2026-03-15T10:00:00Z'))).toBe('assayer_location_pings_y2026m03');
      expect(partitionNameFor(new Date('2026-11-01T00:00:00Z'))).toBe('assayer_location_pings_y2026m11');
    });

    it('computes half-open UTC month boundaries', () => {
      const { from, to } = partitionBoundsFor(new Date('2026-03-15T10:00:00Z'));
      expect(from.toISOString()).toBe('2026-03-01T00:00:00.000Z');
      expect(to.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    });

    it('rolls December into January of the next year', () => {
      const { from, to } = partitionBoundsFor(new Date('2026-12-25T00:00:00Z'));
      expect(from.toISOString()).toBe('2026-12-01T00:00:00.000Z');
      expect(to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
      expect(partitionNameFor(new Date('2026-12-25T00:00:00Z'))).toBe('assayer_location_pings_y2026m12');
    });

    it('is stable regardless of local time zone — always computed from UTC fields', () => {
      // A date whose local calendar day would differ from its UTC one if this used local getters.
      const lateUtcNight = new Date('2026-06-30T23:30:00Z');
      expect(partitionNameFor(lateUtcNight)).toBe('assayer_location_pings_y2026m06');
    });
  });

  describe('upcomingPartitions', () => {
    it('returns the current month plus monthsAhead more, in order', () => {
      const months = upcomingPartitions(new Date('2026-09-03T00:00:00Z'), 2);
      expect(months.map((m) => m.name)).toEqual([
        'assayer_location_pings_y2026m09',
        'assayer_location_pings_y2026m10',
        'assayer_location_pings_y2026m11',
      ]);
    });

    it('defaults to two months of headroom', () => {
      const months = upcomingPartitions(new Date('2026-01-15T00:00:00Z'));
      expect(months).toHaveLength(3);
      expect(months[2].name).toBe('assayer_location_pings_y2026m03');
    });
  });

  describe('ensureFuturePartitions', () => {
    it('creates only the partitions that do not already exist, through the privileged function', async () => {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const dataSource = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          // Pretend the first month already exists; the rest do not.
          if (sql.includes('pg_class')) {
            return params?.[0] === 'assayer_location_pings_y2026m09' ? [{ exists: 1 }] : [];
          }
          return [];
        }),
      };
      const logger = new Logger('test');

      const created = await ensureFuturePartitions(dataSource as any, logger, new Date('2026-09-03T00:00:00Z'));

      expect(created).toEqual(['assayer_location_pings_y2026m10', 'assayer_location_pings_y2026m11']);

      // Through `fapoms_manage_location_ping_partition`, never as direct DDL. The API runs as
      // `fapoms_runtime`, which holds no CREATE on the schema — a runtime identity that can alter
      // schema objects can take the audit triggers away, which is the whole reason for the split.
      const createCalls = queries.filter((q) => q.sql.includes('fapoms_manage_location_ping_partition'));
      expect(createCalls).toHaveLength(2);
      expect(createCalls[0].sql).toContain("fapoms_manage_location_ping_partition('create'");
      expect(createCalls[0].params).toEqual([
        'assayer_location_pings_y2026m10',
        '2026-10-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z',
      ]);
      // And the bounds are bound as parameters, not interpolated: the function validates the name
      // it is given, and a name arriving inside the statement text would never reach that check.
      expect(createCalls[0].sql).not.toContain('2026-10-01');
    });

    it('issues no schema DDL of its own', () => {
      // The property, stated directly. A future edit that "simplifies" this back to a CREATE
      // TABLE would work on a developer's superuser database and fail on every deployment.
      const source = jest.requireActual('fs').readFileSync(
        require.resolve('./location-ping-partitions'),
        'utf8',
      ) as string;
      const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
      expect(code).not.toMatch(/\bCREATE TABLE\b/i);
      expect(code).not.toMatch(/\bDROP TABLE\b/i);
    });
  });

  describe('droppablePartitions', () => {
    /** A synthetic `pg_inherits` row, as `droppablePartitions` expects it back from the query. */
    const partitionRow = (name: string, from: string, to: string) => ({
      name,
      bound: `FOR VALUES FROM ('${from} 00:00:00+00') TO ('${to} 00:00:00+00')`,
    });

    it('returns only partitions whose entire range ends at or before the cutoff', async () => {
      const dataSource = {
        query: jest.fn().mockResolvedValue([
          partitionRow('assayer_location_pings_y2025m01', '2025-01-01', '2025-02-01'),
          partitionRow('assayer_location_pings_y2026m08', '2026-08-01', '2026-09-01'),
          partitionRow('assayer_location_pings_y2026m09', '2026-09-01', '2026-10-01'),
        ]),
      };

      // 550 days before "now" for this test is well into 2025, so only the first partition — and
      // the boundary case, the second, whose upper edge is exactly the cutoff — should drop.
      const cutoff = new Date('2026-09-01T00:00:00Z');
      const result = await droppablePartitions(dataSource as any, cutoff);

      expect(result.map((p) => p.name)).toEqual([
        'assayer_location_pings_y2025m01',
        'assayer_location_pings_y2026m08',
      ]);
    });

    it('excludes the default partition even if it were somehow returned by the query', async () => {
      const dataSource = { query: jest.fn().mockResolvedValue([]) };
      await droppablePartitions(dataSource as any, new Date());
      const [, params] = dataSource.query.mock.calls[0];
      expect(params).toEqual(['assayer_location_pings', 'assayer_location_pings_default']);
    });
  });

  describe('dropExpiredPartitions — proof retention drops partitions instead of deleting rows', () => {
    it('issues DROP TABLE for each expired partition, never DELETE', async () => {
      const statements: string[] = [];
      const dataSource = {
        query: jest.fn(async (sql: string) => {
          statements.push(sql);
          if (sql.includes('pg_inherits')) {
            return [
              {
                name: 'assayer_location_pings_y2025m01',
                bound: "FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2025-02-01 00:00:00+00')",
              },
            ];
          }
          return [];
        }),
      };
      const logger = new Logger('test');

      const { dropped, failures } = await dropExpiredPartitions(
        dataSource as any,
        logger,
        new Date('2026-09-01T00:00:00Z'),
      );

      expect(dropped).toEqual(['assayer_location_pings_y2025m01']);
      expect(failures).toEqual([]);

      // Retiring the partition, not emptying it — and through the privileged function, because
      // the runtime role owns nothing and `DROP TABLE` consults ownership before any grant.
      const dropCalls = statements.filter((s) => s.includes("fapoms_manage_location_ping_partition('drop'"));
      const deleteStatements = statements.filter((s) => /^\s*DELETE/i.test(s));
      expect(dropCalls).toHaveLength(1);
      expect(statements.filter((s) => /\bDROP TABLE\b/i.test(s))).toEqual([]);
      expect(deleteStatements).toEqual([]);
    });

    it('collects a failed drop rather than throwing, so one bad partition does not stop the others', async () => {
      const dataSource = {
        // The partition name is now a bound parameter rather than part of the statement text, so
        // the failure this fixture injects has to be keyed on the parameter. That is the point of
        // binding it: the name never reaches the SQL string.
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('pg_inherits')) {
            return [
              {
                name: 'assayer_location_pings_y2025m01',
                bound: "FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2025-02-01 00:00:00+00')",
              },
              {
                name: 'assayer_location_pings_y2025m02',
                bound: "FOR VALUES FROM ('2025-02-01 00:00:00+00') TO ('2025-03-01 00:00:00+00')",
              },
            ];
          }
          if (params?.[0] === 'assayer_location_pings_y2025m01') {
            throw new Error('lock not available');
          }
          return [];
        }),
      };
      const logger = new Logger('test');

      const { dropped, failures } = await dropExpiredPartitions(
        dataSource as any,
        logger,
        new Date('2026-09-01T00:00:00Z'),
      );

      expect(dropped).toEqual(['assayer_location_pings_y2025m02']);
      expect(failures).toHaveLength(1);
      expect(failures[0].name).toBe('assayer_location_pings_y2025m01');
    });

    it('drops nothing when no partition has fully aged out', async () => {
      const dataSource = {
        query: jest.fn().mockResolvedValue([
          {
            name: 'assayer_location_pings_y2026m09',
            bound: "FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00')",
          },
        ]),
      };
      const logger = new Logger('test');

      const { dropped } = await dropExpiredPartitions(dataSource as any, logger, new Date('2026-09-15T00:00:00Z'));
      expect(dropped).toEqual([]);
    });
  });
});
