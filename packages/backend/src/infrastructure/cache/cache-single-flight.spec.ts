import { CacheService } from './cache.service';

/**
 * The keys worth caching are the keys that stampede: the dashboard, command-centre and HR
 * aggregates all expire while every operator has the page open, so without single-flight the
 * moment a TTL lapses N requests each run the full query to store the same answer.
 */
describe('CacheService.wrap single-flight', () => {
  /** An always-miss cache (no Redis), which is also how a Redis outage behaves. */
  const missing = () => new CacheService(undefined);

  it('runs one load for concurrent misses of the same key', async () => {
    const cache = missing();
    let loads = 0;
    const load = () =>
      new Promise<string>((resolve) => {
        loads += 1;
        setTimeout(() => resolve('value'), 20);
      });

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => cache.wrap('k', 30, load)));

    expect(loads).toBe(1);
    expect(results).toEqual(['value', 'value', 'value', 'value', 'value']);
  });

  it('keeps different keys independent', async () => {
    const cache = missing();
    let loads = 0;
    const load = async () => { loads += 1; return 'v'; };

    await Promise.all([cache.wrap('a', 30, load), cache.wrap('b', 30, load)]);

    expect(loads).toBe(2);
  });

  it('rejects every waiter on failure and does not pin the error', async () => {
    const cache = missing();
    let attempts = 0;
    const failing = async () => { attempts += 1; throw new Error('db down'); };

    const settled = await Promise.allSettled([cache.wrap('k', 30, failing), cache.wrap('k', 30, failing)]);
    expect(settled.every((r) => r.status === 'rejected')).toBe(true);
    expect(attempts).toBe(1);

    // The failed load left nothing behind, so the next caller genuinely retries.
    await expect(cache.wrap('k', 30, async () => 'recovered')).resolves.toBe('recovered');
  });
});
