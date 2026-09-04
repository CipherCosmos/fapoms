import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityTelemetryEntity } from './activity-telemetry.entity';
import { TelemetryService } from './telemetry.service';
import { TelemetryController } from './telemetry.controller';

/**
 * UI interaction telemetry — ingestion and the admin read.
 *
 * Deliberately thin: telemetry is analytics, not part of the audit or auth cores, so it owns its one
 * table and nothing else. Retention purges it on the schedule the RetentionService owns (the
 * UI_TELEMETRY class), by raw SQL, so nothing here needs to be exported for that.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ActivityTelemetryEntity])],
  controllers: [TelemetryController],
  providers: [TelemetryService],
})
export class TelemetryModule {}
