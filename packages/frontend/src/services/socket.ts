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

export function isSocketConnected(): boolean {
  return !!socket?.connected;
}

export function getSocketToken(): string | null {
  return localStorage.getItem('fapoms_token');
}

export function connectSocket(): Socket | null {
  const token = getSocketToken();
  if (!token) return null;

  if (socket) return socket;

  socket = io(WS_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
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

export function subscribeToAssignment(assignmentId: string) {
  const s = getSocket();
  if (s?.connected) {
    s.emit('subscribe:assignment', assignmentId);
  }
}

export function unsubscribeFromAssignment(assignmentId: string) {
  const s = getSocket();
  if (s?.connected) {
    s.emit('unsubscribe:assignment', assignmentId);
  }
}
