import { useEffect, useState } from 'react';
import { connectSocket, subscribeToConnection } from '../services/socket';

/**
 * Reactively exposes the live-socket connection state so UI can show a
 * "live / offline" indicator. Ensures the socket is initialised on first use
 * (only connects when a token is present).
 */
export function useSocketConnection(): boolean {
  const [connected, setConnected] = useState<boolean>(false);

  useEffect(() => {
    connectSocket();
    const unsubscribe = subscribeToConnection(setConnected);
    return unsubscribe;
  }, []);

  return connected;
}
