import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

/**
 * Global cache module.
 *
 * Exposes CacheService (a fault-tolerant JSON cache over the shared ioredis
 * client) everywhere without re-importing. Depends only on the already-global
 * RedisClientModule, so it composes cleanly and adds no new infrastructure.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
