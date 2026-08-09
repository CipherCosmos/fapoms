import { io, Socket } from 'socket.io-client';
import { MobileApiService } from './api.service';

let socket: Socket | null = null;

/**
 * Derived from the same origin the REST client uses, never hardcoded.
 *
 * This was pinned to `10.0.2.2` (the Android *emulator's* alias for the host loopback) and
 * ignored EXPO_PUBLIC_API_URL entirely — even though this file already imports
 * MobileApiService. On a real handset that address is unroutable, so the socket could never
 * connect from the field. Nothing surfaced the failure: the app silently fell back to its
 * 30-second poll, so "real-time" was permanently off for every physical device.
 *
 * Computed inside connectMobileSocket, not at module load. `getApiOrigin()` reads the mutable
 * API base URL, which is only finalised after the stored/on-device server override is applied
 * during startup — well after this module is first imported. A module-scope const captured the
 * pre-override default (the emulator alias), so on exactly the installs the server-settings
 * screen exists for, the socket dialled an unroutable address forever while REST worked.
 */

export function connectMobileSocket(): Socket | null {
  if (socket) return socket;

  const token = MobileApiService.getAuthToken();
  if (!token) return null;

  const wsUrl = `${MobileApiService.getApiOrigin()}/events`;
  socket = io(wsUrl, {
    // Read the token fresh on every (re)connection attempt — a static value here would
    // keep resending a token captured at connect time, which is wrong once it's refreshed.
    auth: (cb) => cb({ token: MobileApiService.getAuthToken() }),
    transports: ['websocket', 'polling'],
    reconnection: true,
    /**
     * Never stop trying.
     *
     * This was 10 attempts with a 5-second ceiling, so the socket gave up for good after
     * roughly a minute offline and stayed dead for the rest of the session. That is precisely
     * the field pattern: an assayer spends twenty minutes in a bank vault with no signal,
     * comes out, and the app has silently stopped receiving anything live until it is force
     * closed and reopened.
     */
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    // Backed off further so a long outage across a whole roster does not turn into every
    // handset retrying twelve times a minute against the same server.
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
  });

  socket.on('connect', () => {
    if (__DEV__) console.log('[MobileSocket] Connected:', socket?.id);
  });

  socket.on('disconnect', (reason) => {
    if (__DEV__) console.log('[MobileSocket] Disconnected:', reason);
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
