import { Logger } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

/** The record shape `ThrottlerGuard` expects back from a storage. */
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * ioredis options for a client whose failure must degrade, never hang.
 *
 * ioredis defaults are tuned for durability of a command, not availability of the caller: while
 * the server is unreachable every command is parked in an offline queue and each is retried up
 * to twenty times before its promise rejects. For a cache or a rate-limit counter that means a
 * request waits 10–40 s and then fails — the worst of both worlds. Reproduced on 2026-08-16:
 * with Redis paused, `/health` and an authenticated route hung past 25 s while Postgres was
 * fine, and recovered the instant Redis returned.
 *
 * With these options a command either completes quickly or fails quickly, and the caller's own
 * fallback (cache miss, throttle skipped, lock not held) takes over.
 */
export function failFastRedisOptions(base: RedisOptions = {}): RedisOptions {
  return {
    ...base,
    // A round trip to a local Redis is sub-millisecond; anything approaching this budget is an
    // outage or a stalled fork, and the caller has a fallback for both.
    commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 500,
    // One retry, not twenty: the outage will not end inside a request.
    maxRetriesPerRequest: 1,
    // Fail immediately while disconnected instead of queueing behind the reconnect.
    enableOfflineQueue: false,
    // Keep trying to reconnect forever, with capped back-off — a client that gives up is a
    // client that stays broken after the outage ends.
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    lazyConnect: false,
  };
}

/**
 * A throttler storage that fails OPEN.
 *
 * `ThrottlerGuard` awaits `storage.increment(...)` on every request with no try/catch, and it is
 * a global guard, so a storage error is a 500 on every route — including `/health`. Rate limiting
 * exists to protect the service from abuse; it must not be the thing that takes the service down.
 * When Redis is unreachable this returns "no hits, not blocked", logs once per minute rather than
 * once per request, and counts the event so a dashboard can show that limits were not being
 * enforced. The trade is explicit: during a Redis outage there is no rate limiting. That is the
 * lesser harm, and the outage itself is already visible on the readiness probe.
 */
export class ResilientThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(ResilientThrottlerStorage.name);
  private lastWarnAt = 0;

  constructor(
    private readonly inner: ThrottlerStorage,
    private readonly onFailOpen?: () => void,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.inner.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch (err) {
      const now = Date.now();
      if (now - this.lastWarnAt > 60_000) {
        this.lastWarnAt = now;
        this.logger.warn(
          `Rate-limit storage unavailable (${(err as Error).message}); requests are being admitted WITHOUT throttling until it recovers.`,
        );
      }
      this.onFailOpen?.();
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}

/**
 * Build the production throttler storage: Redis-backed (so replicas share one budget) over a
 * fail-fast client, wrapped to fail open.
 */
export function createResilientThrottlerStorage(
  redis: RedisOptions,
  onFailOpen?: () => void,
): ThrottlerStorage {
  const client = new Redis(failFastRedisOptions(redis));
  // A client that logs every reconnect attempt at error level floods the log during an outage;
  // the storage's own once-a-minute warning is the signal.
  client.on('error', () => undefined);
  return new ResilientThrottlerStorage(new ThrottlerStorageRedisService(client), onFailOpen);
}
