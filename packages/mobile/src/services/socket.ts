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
    // Read the token fresh on every (re)connection attempt — a static value here would
    // keep resending a token captured at connect time, which is wrong once it's refreshed.
    auth: (cb) => cb({ token: MobileApiService.getAuthToken() }),
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

  socket.on('error', async (err) => {
    console.error('[MobileSocket] Error:', err);
    // The server disconnects the socket on auth failure, and socket.io does not
    // auto-retry a server-initiated disconnect. Refresh the access token and
    // reconnect explicitly, instead of leaving the socket dead until next app launch.
    if (err?.message === 'Invalid or expired token' || err?.message === 'Authentication required') {
      const refreshed = await MobileApiService.tryRefresh();
      if (refreshed) {
        socket?.connect();
      }
    }
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
