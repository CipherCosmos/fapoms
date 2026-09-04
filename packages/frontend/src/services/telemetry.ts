/**
 * UI interaction telemetry — the client side of the "click by click" trail.
 *
 * Privacy-first by construction: it sends DESCRIPTORS, never data. A page view is a route; an action
 * is the label on the control that was used (its `data-track`, aria-label, or short button text) —
 * never the contents of a field, and never the value inside a record. The backend scrubs anything
 * PII-shaped that slips through anyway, but the first line of defence is not collecting it here.
 *
 * Events are queued and flushed in batches (on an interval, when the queue fills, and when the tab
 * is hidden) so this costs one small request now and then, not one per click. It is entirely
 * best-effort: a failed flush is dropped silently — telemetry must never affect the app a user is
 * actually trying to use, nor its error surface.
 */

export interface TelemetryEvent {
  eventType: 'PAGE_VIEW' | 'ACTION' | 'FILTER' | 'SEARCH' | 'ERROR';
  path?: string;
  label?: string;
  meta?: Record<string, string | number | boolean>;
}

const FLUSH_INTERVAL_MS = 15_000;
const MAX_QUEUE = 50;
const LABEL_MAX = 80;

let queue: TelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function token(): string | null {
  try {
    return localStorage.getItem('fapoms_token');
  } catch {
    return null;
  }
}

/** Queue one event. No-op when signed out — telemetry belongs to an authenticated session. */
export function track(event: TelemetryEvent): void {
  if (!token()) return;
  queue.push(event);
  if (queue.length >= MAX_QUEUE) {
    void flushTelemetry();
  } else if (!timer) {
    timer = setTimeout(() => void flushTelemetry(), FLUSH_INTERVAL_MS);
  }
}

export function trackPageView(path: string): void {
  track({ eventType: 'PAGE_VIEW', path });
}

/**
 * Send the queued events. Uses a bare fetch with the bearer token rather than the shared api client
 * on purpose: telemetry must not ride the client's refresh-on-401 retry machinery (a storm of
 * analytics posts must never be able to trigger a token refresh loop), and its failures must stay
 * invisible.
 */
export async function flushTelemetry(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const t = token();
  if (!t || queue.length === 0) return;
  const events = queue.splice(0, MAX_QUEUE);
  try {
    await fetch('/api/v1/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ events }),
      keepalive: true, // let an in-flight flush survive a tab being hidden/closed
    });
  } catch {
    // Analytics is expendable: never surface, never retry into a loop.
  }
}

/**
 * A short, PII-free descriptor for a clicked element. Prefers an explicit `data-track`, then an
 * accessible name, then trimmed button/link text — and only for actual controls, so ordinary text
 * (which is where record contents live) is never captured. Returns null when there is nothing safe
 * and meaningful to record.
 */
export function describeClickTarget(el: Element | null): string | null {
  const control = el?.closest('[data-track],button,a,[role="button"],[role="tab"]');
  if (!control) return null;
  const explicit = control.getAttribute('data-track');
  if (explicit) return explicit.slice(0, LABEL_MAX);
  const aria = control.getAttribute('aria-label');
  if (aria) return aria.trim().slice(0, LABEL_MAX);
  const text = (control.textContent || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, LABEL_MAX) : null;
}
