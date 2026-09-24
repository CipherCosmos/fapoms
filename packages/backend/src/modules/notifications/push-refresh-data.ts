/**
 * The ids the field app needs to refresh ONE item in the background when a push arrives, carried in
 * the FCM `data` block beside the keys it already had (`notificationId`, `type`, `entityType`,
 * `entityId`, `link`, …). Additive: a key is added only when there is an id to put in it, so an
 * installed app that ignores them sees nothing new.
 *
 *  - `assignmentId`: the notification's own entity when it is an ASSIGNMENT, otherwise the
 *    `assignmentId` its emit payload carried (SCHEDULE_* and VALIDATION_QUERY_* emits both do).
 *  - `queryId`: the entity when it is a VALIDATION_QUERY, otherwise the payload's `queryId`
 *    (CALL_MISSED is keyed on the query too).
 *
 * FCM `data` values must be strings, so anything that is not a non-empty string is dropped.
 */
export function pushRefreshData(notification: {
  entityType?: string | null;
  entityId?: string | null;
  payload?: Record<string, unknown> | null;
}): { assignmentId?: string; queryId?: string } {
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  const out: { assignmentId?: string; queryId?: string } = {};
  const assignmentId = notification.entityType === 'ASSIGNMENT'
    ? text(notification.entityId)
    : text(notification.payload?.assignmentId);
  const queryId = notification.entityType === 'VALIDATION_QUERY'
    ? text(notification.entityId)
    : text(notification.payload?.queryId);
  if (assignmentId) out.assignmentId = assignmentId;
  if (queryId) out.queryId = queryId;
  return out;
}
