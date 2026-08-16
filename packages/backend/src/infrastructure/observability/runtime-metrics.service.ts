import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { Gauge } from 'prom-client';
import { MetricsService } from './metrics.service';
import { REDIS_CLIENT } from '../redis/redis-client.module';

/**
 * The gauges that make the failures this system actually has visible.
 *
 * An audit of 2026-08-16 listed what could not be diagnosed from `/metrics`: the database pool
 * (exhaustion showed only as latency), queue depth and the age of the oldest waiting job (a
 * stalled worker was invisible until someone noticed work not happening), and live socket
 * count. Every one of those was a real incident shape in this system — the pool was
 * self-deadlocking on audit writes, a mis-registered processor dead-lettered every job, and the
 * socket layer silently fell back to single-node when Redis was away.
 *
 * All of them are sampled at scrape time rather than pushed, so they cost nothing between
 * scrapes and cannot themselves become a source of load. Each sampler is individually guarded:
 * a gauge that cannot be read must leave the others readable, because the moment these matter
 * most is exactly when one of the dependencies behind them is failing.
 */
@Injectable()
export class RuntimeMetricsService {
  /** Queues to sample. Kept in step with ALL_QUEUE_NAMES in main.ts. */
  private static readonly QUEUE_NAMES = [
    'background-jobs',
    'ocr',
    'sla-scanner',
    'document-dispatch',
    'notification-delivery',
    'outbox',
  ];

  constructor(
    private readonly metrics: MetricsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {
    this.registerPoolGauges();
    this.registerQueueGauges();
  }

  /**
   * Database pool occupancy.
   *
   * `waiting` is the one that matters: a non-zero value means requests are queuing for a
   * connection, which is what pool exhaustion looks like from the inside. It is how the
   * audit-write-on-a-second-connection deadlock would have been spotted — twenty concurrent
   * assignment transitions each holding one connection and asking for another — instead of
   * being read as "the API is slow".
   */
  private registerPoolGauges(): void {
    const pool = () => (this.dataSource.driver as unknown as { master?: PoolLike })?.master;

    new Gauge({
      name: 'db_pool_connections',
      help: 'Database pool connections by state (total = open sockets, idle = free, waiting = requests queued for one)',
      labelNames: ['state'],
      registers: [this.metrics.registry],
      collect() {
        const p = pool();
        if (!p) return;
        // node-postgres exposes these as counters on the pool; guarded because a driver that
        // does not (or a pool not yet created) must not break the whole scrape.
        if (typeof p.totalCount === 'number') this.set({ state: 'total' }, p.totalCount);
        if (typeof p.idleCount === 'number') this.set({ state: 'idle' }, p.idleCount);
        if (typeof p.waitingCount === 'number') this.set({ state: 'waiting' }, p.waitingCount);
      },
    });
  }

  /**
   * Queue depth and the age of the oldest waiting job.
   *
   * Depth alone does not distinguish "busy" from "stopped": a queue with 500 waiting jobs is
   * healthy if they are seconds old and an outage if the oldest has been there an hour. The age
   * gauge is the one to alert on.
   */
  private registerQueueGauges(): void {
    const redis = this.redis;
    const names = RuntimeMetricsService.QUEUE_NAMES;

    new Gauge({
      name: 'queue_jobs',
      help: 'Bull jobs per queue by state',
      labelNames: ['queue', 'state'],
      registers: [this.metrics.registry],
      async collect() {
        if (!redis) return;
        for (const name of names) {
          try {
            // Read Redis directly rather than injecting six Queue instances: this service is
            // global and must not force every queue to be registered wherever it is imported.
            const [waiting, active, delayed, failed] = await Promise.all([
              redis.llen(`bull:${name}:wait`),
              redis.llen(`bull:${name}:active`),
              redis.zcard(`bull:${name}:delayed`),
              redis.zcard(`bull:${name}:failed`),
            ]);
            this.set({ queue: name, state: 'waiting' }, waiting ?? 0);
            this.set({ queue: name, state: 'active' }, active ?? 0);
            this.set({ queue: name, state: 'delayed' }, delayed ?? 0);
            this.set({ queue: name, state: 'failed' }, failed ?? 0);
          } catch {
            // Redis unreachable, or this queue has never existed. Either way the other queues
            // and every other metric must still be scrapeable.
          }
        }
      },
    });

    new Gauge({
      name: 'queue_oldest_waiting_seconds',
      help: 'Age of the oldest waiting job per queue, in seconds (0 when the queue is empty)',
      labelNames: ['queue'],
      registers: [this.metrics.registry],
      async collect() {
        if (!redis) return;
        for (const name of names) {
          try {
            // The wait list is FIFO, so the last element is the oldest job id; its hash carries
            // the enqueue timestamp.
            const ids = await redis.lrange(`bull:${name}:wait`, -1, -1);
            if (!ids?.length) {
              this.set({ queue: name }, 0);
              continue;
            }
            const timestamp = await redis.hget(`bull:${name}:${ids[0]}`, 'timestamp');
            const enqueuedAt = Number(timestamp);
            this.set(
              { queue: name },
              Number.isFinite(enqueuedAt) ? Math.max(0, (Date.now() - enqueuedAt) / 1000) : 0,
            );
          } catch {
            /* see above */
          }
        }
      },
    });
  }
}

/** The subset of node-postgres' Pool this samples, without depending on its types. */
interface PoolLike {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}
