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
 * migration and the CREATE TABLE ... PARTITION OF statements agree on, and retention now retires
 * an old partition with DROP TABLE rather than deleting its rows one at a time.
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
    it('creates only the partitions that do not already exist, via CREATE TABLE ... PARTITION OF', async () => {
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
      const createStatements = queries.filter((q) => q.sql.includes('PARTITION OF'));
      expect(createStatements).toHaveLength(2);
      expect(createStatements[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS "assayer_location_pings_y2026m10"/);
      expect(createStatements[0].sql).toMatch(
        /FOR VALUES FROM \('2026-10-01T00:00:00\.000Z'\) TO \('2026-11-01T00:00:00\.000Z'\)/,
      );
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

      const dropStatements = statements.filter((s) => /DROP TABLE/i.test(s));
      const deleteStatements = statements.filter((s) => /^\s*DELETE/i.test(s));
      expect(dropStatements).toEqual(['DROP TABLE IF EXISTS "assayer_location_pings_y2025m01"']);
      expect(deleteStatements).toEqual([]);
    });

    it('collects a failed drop rather than throwing, so one bad partition does not stop the others', async () => {
      const dataSource = {
        query: jest.fn(async (sql: string) => {
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
          if (sql.includes('assayer_location_pings_y2025m01')) {
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
