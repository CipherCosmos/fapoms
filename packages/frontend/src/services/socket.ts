import { io, Socket } from 'socket.io-client';

const WS_URL = import.meta.env.VITE_WS_URL || '/events';

let socket: Socket | null = null;

type ConnectionListener = (connected: boolean) => void;
const connectionListeners = new Set<ConnectionListener>();

function emitConnection(connected: boolean) {
  connectionListeners.forEach((cb) => cb(connected));
}

/** Subscribe to live-socket connection state. Returns an unsubscribe function. */
export function subscribeToConnection(cb: ConnectionListener): () => void {
  connectionListeners.add(cb);
  cb(isSocketConnected());
  return () => { connectionListeners.delete(cb); };
}

function isSocketConnected(): boolean {
  return !!socket?.connected;
}

function getSocketToken(): string | null {
  return localStorage.getItem('fapoms_token');
}

export function connectSocket(): Socket | null {
  const token = getSocketToken();
  if (!token) return null;

  if (socket) return socket;

  socket = io(WS_URL, {
    /**
     * Read fresh on every (re)connection attempt.
     *
     * `auth: { token }` captures the token once, at connect time. After the access token
     * rotates, every reconnection keeps presenting the old one and the server rejects it — so
     * a desk session that has been open past one token lifetime silently stops receiving
     * live updates and only recovers on a full page reload. The mobile client was fixed for
     * this; the web client was not.
     */
    auth: (cb: (data: { token: string | null }) => void) => cb({ token: getSocketToken() }),
    transports: ['websocket', 'polling'],
    reconnection: true,
    /**
     * Never give up. Ten attempts with a 5-second ceiling meant the socket died for good
     * after about a minute — a closed laptop lid, a Wi-Fi switch or a brief VPN drop was
     * enough to leave an operations desk looking at a screen that had quietly stopped
     * updating, with nothing on it saying so.
     */
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
  });

  socket.on('connect', () => {
    console.log('[Socket] Connected:', socket?.id);
    emitConnection(true);
  });

  socket.on('disconnect', (reason: string) => {
    console.log('[Socket] Disconnected:', reason);
    emitConnection(false);
  });

  socket.on('error', (err: any) => {
    console.error('[Socket] Error:', err);
    emitConnection(false);
  });

  socket.on('connected', (data: { userId: string }) => {
    console.log('[Socket] Authenticated:', data.userId);
    emitConnection(true);
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function getSocket(): Socket | null {
  return socket;
}
