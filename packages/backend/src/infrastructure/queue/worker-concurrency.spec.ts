import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import {
  WORKER_CONCURRENCY,
  DEFAULT_DB_POOL_MAX,
  totalWorkerSlots,
  assertConcurrencyWithinPool,
} from './worker-concurrency';

/**
 * The guard that makes `WORKER_CONCURRENCY` trustworthy.
 *
 * The table in `worker-concurrency.ts` mirrors values that actually live in eleven `@Process`
 * decorators scattered across the tree. A mirror nobody checks is a lie waiting to happen — and
 * the reason that file exists at all is that the real total (29) crossed the connection pool (20)
 * without anyone noticing, precisely because the numbers were only ever read one at a time.
 *
 * So this test reads the decorators, not the table, and fails when they disagree. Adding a queue,
 * or raising a concurrency, breaks the build until the table (and the reasoning above it) is
 * updated to match.
 */
describe('worker concurrency', () => {
  const SRC = join(__dirname, '..', '..');

  /** Every .ts file under src, excluding specs and build output. */
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });

  /**
   * Comments stripped, because this codebase quotes decorators inside them constantly — the
   * queue contracts each explain the `@Process({ name })` / bare `@Process()` dispatch bug in
   * prose, and `import-job.constants.ts` mentions `@Processor` without being one. Counting those
   * inflated the first version of this test from 11 workers to 12 and from 29 slots to 34, which
   * is a fair demonstration of why the number needed a parser rather than an eye in the first
   * place.
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /**
   * Every `@Process(...)` in a `@Processor` class, with the concurrency it declares.
   *
   * Bull's default when no `concurrency` is given is 1, so a bare `@Process('name')` counts as one
   * slot — that default is exactly what made the total easy to under-count by eye.
   */
  const declaredSlots = (): Array<{ file: string; slots: number }> =>
    sourceFiles(SRC)
      .map((file) => ({ file, code: stripComments(readFileSync(file, 'utf8')) }))
      .filter(({ code }) => code.includes('@Processor('))
      .map(({ file, code }) => {
        const slots = [...code.matchAll(/@Process\(([^)]*)\)/g)].reduce((sum, m) => {
          const explicit = /concurrency:\s*(\d+)/.exec(m[1]);
          return sum + (explicit ? Number(explicit[1]) : 1);
        }, 0);
        return { file: file.slice(SRC.length + 1), slots };
      })
      .filter((w) => w.slots > 0);

  it('the mirror in WORKER_CONCURRENCY still matches what the decorators declare', () => {
    const actual = declaredSlots().reduce((sum, w) => sum + w.slots, 0);

    // If this fails, do not just change the number. Read the table's header comment: the total is
    // compared against DB_POOL_MAX, and crossing it is a deployment decision, not a formality.
    expect(actual).toBe(totalWorkerSlots());
  });

  it('every worker class is accounted for in the table', () => {
    // Eleven @Processor classes as of 2026-08-17. A twelfth should fail here rather than silently
    // add slots to a budget nobody re-checked.
    expect(declaredSlots()).toHaveLength(Object.keys(WORKER_CONCURRENCY).length);
  });

  it('DEFAULT_DB_POOL_MAX still matches the fallback in database.config.ts', () => {
    // The comparison is worthless if the two drift: warning against a pool of 20 while the app
    // actually opens 50 would cry wolf, and the reverse would stay silent through the exact
    // condition this exists to catch.
    const config = readFileSync(join(SRC, 'infrastructure', 'database', 'database.config.ts'), 'utf8');
    const fallback = /get<number>\('DB_POOL_MAX',\s*(\d+)\)/.exec(config);

    expect(fallback).not.toBeNull();
    expect(Number(fallback![1])).toBe(DEFAULT_DB_POOL_MAX);
  });

  describe('the boot-time warning', () => {
    const spyLogger = () => {
      const logger = new Logger('test');
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      return logger;
    };

    it('warns when the workers can outnumber the pool', () => {
      const logger = spyLogger();
      assertConcurrencyWithinPool(20, 'all', logger);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DB_POOL_MAX=20'));
    });

    it('stays silent when the pool is large enough', () => {
      const logger = spyLogger();
      assertConcurrencyWithinPool(totalWorkerSlots(), 'all', logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('says nothing on an api-only replica, which runs no jobs at all', () => {
      const logger = spyLogger();
      assertConcurrencyWithinPool(1, 'api', logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('tells a worker-only replica to raise the pool, not that it is starving HTTP', () => {
      // PROCESS_ROLE=worker serves no HTTP, so the "your users will time out" half of the message
      // would be false there. Getting this wrong sends someone chasing a latency problem that
      // cannot exist on that replica.
      const logger = spyLogger();
      assertConcurrencyWithinPool(5, 'worker', logger);
      const message = (logger.warn as jest.Mock).mock.calls[0][0] as string;
      expect(message).toContain('raise DB_POOL_MAX');
      expect(message).not.toContain('request handlers draw from the same pool');
    });
  });
});
