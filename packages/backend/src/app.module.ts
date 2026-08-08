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
import { PlatformFoundationModule } from './modules/platform/platform-foundation.module';

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
import { CommunicationModule } from './modules/communication/communication.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DocumentModule } from './modules/document/document.module';
import { ValidationModule } from './modules/validation/validation.module';
import { OcrModule } from './infrastructure/ocr/ocr.module';
import { GeoModule } from './modules/geo/geo.module';
import { SearchModule } from './modules/search/search.module';
import { AuditHistoryModule } from './modules/audit-history/audit-history.module';
import { AuditPlatformModule } from './modules/audit/audit.module';
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
import { HealthController } from './health.controller';
import { ExpenseModule } from './modules/expense/expense.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
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
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        storage: new ThrottlerStorageRedisService({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD'),
        }),
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

    // Core modules
    AuditModule,
    AuthModule,
    UserModule,
    PlatformModule,
    PlatformFoundationModule,

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
    CommunicationModule,
    NotificationsModule,
    DocumentModule,
    ValidationModule,
    OcrModule,
    GeoModule,
    SearchModule,
    AuditHistoryModule,
    BillingEngineModule,
    AuditPlatformModule,
    CustomerMasterModule,
    ValidationQueryModule,

    // Background job queue
    QueueModule,
    SlaScannerModule,

    ExpenseModule,

    // Real-time events
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    // Applied globally so a new controller cannot be added without throttling by omission.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
