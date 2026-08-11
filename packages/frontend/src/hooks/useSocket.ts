import { useEffect, useRef, useCallback } from 'react';
import { connectSocket, getSocket } from '../services/socket';

type EventHandler = (data: any) => void;

export function useSocket() {
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());

  useEffect(() => {
    connectSocket();
  }, []);

  useEffect(() => {
    const s = getSocket();
    if (!s) return;

    const handlerMap = handlersRef.current;

    const listener = (event: string, data: any) => {
      const handlers = handlerMap.get(event);
      if (handlers) {
        handlers.forEach((fn) => fn(data));
      }
    };

    s.onAny(listener);
    return () => {
      s.offAny(listener);
    };
  }, []);

  const on = useCallback((event: string, handler: EventHandler) => {
    if (!handlersRef.current.has(event)) {
      handlersRef.current.set(event, new Set());
    }
    handlersRef.current.get(event)!.add(handler);
    return () => {
      handlersRef.current.get(event)?.delete(handler);
    };
  }, []);

  const subscribeAssignment = useCallback((assignmentId: string) => {
    const s = getSocket();
    s?.emit('subscribe:assignment', assignmentId);
  }, []);

  const unsubscribeAssignment = useCallback((assignmentId: string) => {
    const s = getSocket();
    s?.emit('unsubscribe:assignment', assignmentId);
  }, []);

  return { on, subscribeAssignment, unsubscribeAssignment, getSocket };
}
