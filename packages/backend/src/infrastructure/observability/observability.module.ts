import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';

/**
 * Observability wiring: the Prometheus registry, the `/metrics` endpoint, and a
 * globally-applied interceptor that times every HTTP request. Global so
 * MetricsService can be injected by any module that wants to add custom metrics.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [MetricsService],
})
export class ObservabilityModule {}
