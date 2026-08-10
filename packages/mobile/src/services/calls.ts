/**
 * In-app voice calling — service layer.
 *
 * Everything native lives behind a guarded, lazy require. The app must still boot and run in
 * plain Expo Go, where @livekit/react-native's native module does not exist: there,
 * `initializeCalling()` fails quietly, `callingAvailable` stays false, and every call button
 * in the UI is hidden. In the dev-client / production build the module is present, the
 * WebRTC globals get registered before anything uses them, and calling lights up.
 *
 * REST contract (responses are `{success, data}` like everything else):
 *   GET  /calls/config              → { url }
 *   POST /calls/initiate {queryId}  → { roomName, url, token, rejoined }
 *   POST /calls/answer  {roomName}  → { roomName, url, token }
 *   POST /calls/decline {roomName}  → { ok }
 *   POST /calls/hangup  {roomName}  → { ok }
 *
 * Socket events (subscribed in App.tsx, forwarded to the handlers at the bottom):
 *   call:incoming / call:answered / call:ended
 */
import { MobileApiService } from './api.service';

// ─────────────────────────────────────────────── Native module, guarded

/** The @livekit/react-native module, or null when running somewhere it doesn't exist. */
let livekit: any = null;
/** The livekit-client module (Room lives here), loaded alongside the native module. */
let livekitClient: any = null;

/**
 * True only when the native WebRTC module loaded and its globals are registered.
 * The UI consults this to decide whether call buttons exist at all.
 */
export let callingAvailable = false;

/**
 * Register the WebRTC globals. MUST run at the entry point, before anything else touches
 * WebRTC — and MUST NOT crash the app when the native module is absent (Expo Go), which is
 * why the require and the registerGlobals call are both inside the try.
 */
export function initializeCalling(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lk = require('@livekit/react-native');
    lk.registerGlobals();
    // Room/connect come from livekit-client, which needs the globals registered above.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    livekitClient = require('livekit-client');
    livekit = lk;
    callingAvailable = true;
  } catch {
    // Expo Go, web, or a build without the native module: calling is simply absent.
    livekit = null;
    livekitClient = null;
    callingAvailable = false;
  }
}

export function isCallingAvailable(): boolean {
  return callingAvailable;
}

// ─────────────────────────────────────────────── URL normalisation

/**
 * The backend hands out a RELATIVE signaling path (`/livekit`): the app connects to the
 * same API origin it already talks REST to (which encodes the 10.0.2.2 emulator rule and
 * the operator-configured LAN address), and the backend pipes the WebSocket to the SFU.
 * The device never contacts LiveKit directly. Legacy absolute `localhost` URLs are still
 * rewritten to the API host; any other absolute URL passes through.
 */
export function normalizeLiveKitUrl(rawUrl: string): string {
  if (rawUrl.startsWith('/')) {
    return `${MobileApiService.getApiOrigin()}${rawUrl}`;
  }
  // Regex rather than `new URL`: Hermes' URL implementation is incomplete, and this must
  // never be the thing that breaks a call. Preserves scheme, port and path.
  const localhost = /^(\w+:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/i;
  if (!localhost.test(rawUrl)) return rawUrl;
  const apiHost = MobileApiService.getApiOrigin().match(/^\w+:\/\/([^/:]+)/)?.[1];
  if (!apiHost) return rawUrl;
  return rawUrl.replace(localhost, (_m, scheme: string) => `${scheme}${apiHost}`);
}

// ─────────────────────────────────────────────── Call state store

export type CallPhase =
  | 'idle'
  /** Someone is calling us; the incoming UI is ringing. */
  | 'incoming'
  /** We initiated; connected to the room but the other side hasn't answered. */
  | 'outgoing'
  /** Momentary: a REST call + room connect is in flight. */
  | 'connecting'
  /** Both sides in the room. */
  | 'active';

export interface CallState {
  phase: CallPhase;
  roomName: string | null;
  queryId: string | null;
  /** Who we're talking to — desk caller name for incoming, "Data Entry Team" outgoing. */
  peerName: string;
  /** The clarification this call is about, shown for context. */
  queryText: string;
  /** Epoch ms when the call went active; drives the mm:ss timer. */
  connectedAt: number | null;
  muted: boolean;
  speakerOn: boolean;
}

const IDLE: CallState = {
  phase: 'idle',
  roomName: null,
  queryId: null,
  peerName: '',
  queryText: '',
  connectedAt: null,
  muted: false,
  speakerOn: false,
};

let state: CallState = IDLE;
const listeners = new Set<() => void>();

function setState(patch: Partial<CallState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getCallState(): CallState {
  return state;
}

export function subscribeToCallState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ─────────────────────────────────────────────── Room lifecycle

/** The live LiveKit Room instance while a call exists. Typed loose: the class is only
 *  reachable through the guarded module. */
let room: any = null;

async function startAudio(): Promise<void> {
  try {
    await livekit?.AudioSession?.startAudioSession?.();
  } catch {
    // Audio session tuning is best-effort; the call still works on defaults.
  }
}

async function stopAudio(): Promise<void> {
  try {
    await livekit?.AudioSession?.stopAudioSession?.();
  } catch {
    /* already stopped */
  }
}

async function connectRoom(url: string, token: string): Promise<void> {
  if (!livekit || !livekitClient) throw new Error('Calling is not available in this build.');
  await startAudio();
  const RoomCtor = livekitClient.Room;
  room = new RoomCtor({ adaptiveStream: true, dynacast: true });
  await room.connect(normalizeLiveKitUrl(url), token);
  await room.localParticipant.setMicrophoneEnabled(true);
}

async function teardownRoom(): Promise<void> {
  const r = room;
  room = null;
  if (r) {
    try {
      await r.disconnect();
    } catch {
      /* already gone */
    }
  }
  await stopAudio();
}

/** Full reset: leaves the room (if any) and returns the UI to idle. */
export async function resetCall(): Promise<void> {
  await teardownRoom();
  state = IDLE;
  listeners.forEach((l) => l());
}

// ─────────────────────────────────────────────── REST helpers

async function post(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await MobileApiService.fetchWithAuth(
    `${MobileApiService.getBaseUrl()}${path}`,
    { method: 'POST', body: JSON.stringify(body) },
    10000,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(data?.message || `Call request failed (${res.status})`);
  }
  return data?.data ?? data;
}

/** The LiveKit server address, host-corrected for this device. Null when unreachable. */
export async function getCallConfig(): Promise<{ url: string } | null> {
  try {
    const res = await MobileApiService.fetchWithAuth(
      `${MobileApiService.getBaseUrl()}/calls/config`,
      {},
      10000,
    );
    const data = await res.json().catch(() => ({}));
    const url = res.ok && data?.success !== false ? data?.data?.url : null;
    return url ? { url: normalizeLiveKitUrl(url) } : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────── Public actions

/**
 * Assayer taps Call on a query: create/join the room and ring the desk.
 * Resolves once we're in the room ("Ringing…"); the `call:answered` socket event moves the
 * UI to in-call.
 */
export async function startCall(opts: {
  queryId: string;
  peerName?: string;
  queryText?: string;
}): Promise<void> {
  if (!callingAvailable) throw new Error('Calling is not available in this build.');
  if (state.phase !== 'idle') throw new Error('A call is already in progress.');

  setState({
    phase: 'connecting',
    queryId: opts.queryId,
    peerName: opts.peerName || 'Data Entry Team',
    queryText: opts.queryText || '',
    muted: false,
    speakerOn: false,
  });
  try {
    const data = await post('/calls/initiate', { queryId: opts.queryId });
    setState({ roomName: data.roomName });
    await connectRoom(data.url, data.token);
    // Rejoining a call that is already live skips the ringing phase.
    if (data.rejoined) {
      setState({ phase: 'active', connectedAt: Date.now() });
    } else {
      setState({ phase: 'outgoing' });
    }
  } catch (err) {
    await resetCall();
    throw err;
  }
}

/** Accept the ringing incoming call. */
export async function acceptCall(): Promise<void> {
  if (!callingAvailable || state.phase !== 'incoming' || !state.roomName) return;
  const roomName = state.roomName;
  setState({ phase: 'connecting' });
  try {
    const data = await post('/calls/answer', { roomName });
    await connectRoom(data.url, data.token);
    setState({ phase: 'active', connectedAt: Date.now() });
  } catch (err) {
    await resetCall();
    throw err;
  }
}

/** Decline the ringing incoming call. */
export async function declineCall(): Promise<void> {
  const roomName = state.roomName;
  await resetCall();
  if (roomName) {
    try {
      await post('/calls/decline', { roomName });
    } catch {
      // The server will time the call out as missed regardless.
    }
  }
}

/** Hang up an outgoing/active call. */
export async function hangupCall(): Promise<void> {
  const roomName = state.roomName;
  await resetCall();
  if (roomName) {
    try {
      await post('/calls/hangup', { roomName });
    } catch {
      // We already left the room; the server reconciles.
    }
  }
}

/** Mute / unmute the microphone. */
export async function toggleMute(): Promise<void> {
  if (!room) return;
  const next = !state.muted;
  try {
    await room.localParticipant.setMicrophoneEnabled(!next);
    setState({ muted: next });
  } catch {
    /* leave state as-is if the device refused */
  }
}

/**
 * Route audio to the loudspeaker or back to the earpiece.
 * Android's outputs are named 'speaker'/'earpiece'; iOS exposes 'force_speaker'/'default'.
 * Ask the device what it has rather than assuming a platform's naming.
 */
export async function toggleSpeaker(): Promise<void> {
  const AudioSession = livekit?.AudioSession;
  if (!AudioSession?.selectAudioOutput) return;
  const next = !state.speakerOn;
  try {
    let target = next ? 'speaker' : 'earpiece';
    try {
      const outputs: string[] = (await AudioSession.getAudioOutputs?.()) || [];
      const found = next
        ? outputs.find((o) => /speaker/i.test(o))
        : outputs.find((o) => /earpiece|default/i.test(o));
      if (found) target = found;
    } catch {
      /* fall back to the Android names */
    }
    await AudioSession.selectAudioOutput(target);
    setState({ speakerOn: next });
  } catch {
    /* device without a routable speaker — keep state truthful */
  }
}

// ─────────────────────────────────────────────── Socket event handlers
// App.tsx owns the socket and forwards these three events here.

export interface IncomingCallPayload {
  roomName: string;
  queryId: string;
  callerUserId: string;
  callerName: string;
  queryText: string;
}

export function handleIncomingCall(payload: IncomingCallPayload): void {
  // Without the native module we can't answer; don't ring a phone that can't pick up.
  if (!callingAvailable) return;
  // Already on a call — the server will mark this one missed.
  if (state.phase !== 'idle') return;
  setState({
    phase: 'incoming',
    roomName: payload.roomName,
    queryId: payload.queryId,
    peerName: payload.callerName || 'Data Entry Team',
    queryText: payload.queryText || '',
    muted: false,
    speakerOn: false,
    connectedAt: null,
  });
}

export function handleCallAnswered(payload: { roomName: string }): void {
  if (payload.roomName !== state.roomName) return;
  if (state.phase === 'outgoing') {
    setState({ phase: 'active', connectedAt: Date.now() });
  }
}

export function handleCallEnded(payload: { roomName: string; reason?: string }): void {
  if (payload.roomName !== state.roomName) return;
  void resetCall();
}
