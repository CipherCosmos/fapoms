import { Global, Module } from '@nestjs/common';
import { TenantContext } from './tenant-context';

/**
 * Provides the request-scoped `TenantContext`.
 *
 * `@Global()` so a feature module can inject it without importing anything — the same
 * treatment `CacheModule` and `RedisClientModule` already get, and appropriate for a
 * cross-cutting concern that every tenant-owned repository will eventually need.
 *
 * Being global does not make it eager: `Scope.REQUEST` providers are instantiated per
 * request and only for the injection chains that actually ask for one, so modules that never
 * touch tenant data pay nothing.
 */
@Global()
@Module({
  providers: [TenantContext],
  exports: [TenantContext],
})
export class TenancyModule {}
