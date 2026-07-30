import { io, Socket } from 'socket.io-client';
import { Platform } from 'react-native';
import { MobileApiService } from './api.service';

let socket: Socket | null = null;

const API_BASE = Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000';
const WS_URL = `${API_BASE}/events`;

export function connectMobileSocket(): Socket | null {
  if (socket) return socket;

  const token = MobileApiService.getAuthToken();
  if (!token) return null;

  socket = io(WS_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect', () => {
    console.log('[MobileSocket] Connected:', socket?.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('[MobileSocket] Disconnected:', reason);
  });

  socket.on('error', (err) => {
    console.error('[MobileSocket] Error:', err);
  });

  return socket;
}

export function disconnectMobileSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function getMobileSocket(): Socket | null {
  return socket;
}

export function subscribeToAssignmentMobile(assignmentId: string) {
  const s = getMobileSocket();
  if (s?.connected) {
    s.emit('subscribe:assignment', assignmentId);
  }
}

export function unsubscribeFromAssignmentMobile(assignmentId: string) {
  const s = getMobileSocket();
  if (s?.connected) {
    s.emit('unsubscribe:assignment', assignmentId);
  }
}
