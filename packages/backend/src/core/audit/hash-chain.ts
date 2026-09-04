import { createHash } from 'crypto';

/**
 * The tamper-evidence for the audit trail.
 *
 * `audit_events` is already append-only at the database (a BEFORE UPDATE OR DELETE trigger no
 * ownership can bypass). That stops the ordinary routes to rewriting history, but it cannot prove to
 * a bank auditor that history was NOT rewritten by someone with raw superuser access who could drop
 * the trigger. A hash chain can: each sealed event carries the SHA-256 of its own content plus the
 * previous sealed event's hash, so changing, deleting, inserting or reordering any event breaks
 * every hash after it, and the break is detectable by recomputing the chain. This is the
 * cryptographic layer ISO 27001 / SOC 2 and RBI forensic-evidence expectations ask for on top of
 * append-only storage.
 *
 * The chain lives in its own append-only ledger (`audit_chain`), written by a single-writer sealing
 * pass — never by touching `audit_events`, whose immutability therefore stays absolute. Both sealing
 * and verification call the functions here, so there is ONE canonical form: they cannot drift and
 * silently disagree, which would read as tampering on honest data.
 */

/** The hash the first sealed event links back to — a fixed, well-known starting point. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * The immutable content of an audit event that the chain commits to.
 *
 * Every meaningful column is included, so any change to any of them is detectable — not only state
 * transitions. `id` is included so a row cannot be swapped for another with identical content.
 */
export interface SealableEvent {
  id: string;
  category: string;
  eventType: string;
  entityType: string;
  entityId: string;
  previousState: string | null;
  newState: string | null;
  userId: string | null;
  userDisplayName: string | null;
  ipAddress: string | null;
  actorRole: string | null;
  userAgent: string | null;
  sessionId: string | null;
  requestId: string | null;
  outcome: string | null;
  remarks: string | null;
  metadata: unknown;
  before: unknown;
  after: unknown;
  occurredAt: Date;
}

/**
 * A deterministic string for a JSON-ish value, with object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, and a jsonb column read back through the driver does
 * not guarantee the same key order it was written in — so hashing the raw stringify would make an
 * honest round-trip look like tampering. Sorting keys removes that as a variable while still
 * committing to the full content.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The canonical, order-independent representation of one event's content.
 *
 * A record separator (unit-separator, 0x1f) joins the fields so that two different field
 * arrangements — `"a" , "bc"` vs `"ab" , "c"` — can never produce the same string, which a plain
 * concatenation would allow.
 */
export function canonicalEventString(e: SealableEvent): string {
  const RS = '';
  return [
    e.id,
    e.category,
    e.eventType,
    e.entityType,
    e.entityId,
    e.previousState ?? '',
    e.newState ?? '',
    e.userId ?? '',
    e.userDisplayName ?? '',
    e.ipAddress ?? '',
    e.actorRole ?? '',
    e.userAgent ?? '',
    e.sessionId ?? '',
    e.requestId ?? '',
    e.outcome ?? '',
    e.remarks ?? '',
    stableStringify(e.metadata ?? null),
    stableStringify(e.before ?? null),
    stableStringify(e.after ?? null),
    new Date(e.occurredAt).toISOString(),
  ].join(RS);
}

/**
 * The row hash for a sealed event: SHA-256 over the previous hash and this event's canonical form.
 *
 * Including `prevHash` is what makes it a chain rather than a set of independent checksums: it binds
 * each event to its position, so a deletion or reorder — which leaves each individual event's own
 * content untouched — still breaks the linkage.
 */
export function computeRowHash(prevHash: string, event: SealableEvent): string {
  return createHash('sha256')
    .update(prevHash)
    .update('')
    .update(canonicalEventString(event))
    .digest('hex');
}
