/**
 * FAPOMS — Root Application Module
 *
 * Composes all feature modules into the application.
 * Modules are organized per the 13 business modules defined in Part 3.
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

// Infrastructure
import { databaseConfig } from './infrastructure/database/database.config';

// Core modules
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { AuditModule } from './core/audit/audit.module';

// Business modules
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

    // Core modules
    AuditModule,
    AuthModule,
    UserModule,

    // Business modules
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
  ],
})
export class AppModule {}
