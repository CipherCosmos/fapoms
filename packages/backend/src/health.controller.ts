import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { NoEnvelope } from './infrastructure/http/response.interceptor';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './infrastructure/redis/redis-client.module';
import { realtimeHealth } from './infrastructure/realtime/realtime-health';
import { probeDatabase } from './health-probe';
import { messagingStatus, readChannelHealth } from './modules/notifications/messaging-health';

/**
 * Unauthenticated liveness/readiness checks.
 *
 * Deliberately outside the auth guards: its callers are things that cannot hold a token —
 * the mobile app's "test this server address" button, container healthchecks, and load
 * balancers. It reports only whether the process is up and whether its backing services
 * answer, and nothing about the data itself, so exposing it discloses nothing.
 */
@ApiTags('Health')
// Body shape is a deployment contract read by load balancers, container healthchecks and the
// mobile "test this server address" button — none of which redeploy with the application.
@NoEnvelope()
/**
 * Never rate-limited. The limiter's counters live in Redis; a liveness probe that touches Redis
 * fails whenever Redis does, which is exactly when an orchestrator would then restart a healthy
 * API. Liveness must depend on nothing but the process itself and the database it serves from.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * Liveness — is the process up and can it reach its database? Kept cheap and
   * dependency-light so a load balancer can hammer it.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness and database connectivity check' })
  async check() {
    const database = await probeDatabase(this.dataSource);
    return { status: database === 'up' ? 'ok' : 'degraded', database };
  }

  /**
   * Readiness — should this replica receive traffic? It checks every backing
   * service the replica needs to serve requests correctly (DB + Redis, the latter
   * powering rate limiting, caching and multi-node realtime). An orchestrator uses
   * this to drain a replica whose Redis link has dropped rather than route to it.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness check across backing services (DB, Redis)' })
  async ready() {
    const [database, redis] = await Promise.all([
      probeDatabase(this.dataSource),
      this.pingRedis(),
    ]);

    // Redis absent (not configured) is treated as "not blocking readiness" so a
    // single-node deployment without Redis still reports ready; a configured-but-
    // unreachable Redis reports down.
    const realtime = this.realtimeStatus();
    const ready = database === 'up' && redis !== 'down' && realtime !== 'degraded';
    /*
      Reported, but deliberately NOT part of `ready`: a mail server refusing our password is not a
      reason to pull every API replica out of rotation — that would turn an email outage into a
      full outage. It is here so a probe or dashboard reading this body sees it.
    */
    const messaging = database === 'up' ? await this.messagingStatus() : 'unknown';
    return { status: ready ? 'ok' : 'degraded', database, redis, realtime, messaging };
  }

  /** `degraded` when some channel has failures in the last half hour and no send at all. */
  private async messagingStatus(): Promise<'ok' | 'degraded' | 'unknown'> {
    try {
      return messagingStatus(await readChannelHealth((sql, params) => this.dataSource.query(sql, params)));
    } catch {
      return 'unknown';
    }
  }

  /**
   * `single-node` — Redis realtime not configured (dev / single replica); not a problem.
   * `ok` — the Socket.IO Redis adapter connected; cross-replica realtime works.
   * `degraded` — Redis was configured but the adapter fell back to in-memory, so this replica
   * cannot deliver realtime across nodes and should be pulled from rotation.
   */
  private realtimeStatus(): 'ok' | 'degraded' | 'single-node' {
    if (!realtimeHealth.redisConfigured) return 'single-node';
    return realtimeHealth.redisAdapterConnected ? 'ok' : 'degraded';
  }

  private async pingRedis(): Promise<'up' | 'down' | 'absent'> {
    if (!this.redis) return 'absent';
    try {
      await this.redis.ping();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
