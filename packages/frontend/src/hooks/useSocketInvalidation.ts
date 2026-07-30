import { useEffect } from 'react';
import { queryClient } from '../queryClient';
import { connectSocket } from '../services/socket';
import { queryKeys } from './queryKeys';

const EVENT_KEYS: [string, ...any[]][] = [
  ['assignment:status-changed', queryKeys.assignments.all, queryKeys.dashboard.all, queryKeys.schedules.all, queryKeys.projects.all],
  ['assignment:counter-offered', queryKeys.assignments.all, queryKeys.dashboard.all, queryKeys.schedules.all, queryKeys.projects.all],
  ['assignment:created', queryKeys.assignments.all, queryKeys.dashboard.metrics, queryKeys.projects.all],
  ['assignment:fee-updated', queryKeys.assignments.all],
  ['schedule:created', queryKeys.schedules.all, queryKeys.dashboard.all],
  ['schedule:updated', queryKeys.schedules.all, queryKeys.dashboard.all],
  ['ProjectCompleted', queryKeys.projects.all, queryKeys.dashboard.all],
  ['ProjectCancelled', queryKeys.projects.all, queryKeys.dashboard.all],
  ['ProjectPlanningStarted', queryKeys.projects.all, queryKeys.dashboard.all],
  ['document:uploaded', queryKeys.documents.all, queryKeys.documents.stats],
  ['document:status-changed', queryKeys.documents.all, queryKeys.documents.stats, queryKeys.documents.dataEntry],
  ['document:received', queryKeys.documents.all, queryKeys.documents.dataEntry, queryKeys.documents.stats],
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
