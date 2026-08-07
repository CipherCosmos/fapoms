import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

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
        const client = new Redis({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          // Only include password in config when it is actually set.
          ...(password ? { password } : {}),
          // Retry up to 5 times with exponential back-off; null stops retrying.
          retryStrategy: (times: number) => (times > 5 ? null : Math.min(times * 100, 3000)),
        });
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisClientModule {}
