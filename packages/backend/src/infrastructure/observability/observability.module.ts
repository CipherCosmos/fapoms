import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { JobFailureMonitor } from '../queue/job-failure.monitor';
import { StartupChecksService } from './startup-checks.service';
import { RuntimeMetricsService } from './runtime-metrics.service';

/**
 * Observability wiring: the Prometheus registry, the `/metrics` endpoint, a
 * globally-applied interceptor that times every HTTP request, and the boot-time
 * self-check that says out loud what this deployment cannot do. Global so
 * MetricsService can be injected by any module that wants to add custom metrics.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    // Samples the pool, the queues and the socket count at scrape time — the three things the
    // audit found impossible to diagnose from outside the process.
    RuntimeMetricsService,
    MetricsAuthGuard,
    JobFailureMonitor,
    StartupChecksService,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [MetricsService, StartupChecksService],
})
export class ObservabilityModule {}
