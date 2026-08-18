import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Volume2, BellOff, Bell, AlertTriangle, X } from 'lucide-react';
import { callManager, CallState } from '../../services/call.service';
import { Select } from '../ui';

/**
 * Global call UI, mounted once at the app root so an incoming call rings on
 * any page: the incoming-call popup, the fixed in-call bar, and a transient
 * error toast (mic denied, network drop). All state lives in callManager.
 */

const useCallState = (): CallState =>
  useSyncExternalStore(callManager.subscribe, callManager.getState);

const fmtElapsed = (fromMs: number, now: number) => {
  const s = Math.max(0, Math.floor((now - fromMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** mm:ss ticking once a second while the call is live. */
const CallTimer: React.FC<{ since: number }> = ({ since }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtElapsed(since, now)}</span>;
};

const roundBtn = (bg: string, color = '#fff'): React.CSSProperties => ({
  width: 40, height: 40, borderRadius: '50%', border: 'none', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: bg, color, flexShrink: 0,
});

const IncomingCallPopup: React.FC<{ state: CallState }> = ({ state }) => (
  <div style={{
    position: 'fixed', top: 18, right: 18, zIndex: 10000, width: 320,
    background: 'var(--bg-surface)', border: '1px solid var(--border-color)',
    borderRadius: '14px', boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
    padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <span style={{
        ...roundBtn('rgba(63, 125, 83, 0.15)', 'var(--success)'), cursor: 'default',
        animation: 'call-pulse 1.4s ease-in-out infinite',
      }}>
        <Phone size={18} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: '13.5px', fontWeight: 700 }}>{state.peerName ?? 'Incoming call'}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Incoming call · clarification</div>
      </div>
      <button
        onClick={() => callManager.toggleRingtoneMute()}
        title={state.ringtoneMuted ? 'Unmute ringtone' : 'Mute ringtone'}
        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}
      >
        {state.ringtoneMuted ? <BellOff size={16} /> : <Bell size={16} />}
      </button>
    </div>

    {state.queryText && (
      <div style={{
        fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4,
        background: 'var(--bg-surface-2)', borderRadius: '8px', padding: '8px 10px',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        “{state.queryText}”
      </div>
    )}

    <div style={{ display: 'flex', gap: '10px' }}>
      <button
        onClick={() => callManager.decline()}
        className="btn"
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
          background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: '9px',
          padding: '9px 0', fontWeight: 700, fontSize: '12.5px', cursor: 'pointer',
        }}
      >
        <PhoneOff size={15} /> Decline
      </button>
      <button
        onClick={() => callManager.accept()}
        className="btn"
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
          background: 'var(--success)', color: '#fff', border: 'none', borderRadius: '9px',
          padding: '9px 0', fontWeight: 700, fontSize: '12.5px', cursor: 'pointer',
        }}
      >
        <Phone size={15} /> Accept
      </button>
    </div>
  </div>
);

const InCallBar: React.FC<{ state: CallState }> = ({ state }) => {
  const ringing = state.status === 'outgoing';
  return (
    <div style={{
      position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)', zIndex: 10000,
      display: 'flex', alignItems: 'center', gap: '14px',
      background: 'var(--bg-surface)', border: '1px solid var(--border-color)',
      borderRadius: '999px', boxShadow: '0 10px 34px rgba(0,0,0,0.35)',
      padding: '10px 16px', maxWidth: 'min(92vw, 560px)',
    }}>
      <span style={{ ...roundBtn('rgba(63, 125, 83, 0.15)', 'var(--success)'), width: 34, height: 34, cursor: 'default' }}>
        <Phone size={15} />
      </span>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>
          {state.peerName ?? 'Call'}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {ringing ? 'Ringing…' : state.answeredAt ? <CallTimer since={state.answeredAt} /> : 'Connecting…'}
        </div>
      </div>

      {!ringing && (
        <button
          onClick={() => callManager.toggleMute()}
          title={state.micMuted ? 'Unmute microphone' : 'Mute microphone'}
          style={roundBtn(state.micMuted ? 'var(--warning)' : 'var(--bg-surface-2)', state.micMuted ? '#fff' : 'var(--text-muted)')}
        >
          {state.micMuted ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
      )}

      {!ringing && state.outputDevices.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          <Volume2 size={14} style={{ color: 'var(--text-muted)' }} />
          <span title="Audio output device" style={{ display: 'contents' }}>
            <Select
              value={state.activeOutputId ?? ''}
              onChange={(v) => callManager.setOutputDevice(v)}
              placeholder="Speaker"
              options={state.outputDevices.map((d) => ({ value: d.deviceId, label: d.label }))}
              compact
              style={{ maxWidth: 120 }}
            />
          </span>
        </span>
      )}

      <button onClick={() => callManager.hangup()} title={ringing ? 'Cancel call' : 'Hang up'} style={roundBtn('var(--danger)')}>
        <PhoneOff size={17} />
      </button>
    </div>
  );
};

const CallErrorToast: React.FC<{ message: string }> = ({ message }) => {
  useEffect(() => {
    const t = setTimeout(() => callManager.clearError(), 8000);
    return () => clearTimeout(t);
  }, [message]);
  return (
    <div style={{
      position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)', zIndex: 10001,
      display: 'flex', alignItems: 'center', gap: '9px',
      background: 'var(--bg-surface)', border: '1px solid var(--danger)',
      borderRadius: '10px', boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
      padding: '10px 14px', maxWidth: 'min(92vw, 480px)', fontSize: '12.5px',
    }}>
      <AlertTriangle size={15} style={{ color: 'var(--danger)', flexShrink: 0 }} />
      <span>{message}</span>
      <button onClick={() => callManager.clearError()}
        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
        <X size={14} />
      </button>
    </div>
  );
};

export const CallProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const state = useCallState();

  // Bind socket listeners once the app socket exists (init is idempotent).
  useEffect(() => { callManager.init(); });

  return (
    <>
      {children}
      {state.status === 'incoming' && <IncomingCallPopup state={state} />}
      {(state.status === 'outgoing' || state.status === 'in-call') && <InCallBar state={state} />}
      {state.status === 'idle' && state.error && <CallErrorToast message={state.error} />}
      <style>{`@keyframes call-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.12); } }`}</style>
    </>
  );
};

export default CallProvider;
