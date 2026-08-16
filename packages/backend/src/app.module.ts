/**
 * FAPOMS — Root Application Module
 *
 * Composes all feature modules into the application.
 * Modules are organized per the 13 business modules defined in Part 3.
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

// Infrastructure
import { databaseConfig } from './infrastructure/database/database.config';

// Core modules
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { AuditModule } from './core/audit/audit.module';
import { PlatformModule } from './modules/platform/platform.module';

// Business modules
import { OrganizationModule } from './modules/organization/organization.module';
import { ClientModule } from './modules/client/client.module';
import { BranchModule } from './modules/branch/branch.module';
import { AssayerModule } from './modules/assayer/assayer.module';
import { HolidayModule } from './modules/holiday/holiday.module';
import { ZoneModule } from './modules/zone/zone.module';
import { PlanningModule } from './modules/planning/planning.module';
import { ProjectModule } from './modules/project/project.module';
import { AssignmentModule } from './modules/assignment/assignment.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DocumentModule } from './modules/document/document.module';
import { ValidationModule } from './modules/validation/validation.module';
import { OcrModule } from './infrastructure/ocr/ocr.module';
import { GeoModule } from './modules/geo/geo.module';
import { SearchModule } from './modules/search/search.module';
import { CustomerMasterModule } from './modules/customer-master/customer-master.module';
import { ValidationQueryModule } from './modules/validation-query/validation-query.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { SlaScannerModule } from './infrastructure/scheduler/sla-scanner.module';
import { SlaScannerWorker } from './infrastructure/scheduler/sla-scanner.worker';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { BillingEngineModule } from './modules/billing-engine/billing-engine.module';
import { RedisClientModule } from './infrastructure/redis/redis-client.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { SecurityModule } from './infrastructure/security/security.module';
import { TenancyModule } from './infrastructure/tenancy/tenancy.module';
import { ScopeModule } from './infrastructure/scope/scope.module';
import { RuleBypassModule } from './modules/platform/rule-bypass/rule-bypass.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { HealthController } from './health.controller';
import { ExpenseModule } from './modules/expense/expense.module';
import { ReportsModule } from './modules/reports/reports.module';
import { CallsModule } from './modules/calls/calls.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserAwareThrottlerGuard } from './infrastructure/http/throttling/user-aware-throttler.guard';
import { createResilientThrottlerStorage } from './infrastructure/http/throttling/resilient-throttler-storage';
import { MetricsService } from './infrastructure/observability/metrics.service';
import { APP_GUARD } from '@nestjs/core';
import { PlatformSettingsModule } from './infrastructure/settings/platform-settings.module';

@Module({
  imports: [
    // Global: pricing, billing, expenses, scheduling and delivery all read operator-owned
    // configuration, and threading a module import through each of them would add graph edges
    // purely to fetch a number.
    PlatformSettingsModule,
    SecurityModule,
    // Environment configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    /**
     * Request throttling.
     *
     * There was none, which matters most on `/auth/login`: an unauthenticated caller could
     * try passwords as fast as the network allowed. That is not theoretical here — the seeded
     * accounts share a small number of weak passwords, so an unthrottled login endpoint is
     * the shortest path into a system holding bank audit evidence.
     *
     * These are global defaults; the auth routes narrow them further with their own @Throttle.
     */
    /**
     * A single unnamed ("default") throttler, because the per-route @Throttle decorators
     * override by that key. Defining named throttlers here instead would leave those
     * decorators referring to a throttler that does not exist.
     *
     * Counters live in Redis rather than process memory. In-memory storage gives each
     * replica its own budget, so behind a load balancer an attacker gets N times the
     * intended allowance simply by spreading requests, and every deploy resets the counters
     * to zero. Redis is already a hard dependency here (queues, upload sessions), so this
     * adds no new infrastructure.
     */
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, MetricsService],
      useFactory: (config: ConfigService, metrics: MetricsService) => ({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        // Fail-fast client, fail-open storage: a Redis outage stops rate limiting, not the API.
        // See resilient-throttler-storage.ts for why the stock storage took the whole API down.
        storage: createResilientThrottlerStorage(
          {
            host: config.get<string>('REDIS_HOST', 'localhost'),
            port: config.get<number>('REDIS_PORT', 6379),
            password: config.get<string>('REDIS_PASSWORD') || undefined,
          },
          () => metrics.throttlerFailOpen.inc(),
        ),
      }),
    }),

    // Database connection
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: databaseConfig,
    }),

    // Background job queue
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD'),
        },
      }),
    }),

    // Global Redis client (ioredis) — used by ChunkedUploadService for
    // multipart upload session state and any other direct Redis consumers.
    RedisClientModule,

    // Global fault-tolerant JSON cache over the Redis client (RBAC principals,
    // reference/config data). Imported after RedisClientModule so the REDIS_CLIENT
    // token it depends on is available.
    CacheModule,

    // Prometheus metrics: /metrics endpoint + global HTTP timing interceptor.
    ObservabilityModule,

    // Request-scoped tenant context. Global so any repository over organisation-owned data
    // can inject it without a module import. Replaces the singleton TenantContextResolver,
    // which held per-request state in a process-wide field.
    TenancyModule,
    ScopeModule,
    // Global: the rules it governs are enforced across planning, assignment and check-in.
    RuleBypassModule,
    PersistenceModule,

    // Core modules
    AuditModule,
    AuthModule,
    UserModule,
    PlatformModule,

    // Business modules
    OrganizationModule,
    ClientModule,
    BranchModule,
    AssayerModule,
    HolidayModule,
    ZoneModule,
    PlanningModule,
    ProjectModule,
    AssignmentModule,
    SchedulingModule,
    NotificationsModule,
    DocumentModule,
    ValidationModule,
    OcrModule,
    GeoModule,
    SearchModule,
    BillingEngineModule,
    CustomerMasterModule,
    ValidationQueryModule,
    CallsModule,
    FeedbackModule,

    // Background job queue
    QueueModule,
    SlaScannerModule,

    ExpenseModule,

    // Reporting / Excel exports
    ReportsModule,

    // Real-time events
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    // Applied globally so a new controller cannot be added without throttling by omission.
    // Keyed per user (verified token) or per real client address, never per proxy — see the guard.
    { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
  ],
})
export class AppModule {}
