/**
 * What a push means: what to refresh when it arrives (possibly with the app closed), and where a
 * tap on it should land.
 *
 * Two payload shapes are understood:
 *  - the one the server sends today (`NotificationDeliveryWorker`): { notificationId, type,
 *    category, entityType, entityId, link, priority };
 *  - the silent data push the server sends on every job change:
 *    { type: 'refresh', scope: 'assignments', assignmentId? } — no notification, just a refresh.
 * And the several envelopes the payload arrives in (FCM data map, expo's background-task `data`,
 * a JSON string in `body`/`dataString`, a tapped notification's `request.content.data`).
 *
 * Pure, for node tests.
 */

export interface PushData {
  type?: string;
  /** For `type: 'refresh'`: what to refresh (`assignments`). */
  scope?: string;
  category?: string;
  notificationId?: string;
  assignmentId?: string;
  queryId?: string;
  link?: string;
}

export type TapTarget =
  | { tab: 'Today'; assignmentId?: string; queryId?: string }
  | { tab: 'Money' }
  | { tab: 'Me' };

export interface PushPlan {
  /** Re-read the job list (offers, schedule changes, queries ride on the job). */
  refreshJobs: boolean;
  /** A silent refresh push: nothing was shown, so there is nothing to tap. */
  silent?: boolean;
  /** Where a tap goes. */
  target: TapTarget;
  notificationId?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const KNOWN_KEYS = ['type', 'scope', 'category', 'notificationId', 'assignmentId', 'queryId', 'entityId', 'link'];

/** Dig the app's own fields out of whatever envelope the OS / library wrapped them in. */
export function extractPushData(raw: unknown): PushData | null {
  const queue: unknown[] = [raw];
  const seen = new Set<unknown>();
  for (let depth = 0; queue.length && depth < 24; depth++) {
    const node = asRecord(queue.shift());
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (KNOWN_KEYS.some((k) => str(node[k]))) {
      const entityType = str(node.entityType)?.toUpperCase();
      const entityId = str(node.entityId);
      const link = str(node.link);
      let assignmentId = str(node.assignmentId);
      let queryId = str(node.queryId);
      if (!assignmentId && entityId && (!entityType || entityType.includes('ASSIGNMENT'))) assignmentId = entityId;
      if (!queryId && entityId && entityType?.includes('QUERY')) queryId = entityId;
      const fromLink = link?.match(/^\/assignments\/([^/?#]+)/)?.[1];
      if (!assignmentId && fromLink) assignmentId = fromLink;
      return {
        type: str(node.type),
        scope: str(node.scope),
        category: str(node.category),
        notificationId: str(node.notificationId),
        assignmentId,
        queryId,
        link,
      };
    }
    for (const key of ['data', 'body', 'dataString', 'notification', 'request', 'content', 'payload']) {
      if (node[key] !== undefined) queue.push(node[key]);
    }
  }
  return null;
}

export function planForPush(data: PushData | null): PushPlan {
  if (!data) return { refreshJobs: false, target: { tab: 'Today' } };
  const link = data.link ?? '';
  const category = (data.category ?? '').toUpperCase();
  const type = (data.type ?? '').toUpperCase();
  const base = { notificationId: data.notificationId };

  // The server's silent change signal. Any scope this build does not know still refreshes the
  // job list: refreshing too often costs one request; missing a change costs a wrong screen.
  if (type === 'REFRESH') {
    return {
      ...base,
      refreshJobs: true,
      silent: true,
      target: { tab: 'Today', ...(data.assignmentId ? { assignmentId: data.assignmentId } : {}) },
    };
  }

  if (link.startsWith('/earnings') || category === 'BILLING' || type.includes('INVOICE') || type.includes('PAYOUT')) {
    return { ...base, refreshJobs: false, target: { tab: 'Money' } };
  }
  if (link.startsWith('/profile') || type.includes('DOCUMENT_REUPLOAD') || type.includes('PROFILE')) {
    return { ...base, refreshJobs: false, target: { tab: 'Me' } };
  }
  if (data.assignmentId || data.queryId || type.includes('ASSIGNMENT') || type.includes('QUERY') || type === 'ARRIVAL') {
    return {
      ...base,
      // An arrival notice is raised by the phone itself; the list is already current.
      refreshJobs: type !== 'ARRIVAL',
      target: { tab: 'Today', ...(data.assignmentId ? { assignmentId: data.assignmentId } : {}), ...(data.queryId ? { queryId: data.queryId } : {}) },
    };
  }
  return { ...base, refreshJobs: false, target: { tab: 'Today' } };
}
