import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { failFastRedisOptions } from '../http/throttling/resilient-throttler-storage';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Global Redis client module.
 *
 * Provides a single ioredis client instance under the REDIS_CLIENT token.
 * @Global so it is available across all modules without re-importing.
 * The client uses the same REDIS_HOST / REDIS_PORT config as Bull.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const password = config.get<string>('REDIS_PASSWORD');
        // Fail-fast, reconnect-forever. Every consumer of this client (cache, locks, upload
        // sessions) has a fallback for "Redis said no", but none for "Redis said nothing":
        // ioredis' defaults park each command in an offline queue and retry it twenty times, so
        // a Redis outage turned every cache read into a 10–40 s stall before the fallback ran.
        // Reconnect forever with capped back-off, because returning null from a retryStrategy
        // ENDS the connection permanently and a brief blip becomes a dead client until redeploy.
        // See resilient-throttler-storage.ts for the same choice on the limiter's client.
        const client = new Redis(
          failFastRedisOptions({
            host: config.get<string>('REDIS_HOST', 'localhost'),
            port: config.get<number>('REDIS_PORT', 6379),
            // Only include password in config when it is actually set.
            ...(password ? { password } : {}),
          }),
        );
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisClientModule {}
