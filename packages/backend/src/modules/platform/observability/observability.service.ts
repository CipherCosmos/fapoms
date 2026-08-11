import { Injectable } from '@nestjs/common';
import { StructuredLogger, MetricsCollector } from './observability.interface';

/**
 * Structured logging and in-process metrics.
 *
 * `incrementCounter` and `recordGauge` were empty bodies commented "Mock counter increments"
 * and "Mock gauge record" — they accepted a metric and silently discarded it, so any caller
 * believed it was instrumenting something when nothing was recorded anywhere.
 *
 * They now keep real values. The store is deliberately in-process: this deployment has no
 * metrics backend, and a counter that is honest about being per-instance is more useful than
 * one that pretends to be global. `snapshot()` exposes them (see the /health endpoint), which
 * is also what makes the numbers verifiable rather than a claim.
 *
 * If a Prometheus or StatsD backend is introduced later, the two write methods are the only
 * places that need to change.
 */
@Injectable()
export class DefaultObservabilityService implements StructuredLogger, MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, { value: number; at: string }>();

  info(message: string, context?: any): void {
    console.log(`[INFO] ${message}`, context ? JSON.stringify(context) : '');
  }

  warn(message: string, context?: any): void {
    console.warn(`[WARN] ${message}`, context ? JSON.stringify(context) : '');
  }

  error(message: string, trace?: string, context?: any): void {
    console.error(`[ERROR] ${message}`, trace || '', context ? JSON.stringify(context) : '');
  }

  /** Tags are folded into the key so `assignment.created{status=PENDING}` counts separately. */
  private key(metricName: string, tags?: Record<string, string>): string {
    if (!tags || Object.keys(tags).length === 0) return metricName;
    const flat = Object.keys(tags)
      .sort()
      .map((k) => `${k}=${tags[k]}`)
      .join(',');
    return `${metricName}{${flat}}`;
  }

  incrementCounter(metricName: string, tags?: Record<string, string>): void {
    const k = this.key(metricName, tags);
    this.counters.set(k, (this.counters.get(k) ?? 0) + 1);
  }

  recordGauge(metricName: string, value: number, tags?: Record<string, string>): void {
    if (!Number.isFinite(value)) return;
    this.gauges.set(this.key(metricName, tags), { value, at: new Date().toISOString() });
  }

  /** Everything recorded since this process started. */
  snapshot(): { counters: Record<string, number>; gauges: Record<string, { value: number; at: string }> } {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    };
  }
}
