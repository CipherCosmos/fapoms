// Type-only import: erased at compile time, so it creates NO static dependency and does not pull
// livekit-client into any bundle. The runtime values are loaded on demand via `import()` inside
// connectRoom (see below), so the ~900 kB WebRTC library is fetched only when a call actually
// starts — not parsed at login by every user, most of whom never place a call.
import type * as LiveKit from 'livekit-client';
import { api } from './api';
import { connectSocket, getSocket } from './socket';
import { userMessage } from './errors';

/**
 * In-app voice calling over a clarification thread.
 *
 * A single module-level manager (mirroring socket.ts) owns the socket
 * subscriptions, the LiveKit room lifecycle and the call state machine, so an
 * incoming call rings no matter which page the desk is on. React reads it
 * through subscribe()/getState() (useSyncExternalStore in CallProvider).
 *
 * States: idle → outgoing (ringing the assayer) → in-call → idle
 *         idle → incoming (popup + ringtone)    → in-call → idle
 */

export type CallStatus = 'idle' | 'outgoing' | 'incoming' | 'in-call';

export interface CallState {
  status: CallStatus;
  roomName: string | null;
  queryId: string | null;
  /** Who we're talking to (caller name on incoming, 'Assayer' side on outgoing). */
  peerName: string | null;
  /** First 120 chars of the query, shown on the incoming popup. */
  queryText: string | null;
  /** Epoch ms when the call was answered — drives the mm:ss timer. */
  answeredAt: number | null;
  micMuted: boolean;
  ringtoneMuted: boolean;
  /** Human-readable failure (mic denied, network…). Cleared on next action. */
  error: string | null;
  /** Available audio output devices (empty when the browser doesn't expose them). */
  outputDevices: { deviceId: string; label: string }[];
  activeOutputId: string | null;
}

const idleState = (): CallState => ({
  status: 'idle', roomName: null, queryId: null, peerName: null, queryText: null,
  answeredAt: null, micMuted: false, ringtoneMuted: false, error: null,
  outputDevices: [], activeOutputId: null,
});

interface IncomingPayload {
  roomName: string; queryId: string; callerUserId: string; callerName: string; queryText: string | null;
}

/**
 * The server hands out a RELATIVE signaling path (`/livekit`) — the browser only ever talks
 * to its own origin, and the dev proxy / backend pipe the WebSocket to the SFU internally.
 * An absolute URL (a deployment fronting the SFU with its own TLS name) passes through.
 */
function resolveLiveKitUrl(url: string): string {
  if (url.startsWith('/')) return `${window.location.origin}${url}`;
  return url;
}

function currentUserId(): string | null {
  try {
    const cached = localStorage.getItem('fapoms_user_cache');
    return cached ? (JSON.parse(cached)?.id ?? null) : null;
  } catch {
    return null;
  }
}

/** Subtle two-burst ringtone from a WebAudio oscillator — no audio asset needed. */
class Ringtone {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private muted = false;

  start() {
    if (this.timer) return;
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch {
      return; // no audio available — ring silently (UI still shows)
    }
    const burst = () => {
      if (this.muted || !this.ctx) return;
      // two short dual-tone chirps, classic "ring-ring"
      [0, 0.35].forEach((offset) => {
        const t = this.ctx!.currentTime + offset;
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.setValueAtTime(660, t + 0.12);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
        gain.gain.linearRampToValueAtTime(0.0001, t + 0.28);
        osc.connect(gain).connect(this.ctx!.destination);
        osc.start(t);
        osc.stop(t + 0.3);
      });
    };
    burst();
    this.timer = setInterval(burst, 2500);
  }

  setMuted(m: boolean) { this.muted = m; }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.muted = false;
  }
}

class CallManager {
  private state: CallState = idleState();
  private listeners = new Set<(s: CallState) => void>();
  private room: LiveKit.Room | null = null;
  private ringtone = new Ringtone();
  private socketBound = false;
  /** <audio> elements for subscribed remote tracks, keyed by track sid. */
  private audioEls = new Map<string, HTMLAudioElement>();
  /** Payload of the incoming call currently ringing (needed by accept()). */
  private incoming: IncomingPayload | null = null;

  getState = (): CallState => this.state;

  subscribe = (cb: (s: CallState) => void): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  private set(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((cb) => cb(this.state));
  }

  /** Bind socket events once. Safe to call repeatedly (Provider mount). */
  init() {
    if (this.socketBound) return;
    const s = connectSocket() ?? getSocket();
    if (!s) return; // not authenticated yet; Provider retries on next render
    this.socketBound = true;

    s.on('call:incoming', (p: IncomingPayload) => {
      // Already busy → let the server's missed-call clock handle it.
      if (this.state.status !== 'idle') return;
      this.incoming = p;
      this.set({
        status: 'incoming', roomName: p.roomName, queryId: p.queryId,
        peerName: p.callerName || 'Field assayer', queryText: p.queryText ?? null,
        error: null, ringtoneMuted: false,
      });
      this.ringtone.start();
    });

    s.on('call:answered', (p: { roomName: string; answeredByUserId: string }) => {
      if (p.roomName !== this.state.roomName) return;
      if (this.state.status === 'outgoing') {
        // Callee picked up — our "Ringing…" becomes an in-call timer.
        this.set({ status: 'in-call', answeredAt: Date.now() });
      } else if (this.state.status === 'incoming' && p.answeredByUserId !== currentUserId()) {
        // Someone else on the desk answered — quietly drop our popup.
        this.dismissIncoming();
      }
    });

    s.on('call:ended', (p: { roomName: string; reason: string }) => {
      if (p.roomName !== this.state.roomName) return;
      const note =
        p.reason === 'declined' ? 'Call declined' :
        p.reason === 'missed' ? 'No answer' :
        p.reason === 'cancelled' ? 'Call cancelled' : null;
      this.teardown(note);
    });
  }

  /** Caller side: ring the raiser of this query. */
  async startCall(queryId: string) {
    if (this.state.status !== 'idle') return;
    this.set({ ...idleState(), status: 'outgoing', queryId, peerName: 'Assayer', error: null });
    try {
      const res = await api.request<{ roomName: string; url: string; token: string; rejoined: boolean }>(
        '/calls/initiate', { method: 'POST', body: JSON.stringify({ queryId }) },
      );
      this.set({ roomName: res.roomName });
      await this.connectRoom(res.url, res.token);
      if (res.rejoined) this.set({ status: 'in-call', answeredAt: Date.now() });
    } catch (e) {
      const room = this.state.roomName;
      this.teardown(userMessage(e));
      if (room) api.request('/calls/hangup', { method: 'POST', body: JSON.stringify({ roomName: room }) }).catch(() => {});
    }
  }

  /** Callee side: accept the ringing call. The click itself is the user gesture autoplay needs. */
  async accept() {
    const inc = this.incoming;
    if (!inc || this.state.status !== 'incoming') return;
    this.ringtone.stop();
    this.set({ status: 'in-call', answeredAt: Date.now(), error: null });
    try {
      const res = await api.request<{ roomName: string; url: string; token: string }>(
        '/calls/answer', { method: 'POST', body: JSON.stringify({ roomName: inc.roomName }) },
      );
      await this.connectRoom(res.url, res.token);
      this.incoming = null;
    } catch (e) {
      this.teardown(userMessage(e));
    }
  }

  async decline() {
    const room = this.state.roomName;
    this.dismissIncoming();
    if (room) api.request('/calls/decline', { method: 'POST', body: JSON.stringify({ roomName: room }) }).catch(() => {});
  }

  /** Hang up an active call, or cancel one that's still ringing out. */
  async hangup() {
    const room = this.state.roomName;
    this.teardown(null);
    if (room) api.request('/calls/hangup', { method: 'POST', body: JSON.stringify({ roomName: room }) }).catch(() => {});
  }

  async toggleMute() {
    if (!this.room) return;
    const next = !this.state.micMuted;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(!next);
      this.set({ micMuted: next });
    } catch (e) {
      this.set({ error: userMessage(e) });
    }
  }

  toggleRingtoneMute() {
    const next = !this.state.ringtoneMuted;
    this.ringtone.setMuted(next);
    this.set({ ringtoneMuted: next });
  }

  async setOutputDevice(deviceId: string) {
    if (!this.room) return;
    try {
      await this.room.switchActiveDevice('audiooutput', deviceId);
      this.set({ activeOutputId: deviceId });
    } catch { /* not all browsers allow programmatic output switching */ }
  }

  clearError() { if (this.state.error) this.set({ error: null }); }

  // ── internals ─────────────────────────────────────────────────────────────

  private async connectRoom(url: string, token: string) {
    // The one place the LiveKit runtime is needed. Loading it here (rather than at module top)
    // is what keeps it out of the initial bundle; by the time connectRoom runs, the user has
    // clicked to place or answer a call, so the fetch is covered by that interaction.
    const { Room, RoomEvent, Track, ConnectionState } = await import('livekit-client');

    if (this.room) {
      try { await this.room.disconnect(); } catch { /* already gone */ }
    }
    const room = new Room();
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track: LiveKit.RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach() as HTMLAudioElement;
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      this.audioEls.set(track.sid ?? String(this.audioEls.size), el);
      // If autoplay is blocked (rare, since connect follows a click), retry on next user gesture.
      el.play().catch(() => {
        const resume = () => { el.play().catch(() => {}); document.removeEventListener('click', resume); };
        document.addEventListener('click', resume, { once: true });
      });
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: LiveKit.RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
      if (track.sid) this.audioEls.delete(track.sid);
    });

    room.on(RoomEvent.ConnectionStateChanged, (cs: LiveKit.ConnectionState) => {
      if (cs === ConnectionState.Disconnected && this.state.status === 'in-call') {
        // Server/network dropped us without a call:ended — don't leave a frozen timer.
        this.teardown('Call disconnected');
      }
    });

    try {
      await room.connect(resolveLiveKitUrl(url), token);
    } catch (e) {
      throw Object.assign(new Error('Could not reach the call server. Check your connection and try again.'), { cause: e });
    }

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (e: any) {
      const name = e?.name ?? e?.cause?.name;
      const msg = name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow the microphone for this site in your browser and try again.'
        : name === 'NotFoundError'
          ? 'No microphone was found on this device.'
          : 'Could not start your microphone.';
      throw new Error(msg);
    }

    // Output device list is best-effort; Firefox and unpermissioned Chrome give empty labels.
    try {
      const devices = await Room.getLocalDevices('audiooutput');
      this.set({
        outputDevices: devices
          .filter((d) => d.deviceId)
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${i + 1}` })),
      });
    } catch { /* fine — selector just doesn't render */ }
  }

  private dismissIncoming() {
    this.ringtone.stop();
    this.incoming = null;
    this.set(idleState());
  }

  private teardown(error: string | null) {
    this.ringtone.stop();
    this.incoming = null;
    this.audioEls.forEach((el) => el.remove());
    this.audioEls.clear();
    const room = this.room;
    this.room = null;
    room?.disconnect().catch(() => {});
    this.set({ ...idleState(), error });
  }
}

export const callManager = new CallManager();
