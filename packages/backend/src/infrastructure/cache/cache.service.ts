import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis-client.module';

/**
 * Thin, fault-tolerant JSON cache over the shared ioredis client.
 *
 * Design rules, because a cache must never become a new failure mode:
 *  - Every operation is wrapped so a Redis outage degrades to a cache MISS
 *    (reads return null, writes no-op) rather than throwing into the caller. The
 *    caller always has a source-of-truth fallback; losing Redis must slow the
 *    system, never break it.
 *  - Redis being absent entirely (not configured, e.g. a test run) is handled the
 *    same way — the service simply behaves as an always-miss cache.
 *  - TTLs are mandatory on writes. There is no un-expiring key here, so a stale
 *    value can outlive its source by at most its TTL even if an explicit
 *    invalidation is ever missed.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis) {}

  get enabled(): boolean {
    return !!this.redis;
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`cache get "${key}" failed: ${(err as Error).message}`);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redis || value === undefined || value === null) return;
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSeconds)));
    } catch (err) {
      this.logger.warn(`cache set "${key}" failed: ${(err as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.redis || keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch (err) {
      this.logger.warn(`cache del failed: ${(err as Error).message}`);
    }
  }

  /** Delete every key matching a glob pattern, using a non-blocking SCAN. */
  async delByPattern(pattern: string): Promise<void> {
    if (!this.redis) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(`cache delByPattern "${pattern}" failed: ${(err as Error).message}`);
    }
  }

  /**
   * In-flight loads, so concurrent misses of the same key run `load` once. Keyed by cache key;
   * an entry lives only for the duration of one load.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /**
   * Read-through cache: return the cached value or load it, store it under `ttlSeconds`,
   * and return it. A loader that yields null/undefined is never cached (so a transient
   * empty result cannot pin a "nothing here" answer for the whole TTL).
   *
   * ## Single-flight
   *
   * Concurrent callers that miss the same key share one `load()`. Without this, the keys worth
   * caching are exactly the keys that stampede: the operations dashboard (15 s), the command
   * centre (20 s) and the HR overview (30 s) each run several heavy aggregates, and they expire
   * while every operator has the page open — so the moment the TTL lapses, N simultaneous
   * requests each ran the full query, N times the work, all to store the same answer. At the
   * 09:00 peak that is the whole desk hitting the database at once, every TTL.
   *
   * The dedupe is per process, not cluster-wide. That is deliberate: it needs no lock, cannot
   * wedge (a caller can only ever wait on a load that is actually running in front of it), and
   * a burst lands on one replica anyway because it is one operator's page or one load
   * balancer's connection. Across replicas the worst case is one load each, which is what the
   * cache was already sized for. A failed load rejects every waiter and is not cached, so the
   * next caller retries rather than inheriting an error.
   */
  async wrap<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.getJson<T>(key);
    if (cached !== null && cached !== undefined) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const pending = (async () => {
      const fresh = await load();
      await this.setJson(key, fresh, ttlSeconds);
      return fresh;
    })();
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Run `fn` while holding a cluster-wide lock on `key`, so concurrent callers for the
   * same key run one-at-a-time. Used to make check-then-create flows (e.g. auto-billing
   * an assignment) safe against the event bus delivering two events that would otherwise
   * interleave into a duplicate.
   *
   * FAIL-OPEN by design: if Redis is absent, errors, or the lock can't be acquired within
   * the retry budget, `fn` still runs (unlocked). A distributed lock must never be able to
   * wedge the pipeline shut — the caller's own idempotency guard is the correctness
   * backstop; this lock only closes the concurrency window in the common case.
   */
  async withLock<T>(
    key: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
    opts?: { retries?: number; retryDelayMs?: number },
  ): Promise<T> {
    if (!this.redis) return fn();

    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const retries = opts?.retries ?? 20;
    const retryDelayMs = opts?.retryDelayMs ?? 150;

    let acquired = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.redis.set(key, token, 'EX', Math.max(1, Math.floor(ttlSeconds)), 'NX');
        if (res === 'OK') {
          acquired = true;
          break;
        }
      } catch (err) {
        this.logger.warn(`withLock acquire "${key}" failed: ${(err as Error).message}; proceeding unlocked.`);
        return fn();
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, retryDelayMs));
    }

    if (!acquired) {
      this.logger.warn(`withLock "${key}" not acquired after ${retries} retries; proceeding unlocked.`);
      return fn();
    }

    try {
      return await fn();
    } finally {
      // Compare-and-delete so we only ever release our own lock, never one that already
      // expired and was re-acquired by someone else.
      try {
        await this.redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token,
        );
      } catch {
        /* lock will expire on its own via its TTL */
      }
    }
  }
}
