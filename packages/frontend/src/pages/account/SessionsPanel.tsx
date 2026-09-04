import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Monitor, Smartphone, MapPin, Clock, ShieldCheck, LogOut, AlertCircle } from 'lucide-react';
import { getMySessions, getUserSessions, revokeSession, type SessionView } from '../../services/sessions';
import { userMessage } from '../../services/errors';

const fmtWhen = (d: string) =>
  new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

/** A short "5 minutes ago" for last-seen, falling back to the absolute time for anything older. */
function ago(d: string): string {
  const diff = Date.now() - new Date(d).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  return fmtWhen(d);
}

const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};

/**
 * Where a person is signed in, and the control to sign a device out.
 *
 * Self-service by default (`/sessions/me`): every user can see their own devices — the IP, the
 * device, when it last checked in — and revoke any of them, which is the practical answer to "I
 * lost my phone". Pass `userId` for the administrator's read of someone else's login history
 * (incident response). Revoking is audited server-side; the current device is flagged and not
 * offered a self-revoke button (signing yourself out from here would just be a confusing logout).
 */
export const SessionsPanel: React.FC<{ userId?: string }> = ({ userId }) => {
  const queryClient = useQueryClient();
  const queryKey = ['sessions', userId ?? 'me'];

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => (userId ? getUserSessions(userId) : getMySessions()),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const sessions: SessionView[] = Array.isArray(data) ? data : [];

  if (isLoading) {
    return <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>Loading sessions…</div>;
  }
  if (error) {
    return (
      <div style={{ fontSize: 13, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <AlertCircle size={15} /> Could not load sessions. {userMessage(error)}
      </div>
    );
  }
  if (sessions.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No sessions on record.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {revoke.isError && (
        <div style={{ fontSize: 12.5, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={14} /> Could not sign that device out. {userMessage(revoke.error)}
        </div>
      )}
      {sessions.map((s) => {
        const mobile = /Android|iOS/i.test(s.os ?? '') || /app/i.test(s.browser ?? '');
        const tone = s.current ? 'var(--success)' : s.active ? 'var(--accent)' : 'var(--text-muted)';
        return (
          <div
            key={s.id}
            className="glass-card"
            style={{
              padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
              borderLeft: `3px solid ${tone}`, opacity: s.active ? 1 : 0.6,
            }}
          >
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 38, height: 38, borderRadius: 'var(--radius-md)', color: tone,
              background: `color-mix(in srgb, ${tone} 14%, transparent)`, flexShrink: 0,
            }}>
              {mobile ? <Smartphone size={18} /> : <Monitor size={18} />}
            </span>

            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {s.device || s.browser || 'Unknown device'}
                {s.current && (
                  <span className="badge" style={{ fontSize: 10, background: 'color-mix(in srgb, var(--success) 16%, transparent)', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <ShieldCheck size={11} /> This device
                  </span>
                )}
                {!s.active && (
                  <span className="badge" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {s.revokedAt ? 'Signed out' : 'Expired'}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 5, fontSize: 11.5, color: 'var(--text-muted)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <MapPin size={11} /> {s.ipAddress || 'IP unknown'}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={11} /> Last active {ago(s.lastSeenAt)}
                </span>
                <span>Signed in {fmtWhen(s.createdAt)}</span>
                <span style={{ ...label, letterSpacing: '0.04em' }}>{s.loginMethod}</span>
              </div>
            </div>

            {s.active && !s.current && (
              <button
                onClick={() => revoke.mutate(s.id)}
                disabled={revoke.isPending}
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
              >
                <LogOut size={13} /> Sign out
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default SessionsPanel;
