/**
 * Defense-in-depth PII scrubbing for UI telemetry.
 *
 * Telemetry is meant to carry descriptors, not data — the client sends an action's label and the
 * route, never a field's contents. But "meant to" is not "guaranteed to": a label built from a
 * record's name, or a search term someone typed, can carry personal data by accident. So every
 * string that reaches the telemetry store is run through this first, and anything PII-shaped is
 * redacted to a placeholder. It is intentionally aggressive — a false redaction costs nothing on
 * analytics data, while a leaked Aadhaar in a "click" log is exactly the kind of thing DPDP's
 * data-minimisation rule exists to prevent.
 */

// Unanchored, global — these FIND PII inside free text, unlike the anchored whole-string validators
// in @fapoms/shared. Order matters: the more specific shapes run before the generic digit run.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PAN = /\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g;
const IFSC = /\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b/g;
// 10+ consecutive digits: phone (10), Aadhaar (12), bank account — anything that long in a UI label
// is not a legitimate descriptor.
const LONG_DIGITS = /\d{10,}/g;

const MAX_STRING = 160;

/** Redact PII-shaped substrings from one string and cap its length. */
export function scrubPii(value: string): string {
  const redacted = value
    .replace(EMAIL, '[email]')
    .replace(PAN, '[id]')
    .replace(IFSC, '[ifsc]')
    .replace(LONG_DIGITS, '[number]');
  return redacted.length > MAX_STRING ? redacted.slice(0, MAX_STRING) : redacted;
}

/** The events telemetry accepts. A closed set — anything else is dropped at ingestion. */
export const TELEMETRY_EVENT_TYPES = ['PAGE_VIEW', 'ACTION', 'FILTER', 'SEARCH', 'ERROR'] as const;
export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export interface RawTelemetryEvent {
  eventType?: string;
  path?: string;
  label?: string;
  meta?: Record<string, unknown>;
}

export interface CleanTelemetryEvent {
  eventType: TelemetryEventType;
  path: string | null;
  label: string | null;
  metadata: Record<string, unknown> | null;
}

const MAX_META_KEYS = 12;

/**
 * Sanitize one client-supplied event, or return null to drop it.
 *
 * Drops anything whose type is not on the allowlist; scrubs the label and path; and for metadata,
 * keeps only primitive values (strings scrubbed, objects/arrays dropped so nothing large or nested
 * can smuggle data through) up to a small key cap.
 */
export function sanitizeTelemetryEvent(raw: RawTelemetryEvent): CleanTelemetryEvent | null {
  const eventType = raw?.eventType as TelemetryEventType;
  if (!TELEMETRY_EVENT_TYPES.includes(eventType)) return null;

  const label = typeof raw.label === 'string' && raw.label.trim() ? scrubPii(raw.label.trim()) : null;
  const path = typeof raw.path === 'string' && raw.path.trim() ? scrubPii(raw.path.trim()) : null;

  let metadata: Record<string, unknown> | null = null;
  if (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) {
    const out: Record<string, unknown> = {};
    let keys = 0;
    for (const [k, v] of Object.entries(raw.meta)) {
      if (keys >= MAX_META_KEYS) break;
      if (typeof v === 'number' || typeof v === 'boolean') {
        out[k] = v;
        keys++;
      } else if (typeof v === 'string') {
        out[k] = scrubPii(v);
        keys++;
      }
      // objects, arrays, null, functions: dropped — telemetry meta is flat primitives only.
    }
    if (keys > 0) metadata = out;
  }

  return { eventType, path, label, metadata };
}
