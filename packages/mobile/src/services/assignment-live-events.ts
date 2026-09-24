/**
 * Which live (socket) events move the assayer's job list, and so trigger a quiet reload of it.
 * Pure, for the node tests: a name here that the server never emits is a listener for nothing,
 * and a name the server does emit that is missing here is a screen that only updates on pull.
 *
 * Checked against `events.gateway.ts` (2026-09-24):
 *  - `query:raised` / `query:responded` / `query:message` — a desk clarification on one of their
 *    jobs;
 *  - `document:received` / `document:uploaded` / `document:status-changed` — papers moving (the
 *    server is adding delivery of these to the assayer's own room);
 *  - `schedule:created` / `schedule:updated` — the job's date or plan changed;
 *  - `expense:decided` — a claim on a job was approved or refused (claims ride on the job rows);
 *  - `assignment:reassigned` — a job moved to or away from this assayer.
 *
 * Deliberately NOT here: `query:resolved` and `document:dispatched` (no server code emits either;
 * resolution arrives as `query:responded`, dispatch as a notification), `assignment:counter-offered`,
 * `assignment:fee-updated` and `billing:created` (see `AssignmentContext`).
 */
export const QUIET_RELOAD_EVENTS: readonly string[] = [
  'query:raised',
  'query:responded',
  'query:message',
  'document:received',
  'document:uploaded',
  'document:status-changed',
  'schedule:created',
  'schedule:updated',
  'expense:decided',
  'assignment:reassigned',
];

/** Notification types that mean a job left (or changed under) this assayer. */
const JOB_MOVING_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'ASSIGNMENT_REASSIGNED_AWAY',
  'ASSIGNMENT_CANCELLED',
  'ASSIGNMENT_REOPENED',
]);

/**
 * Does a `notification:new` payload mean the job list is out of date? True for a job taken away,
 * cancelled or reopened — the type may ride as `type`, `notificationType` or `data.type`,
 * depending on which server path raised it.
 */
export function notificationMovesJobs(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const data = (p.data && typeof p.data === 'object' ? p.data : {}) as Record<string, unknown>;
  const candidates = [p.type, p.notificationType, data.type];
  return candidates.some((c) => typeof c === 'string' && JOB_MOVING_NOTIFICATIONS.has(c));
}
