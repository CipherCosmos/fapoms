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
import { BillingModule } from './modules/billing/billing.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { AuditPlatformModule } from './modules/audit/audit.module';
import { CustomerMasterModule } from './modules/customer-master/customer-master.module';
import { ValidationQueryModule } from './modules/validation-query/validation-query.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { SlaScannerModule } from './infrastructure/scheduler/sla-scanner.module';
import { SlaScannerWorker } from './infrastructure/scheduler/sla-scanner.worker';

@Module({
  imports: [
    // Environment configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
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
    BillingModule,
    LedgerModule,
    AuditPlatformModule,
    CustomerMasterModule,
    ValidationQueryModule,

    // Background job queue
    QueueModule,
    SlaScannerModule,
  ],
  providers: [],
})
export class AppModule {}
