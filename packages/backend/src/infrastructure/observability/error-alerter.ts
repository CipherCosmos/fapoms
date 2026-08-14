import { Logger } from '@nestjs/common';

/**
 * Pushes a notification when the API starts failing, so a fault is noticed by someone rather than
 * waiting in a log for a person who has no reason to look.
 *
 * Every unexpected 500 was already written to the log with a correlation id. Nothing read it. The
 * upload fault that broke every scanned audit packet is the shape of the problem: it was plainly
 * visible in the request log for as long as it existed, and it was found only because somebody
 * eventually went looking by hand.
 *
 * **What is deliberately not sent.** The route, the HTTP method, the exception's class name and
 * the correlation id — never the exception message, never a stack, never a parameter. Messages on
 * this system routinely carry the data that caused them: a failing query includes its values, and
 * those values are bank customer records. The alert says where to look and under which correlation
 * id; the detail stays in the log on the host, where it is already access-controlled. That keeps a
 * webhook — a third party, over the public internet — from becoming a side channel for audit data.
 *
 * The transport is a plain HTTP POST, so it works with whatever the operator already uses (ntfy,
 * Slack, Discord, a self-hosted receiver) without this codebase taking a dependency on any of them
 * or anyone having to sign up for a service to make errors visible.
 */
export interface ErrorAlert {
  method: string;
  route: string;
  errorName: string;
  correlationId?: string;
}

/** Route with the varying parts removed, so the same fault on different records groups as one. */
export function alertKey(a: ErrorAlert): string {
  // Both forms collapse to the same placeholder. An identifier is an identifier: `/assignments/42`
  // and `/assignments/<uuid>` are one endpoint, and keying them apart would split a single fault
  // into two alerts. `/api/v1/` survives because the digit there follows a letter, not a slash.
  const generic = a.route
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
  return `${a.method} ${generic} ${a.errorName}`;
}

export class ErrorAlerter {
  private readonly logger = new Logger('ErrorAlerter');
  /** key → when it was last sent, and how many have been swallowed since. */
  private readonly seen = new Map<string, { lastSentAt: number; suppressed: number }>();
  private windowStartedAt = 0;
  private sentThisWindow = 0;

  constructor(
    private readonly url = process.env.ALERT_WEBHOOK_URL,
    private readonly windowMs = 15 * 60 * 1000,
    /**
     * A ceiling across all keys. A database falling over produces a distinct failure on every
     * route at once, and an alerter that faithfully reports each one buries the signal it exists
     * to deliver — and can get the receiver to rate-limit the operator out of their own alerts.
     */
    private readonly maxPerWindow = 10,
    private readonly post: (url: string, body: string) => Promise<void> = defaultPost,
  ) {}

  get enabled(): boolean {
    return Boolean(this.url);
  }

  /**
   * Fire-and-forget. Never throws and never returns a promise the caller has to handle: this runs
   * inside the exception filter, and an alerter that can fail the error path is worse than no
   * alerter at all.
   */
  report(alert: ErrorAlert, now: number = Date.now()): void {
    if (!this.url) return;

    try {
      if (now - this.windowStartedAt >= this.windowMs) {
        this.windowStartedAt = now;
        this.sentThisWindow = 0;
      }

      const key = alertKey(alert);
      const prior = this.seen.get(key);

      // The same fault repeating is one fact, not a hundred. It is reported once per window, and
      // the count of what was held back rides along with the next one so the volume is not lost.
      if (prior && now - prior.lastSentAt < this.windowMs) {
        prior.suppressed += 1;
        return;
      }

      if (this.sentThisWindow >= this.maxPerWindow) {
        return;
      }

      const repeats = prior?.suppressed ?? 0;
      this.seen.set(key, { lastSentAt: now, suppressed: 0 });
      this.sentThisWindow += 1;

      const text =
        `FAPOMS 500: ${alert.method} ${alert.route}\n` +
        `${alert.errorName}` +
        (alert.correlationId ? `\ncorrelation: ${alert.correlationId}` : '') +
        (repeats ? `\n(+${repeats} more since the last alert)` : '');

      void this.post(this.url, text).catch((err) =>
        this.logger.warn(`could not deliver alert: ${err?.message ?? err}`),
      );
    } catch (err: any) {
      this.logger.warn(`alerter failed: ${err?.message ?? err}`);
    }
  }
}

/**
 * Plain text body with a short timeout. Slack and Discord accept JSON rather than text, so an
 * operator using those points this at a small relay or uses ntfy, which takes the body as-is —
 * the alternative is this file growing a per-vendor payload format for each one.
 */
async function defaultPost(url: string, body: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Title: 'FAPOMS error' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** One instance for the process; the filter is constructed by hand, outside the DI container. */
export const errorAlerter = new ErrorAlerter();
