import { Logger } from '@nestjs/common';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long to stay open (skip the call, use the fallback) before probing again. */
  cooldownMs?: number;
  name?: string;
}

/**
 * A minimal circuit breaker for calls to an external dependency (e.g. the OSRM routing server).
 *
 * Without it, every call to a downed service pays the full connect/read timeout before falling back —
 * so a sustained outage makes every planning request slow. The breaker trips after a run of failures
 * and then short-circuits straight to the fallback for a cooldown, occasionally letting one trial
 * request through (HALF_OPEN) to detect recovery. One success closes it again.
 *
 * `nowFn` is injectable so the time-based transitions can be unit-tested deterministically.
 */
export class CircuitBreaker {
  /** Every breaker registers here so the metrics layer can report their state on scrape. */
  private static readonly registry: CircuitBreaker[] = [];
  static all(): ReadonlyArray<CircuitBreaker> {
    return CircuitBreaker.registry;
  }

  private readonly logger = new Logger(CircuitBreaker.name);
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  readonly name: string;

  constructor(opts: CircuitBreakerOptions = {}, private readonly nowFn: () => number = Date.now) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.name = opts.name ?? 'circuit';
    CircuitBreaker.registry.push(this);
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Numeric state for gauges: 0 = CLOSED (healthy), 1 = HALF_OPEN (probing), 2 = OPEN (failing over). */
  stateCode(): number {
    return this.state === 'CLOSED' ? 0 : this.state === 'HALF_OPEN' ? 1 : 2;
  }

  /** Whether the call should be skipped right now (open and still cooling down). */
  private tripped(): boolean {
    if (this.state === 'OPEN') {
      if (this.nowFn() - this.openedAt >= this.cooldownMs) {
        this.state = 'HALF_OPEN'; // let a single trial call through
        return false;
      }
      return true;
    }
    return false;
  }

  private onSuccess(): void {
    if (this.state !== 'CLOSED') {
      this.logger.log(`[${this.name}] recovered — circuit CLOSED.`);
    }
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.threshold) {
      if (this.state !== 'OPEN') {
        this.logger.warn(`[${this.name}] opening circuit after ${this.failures} failure(s) — using fallback.`);
      }
      this.state = 'OPEN';
      this.openedAt = this.nowFn();
    }
  }

  /**
   * Run `fn`. If the circuit is open, skip it and run `fallback` immediately. A thrown error from `fn`
   * counts as a failure and also routes to `fallback`. `fn` may itself return a fallback value for a
   * "the service answered but had nothing" case without tripping the breaker — that still counts as a
   * success (the dependency is up).
   */
  async run<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.tripped()) {
      return fallback();
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch {
      this.onFailure();
      return fallback();
    }
  }
}
