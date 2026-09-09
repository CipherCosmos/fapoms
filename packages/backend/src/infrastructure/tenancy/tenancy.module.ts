import { Global, Module } from '@nestjs/common';
import { TenantContext } from './tenant-context';
import { AmbientTenantContext } from './ambient-tenant-context';

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
/**
 * `AmbientTenantContext` is provided alongside it and is the one in use today. It answers the same
 * questions from the `AsyncLocalStorage` request context instead of `@Inject(REQUEST)`, so it is a
 * singleton: a consumer can inject it without turning its own injection chain request-scoped, which
 * is what `AssayerService` needs — it is reached from a Bull processor, and a request-scoped
 * processor cannot resolve a request. See that file's header for the full reasoning.
 */
@Global()
@Module({
  providers: [TenantContext, AmbientTenantContext],
  exports: [TenantContext, AmbientTenantContext],
})
export class TenancyModule {}
