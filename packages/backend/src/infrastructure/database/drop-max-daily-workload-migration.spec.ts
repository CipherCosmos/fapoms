import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { DropAssayerMaxDailyWorkload1801700000000 } from './migrations/1801700000000-DropAssayerMaxDailyWorkload';

/**
 * Owner decision 2026-09-25: "Most jobs per day" is removed entirely. The migration drops the
 * column; nothing in the application may read or write it any more.
 *
 * Lives beside `migrations/`, not in it: the runtime glob loads every `migrations/*.ts` as a migration.
 */
describe('DropAssayerMaxDailyWorkload1801700000000', () => {
  const dir = join(__dirname, 'migrations');

  it('drops the column idempotently, and down puts it back at its old default', async () => {
    const sql: string[] = [];
    const runner: any = { query: async (q: string) => { sql.push(q); } };
    const m = new DropAssayerMaxDailyWorkload1801700000000();
    await m.up(runner);
    expect(sql).toEqual(['ALTER TABLE "assayers" DROP COLUMN IF EXISTS "max_daily_workload"']);
    sql.length = 0;
    await m.down(runner);
    expect(sql[0]).toMatch(/ADD COLUMN IF NOT EXISTS "max_daily_workload" integer NOT NULL DEFAULT 3/);
  });

  it('runs after the outbound-retry migration, and nothing else shares its timestamp', () => {
    const stamps = readdirSync(dir).filter((f) => /^\d+-.*\.ts$/.test(f)).map((f) => Number(f.split('-')[0]));
    expect(stamps).toContain(1801600000000);
    expect(1801700000000).toBeGreaterThan(1801600000000);
    expect(stamps.filter((s) => s === 1801700000000)).toHaveLength(1);
  });

  /** The column is gone from the entity, so TypeORM can never select or write it again. */
  it('the assayer entity no longer maps it', () => {
    const entity = readFileSync(join(__dirname, '../../modules/assayer/assayer.entity.ts'), 'utf8');
    expect(entity).not.toMatch(/max_daily_workload/);
    expect(entity).not.toMatch(/maxDailyWorkload/);
  });
});
