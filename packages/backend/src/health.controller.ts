import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Unauthenticated liveness check.
 *
 * Deliberately outside the auth guards: its callers are things that cannot hold a token —
 * the mobile app's "test this server address" button, container healthchecks, and load
 * balancers. It reports only whether the process is up and whether the database answers,
 * and nothing about the data itself, so exposing it discloses nothing.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
}
