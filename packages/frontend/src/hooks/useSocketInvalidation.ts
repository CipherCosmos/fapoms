import { useEffect } from 'react';
import { queryClient } from '../queryClient';
import { connectSocket } from '../services/socket';
import { queryKeys } from './queryKeys';

const EVENT_KEYS: [string, ...any[]][] = [
  ['assignment:status-changed', queryKeys.assignments.all, queryKeys.dashboard.all, queryKeys.schedules.all, queryKeys.projects.all],
  ['assignment:counter-offered', queryKeys.assignments.all, queryKeys.dashboard.all, queryKeys.schedules.all, queryKeys.projects.all],
  ['assignment:created', queryKeys.assignments.all, queryKeys.dashboard.metrics, queryKeys.projects.all],
  ['assignment:fee-updated', queryKeys.assignments.all],
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

    const handlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    for (const [event, ...keys] of EVENT_KEYS) {
      const handler = () => {
        for (const key of keys) {
          queryClient.invalidateQueries({ queryKey: key as any });
        }
      };
      socket.on(event, handler);
      handlers.push({ event, handler });
    }

    return () => {
      for (const { event, handler } of handlers) {
        socket.off(event, handler);
      }
    };
  }, []);
}
