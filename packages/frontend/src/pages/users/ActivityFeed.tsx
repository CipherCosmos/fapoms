import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, User as UserIcon, LogIn, KeyRound, ShieldAlert, FileText } from 'lucide-react';
import { api } from '../../services/api';

/**
 * The audit trail, made reachable.
 *
 * `AuditService.recordEvent()` has been writing here from dozens of call sites
 * — project transitions, holiday edits, password resets, assayer lifecycle
 * moves — since early in this system's life, and `AUDIT_LOG:VIEW:PLATFORM` has
 * been granted to three roles the whole time. No controller ever read it back.
 * This is that read, scoped to whichever user/entity is asked for.
 */

export interface AuditEvent {
  id: string;
  category: string;
  eventType: string;
  entityType: string;
  entityId: string;
  previousState: string | null;
  newState: string | null;
  userId: string | null;
  userDisplayName: string | null;
  remarks: string | null;
  occurredAt: string;
}

const EVENT_ICON: Record<string, React.ReactNode> = {
  USER_LOGIN: <LogIn size={13} />,
  USER_PASSWORD_RESET: <KeyRound size={13} />,
  USER_UNLOCKED: <KeyRound size={13} />,
};

const CATEGORY_TONE: Record<string, string> = {
  USER: '#818cf8', OPERATIONAL: '#60a5fa', WORKFLOW: '#facc15', SYSTEM: '#94a3b8',
};

const fmtWhen = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted,#7c8595)',
};

/** A single user's activity — mounted inside the edit panel on the Directory tab. */
export const UserActivityList: React.FC<{ userId: string }> = ({ userId }) => {
  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', 'user', userId],
    queryFn: () => api.request<AuditEvent[]>(`/audit-log/user?userId=${userId}&limit=15`),
  });
  const events = (Array.isArray(data) ? data : (data as any)?.data) || [];

  if (isLoading) return <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading…</div>;
  if (events.length === 0) return <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No recorded activity yet.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '220px', overflowY: 'auto' }}>
      {events.map((e: AuditEvent) => (
        <div key={e.id} style={{ display: 'flex', gap: '8px', padding: '6px 0', borderBottom: '1px solid rgba(148,163,184,0.07)', fontSize: '11.5px' }}>
          <span style={{ color: CATEGORY_TONE[e.category] ?? 'var(--text-muted)', flexShrink: 0, marginTop: '1px' }}>
            {EVENT_ICON[e.eventType] ?? <Activity size={13} />}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div>{e.remarks || e.eventType.replace(/_/g, ' ').toLowerCase()}</div>
            <div style={{ ...label, marginTop: '1px' }}>{fmtWhen(e.occurredAt)}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

/** The full-page global feed — the Activity tab. */
export const ActivityFeed: React.FC = () => {
  const [category, setCategory] = useState<string>('ALL');
  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', 'recent', category],
    queryFn: () => api.request<AuditEvent[]>(`/audit-log/recent?limit=100${category !== 'ALL' ? `&category=${category}` : ''}`),
  });
  const events = (Array.isArray(data) ? data : (data as any)?.data) || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>Every recorded change across the system, most recent first.</span>
        <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
          {['ALL', 'USER', 'OPERATIONAL', 'WORKFLOW'].map((c) => (
            <button key={c} onClick={() => setCategory(c)}
              style={{
                padding: '5px 11px', borderRadius: '999px', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${category === c ? 'transparent' : 'var(--border-color,#232833)'}`,
                background: category === c ? '#4f46e5' : 'transparent',
                color: category === c ? '#fff' : 'var(--text-secondary,#9aa4b5)',
              }}>
              {c === 'ALL' ? 'All' : c.charAt(0) + c.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      <div style={{ background: 'var(--bg-card,#12151c)', border: '1px solid var(--border-color,#232833)', borderRadius: '10px', overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
        ) : events.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <ShieldAlert size={28} style={{ opacity: 0.35 }} />
            <div style={{ fontSize: '13px', marginTop: '8px' }}>No activity recorded in this category.</div>
          </div>
        ) : (
          <div>
            {events.map((e: AuditEvent) => (
              <div key={e.id} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 16px', borderBottom: '1px solid rgba(148,163,184,0.07)' }}>
                <span style={{ color: CATEGORY_TONE[e.category] ?? 'var(--text-muted)', marginTop: '2px' }}>
                  {EVENT_ICON[e.eventType] ?? (e.entityType === 'USER' ? <UserIcon size={14} /> : <FileText size={14} />)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px' }}>
                    {e.remarks || `${e.eventType.replace(/_/g, ' ').toLowerCase()} — ${e.entityType.toLowerCase()}`}
                    {e.previousState && e.newState && (
                      <span style={{ color: 'var(--text-muted)' }}> ({e.previousState} → {e.newState})</span>
                    )}
                  </div>
                  <div style={{ ...label, marginTop: '3px' }}>
                    {e.userDisplayName ?? 'system'} · {fmtWhen(e.occurredAt)}
                  </div>
                </div>
                <span style={{ fontSize: '10px', fontWeight: 700, color: CATEGORY_TONE[e.category] ?? 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {e.category}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ActivityFeed;
