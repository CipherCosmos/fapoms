import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { NoEnvelope } from './infrastructure/http/response.interceptor';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './infrastructure/redis/redis-client.module';
import { realtimeHealth } from './infrastructure/realtime/realtime-health';

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
    let database = 'up';
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      database = 'down';
    }
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
      this.dataSource
        .query('SELECT 1')
        .then(() => 'up')
        .catch(() => 'down'),
      this.pingRedis(),
    ]);

    // Redis absent (not configured) is treated as "not blocking readiness" so a
    // single-node deployment without Redis still reports ready; a configured-but-
    // unreachable Redis reports down.
    const realtime = this.realtimeStatus();
    const ready = database === 'up' && redis !== 'down' && realtime !== 'degraded';
    return { status: ready ? 'ok' : 'degraded', database, redis, realtime };
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
