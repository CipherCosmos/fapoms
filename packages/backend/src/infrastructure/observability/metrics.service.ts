import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics registry for the API.
 *
 * Until now the only telemetry was in-process counters that never left the box, so
 * there was no way to see the very bottlenecks this hardening addresses (request
 * latency, error rate, event-loop lag, memory) under real load. This exposes a
 * standard `/metrics` scrape endpoint carrying:
 *   - Node/process defaults (CPU, heap, event-loop lag, GC, open handles).
 *   - Per-route HTTP request rate, error rate and latency histograms.
 *
 * The registry is isolated (not the global default) so tests and multiple imports
 * cannot double-register a metric and throw.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** Prometheus text exposition content type (stable across the format we emit). */
  readonly contentType = 'text/plain; version=0.0.4; charset=utf-8';

  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly httpTotal: Counter<'method' | 'route' | 'status'>;

  constructor() {
    this.registry.setDefaultLabels({ app: 'fapoms-backend' });
    collectDefaultMetrics({ register: this.registry });

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds, by route and status',
      labelNames: ['method', 'route', 'status'],
      // Tuned for an OLTP API: most requests are tens of ms, with a long tail.
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });

    this.httpTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests, by route and status',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
  }

  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
