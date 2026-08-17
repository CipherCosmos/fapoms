import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { CircuitBreaker } from '../resilience/circuit-breaker';

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

    this.jobsFailed = new Counter({
      name: 'jobs_failed_total',
      help: 'Background jobs that exhausted their retries (dead-lettered), by queue and job name',
      labelNames: ['queue', 'job'],
      registers: [this.registry],
    });

    // Circuit-breaker state per external dependency, sampled on each scrape so an outage (a breaker
    // sitting at OPEN=2) is visible on the dashboard and alertable. 0=CLOSED, 1=HALF_OPEN, 2=OPEN.
    new Gauge({
      name: 'circuit_breaker_state',
      help: 'Circuit breaker state per dependency (0=closed, 1=half-open, 2=open)',
      labelNames: ['name'],
      registers: [this.registry],
      collect() {
        for (const breaker of CircuitBreaker.all()) {
          this.set({ name: breaker.name }, breaker.stateCode());
        }
      },
    });
  }

  readonly jobsFailed: Counter<'queue' | 'job'>;

  /**
   * Requests refused with 429. Guards run before the HTTP metrics interceptor, so without this a
   * throttled request left no trace at all — the organisation-wide rate-limit ceiling of August
   * 2026 could not have been seen on a dashboard even by someone looking for it.
   */
  readonly httpThrottled: Counter<'route' | 'tracker'> = new Counter({
    name: 'http_throttled_total',
    help: 'Requests refused by the rate limiter (429), by route and whether the budget was per-user or per-IP',
    labelNames: ['route', 'tracker'],
    registers: [this.registry],
  });

  /**
   * Times the rate limiter admitted a request because its Redis storage was unreachable. Non-zero
   * means limits are not being enforced right now — alert on it alongside Redis availability.
   */
  readonly throttlerFailOpen: Counter<string> = new Counter({
    name: 'throttler_fail_open_total',
    help: 'Requests admitted without rate limiting because the limiter storage was unavailable',
    registers: [this.registry],
  });

  /**
   * Retention passes that hit their batch ceiling instead of running out of rows.
   *
   * This is the alarm behind the partitioning decision recorded in
   * `1790600000000-DataLifecycleIndexes`. That migration declines to partition the append tables
   * and names the condition that should change the answer: "a purge tick failing to keep up
   * (visible as `RetentionService` reporting a full batch on every pass for a week)". As written
   * that was not visible at all — the pass logged a row total, and 50,000 is what you see both
   * when the table is drained by the last batch and when there are ten million rows still waiting.
   * Telling those apart meant knowing that 50,000 is exactly BATCH_SIZE × MAX_BATCHES and noticing
   * the same number in the logs week after week.
   *
   * A saturated pass means only one thing: there was more to delete than the tick was allowed to
   * delete. One is unremarkable — it is the expected shape of the first passes after a backlog.
   * A rate that stays above zero is the trigger, and now it is a number on a dashboard rather than
   * an archaeology exercise.
   */
  readonly retentionSaturated: Counter<'table'> = new Counter({
    name: 'retention_batches_saturated_total',
    help: 'Retention passes that exhausted their batch ceiling with rows still to delete, by table',
    labelNames: ['table'],
    registers: [this.registry],
  });

  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
