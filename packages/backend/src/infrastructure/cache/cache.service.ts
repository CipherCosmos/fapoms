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
   * Read-through cache: return the cached value or load it, store it under `ttlSeconds`,
   * and return it. A loader that yields null/undefined is never cached (so a transient
   * empty result cannot pin a "nothing here" answer for the whole TTL).
   */
  async wrap<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.getJson<T>(key);
    if (cached !== null && cached !== undefined) return cached;
    const fresh = await load();
    await this.setJson(key, fresh, ttlSeconds);
    return fresh;
  }
}
