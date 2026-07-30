import { io, Socket } from 'socket.io-client';

const WS_URL = import.meta.env.VITE_WS_URL || '/events';

let socket: Socket | null = null;

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
  });

  socket.on('disconnect', (reason: string) => {
    console.log('[Socket] Disconnected:', reason);
  });

  socket.on('error', (err: any) => {
    console.error('[Socket] Error:', err);
  });

  socket.on('connected', (data: { userId: string }) => {
    console.log('[Socket] Authenticated:', data.userId);
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
