import { useEffect } from 'react';
import { queryClient } from '../queryClient';
import { connectSocket } from '../services/socket';
import { queryKeys } from './queryKeys';

/**
 * The desk views every assignment event has to refresh.
 *
 * Kept as one list because the failure was per-screen: `queryKeys.assignments.all` covered the
 * assignment list and missed the Operations Inbox, which is where negotiations are actually
 * worked. Naming them together makes "did we refresh the queue too?" a single decision instead of
 * one that has to be remembered at each of the six event rows below.
 */
const DESK_QUEUES = [
  queryKeys.desk.inbox,
  queryKeys.desk.inboxRecommendations,
  queryKeys.desk.assignmentDetail,
  queryKeys.desk.assignmentFieldIssues,
  queryKeys.desk.branchHistory,
];

const EVENT_KEYS: [string, ...any[]][] = [
  ['assignment:status-changed', queryKeys.assignments.all, ...DESK_QUEUES, queryKeys.dashboard.all, queryKeys.schedules.all, queryKeys.projects.all],
  ['assignment:counter-offered', queryKeys.assignments.all, ...DESK_QUEUES, queryKeys.dashboard.all, queryKeys.schedules.all, queryKeys.projects.all],
  ['assignment:created', queryKeys.assignments.all, ...DESK_QUEUES, queryKeys.dashboard.metrics, queryKeys.projects.all],
  ['assignment:fee-updated', queryKeys.assignments.all, ...DESK_QUEUES],
  // An assayer flagged a problem from the field — refresh the Field Issues queue and the
  // assignment views so the flag shows without a manual reload.
  ['assignment:issue-reported', queryKeys.assignments.fieldIssues, queryKeys.assignments.all, ...DESK_QUEUES, queryKeys.dashboard.all],
  ['assignment:escalated', queryKeys.assignments.all, ...DESK_QUEUES, queryKeys.dashboard.all],
  ['schedule:created', queryKeys.schedules.all, queryKeys.dashboard.all, queryKeys.assignments.all],
  ['schedule:updated', queryKeys.schedules.all, queryKeys.dashboard.all, queryKeys.assignments.all],
  ['ProjectCompleted', queryKeys.projects.all, queryKeys.dashboard.all],
  ['ProjectCancelled', queryKeys.projects.all, queryKeys.dashboard.all],
  ['ProjectPlanningStarted', queryKeys.projects.all, queryKeys.dashboard.all],
  ['document:uploaded', queryKeys.documents.all, queryKeys.documents.stats, queryKeys.schedules.all, queryKeys.assignments.all, queryKeys.projects.all],
  ['document:status-changed', queryKeys.documents.all, queryKeys.documents.stats, queryKeys.documents.dataEntry, queryKeys.schedules.all, queryKeys.assignments.all, queryKeys.projects.all],
  ['document:received', queryKeys.documents.all, queryKeys.documents.dataEntry, queryKeys.documents.stats, queryKeys.schedules.all, queryKeys.assignments.all, queryKeys.projects.all],
  ['client:created', queryKeys.clients.all, queryKeys.clients.list({})],
  ['client:updated', queryKeys.clients.all, queryKeys.clients.list({})],
  ['client:status-changed', queryKeys.clients.all, queryKeys.clients.list({})],
  ['billing:entry-created', queryKeys.billing.entries({}), queryKeys.billing.dashboard(undefined), queryKeys.billing.all],
  ['billing:entry-state-changed', queryKeys.billing.entries({}), queryKeys.billing.all, queryKeys.billing.dashboard(undefined)],
  ['billing:duplicate-detected', queryKeys.billing.conflicts(undefined), queryKeys.billing.all],
  ['billing:conflict-resolved', queryKeys.billing.conflicts(undefined), queryKeys.billing.all],
  ['billing:invoice-created', queryKeys.billing.invoices({}), queryKeys.billing.all],
  ['billing:invoice-status-changed', queryKeys.billing.invoices({}), queryKeys.billing.all],
  ['billing:payment-received', queryKeys.billing.invoices({}), queryKeys.billing.entries({}), queryKeys.billing.all],
  ['billing:payable-status-changed', queryKeys.billing.payables({}), queryKeys.billing.all],
];

export function useSocketInvalidation() {
  useEffect(() => {
    const socket = connectSocket();
    if (!socket) return;

    // Debounce invalidations. A burst of events (e.g. a bulk transition of 50 assignments fires 50
    // `assignment:status-changed`) would otherwise invalidate the same broad keys 50×, refetching the
    // active list and dashboard in a storm. Accumulating unique keys over a short window collapses the
    // burst into a single refetch — imperceptible to the user, far less load on client and server.
    const pending = new Map<string, any>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const keys = [...pending.values()];
      pending.clear();
      for (const key of keys) queryClient.invalidateQueries({ queryKey: key });
    };

    const handlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    for (const [event, ...keys] of EVENT_KEYS) {
      const handler = () => {
        for (const key of keys) pending.set(JSON.stringify(key), key);
        if (!timer) timer = setTimeout(flush, 300);
      };
      socket.on(event, handler);
      handlers.push({ event, handler });
    }

    return () => {
      if (timer) clearTimeout(timer);
      for (const { event, handler } of handlers) {
        socket.off(event, handler);
      }
    };
  }, []);
}
