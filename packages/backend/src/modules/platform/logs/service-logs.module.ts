import { Module } from '@nestjs/common';
import { AuditModule } from '../../../core/audit/audit.module';
import { DockerEngineClient } from './docker-engine.client';
import { ServiceLogsService } from './service-logs.service';
import { ServiceLogsController } from './service-logs.controller';

/**
 * The service-log viewer.
 *
 * Self-contained on purpose: it owns its Docker client and depends on nothing but the audit
 * trail. Removing this module removes the feature and every route it serves, which is the
 * property you want in the part of the system that hands out raw log output.
 */
@Module({
  imports: [AuditModule],
  controllers: [ServiceLogsController],
  providers: [DockerEngineClient, ServiceLogsService],
  exports: [ServiceLogsService],
})
export class ServiceLogsModule {}
