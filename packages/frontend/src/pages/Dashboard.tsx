import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, Map, RefreshCw, Users, IndianRupee,
  CheckCircle2, Inbox, Layers,
} from 'lucide-react';
import { api } from '../services/api';
import { queryClient } from '../queryClient';
import { queryKeys } from '../hooks/queryKeys';
import { useSocketInvalidation } from '../hooks/useSocketInvalidation';

interface Attention {
  key: string; severity: 'critical' | 'high' | 'medium';
  count: number; label: string; detail: string; link: string; isMoney?: boolean;
}
interface DueItem {
  projectBranchId: string; branchName: string; district: string | null; state: string;
  scheduledDate: string; daysAway: number;
  hasAssayer: boolean; packetSent: boolean;
  blocker: 'NO_ASSAYER' | 'PACKET_NOT_SENT' | null;
}
interface Validation {
  pending: number; inReview: number; needsCorrection: number;
  assignedToMe: number; openQueries: number; overdueQueries: number;
}
/**
 * Sections the caller's roles do not include arrive as null. Rendering is driven
 * by that rather than by a role check in the client, so the page cannot show a
 * block the server declined to populate.
 */
interface Snapshot {
  generatedAt: string;
  roles: string[];
  focus: string;
  sections: string[];
  attention: Attention[];
  funnel: Array<{ key: string; label: string; count: number; packets: number }> | null;
  due: DueItem[] | null;
  documents: { packetsUnsent: number; awaitingReturn: number; awaitingOcr: number; inOcr: number } | null;
  money: { unbilled: number; outstanding: number; collected: number } | null;
  capacity: { assayers: number; idle: number; dailyCapacity: number } | null;
  validation: Validation | null;
  projects: Array<{
    id: string; name: string; projectNumber: string; status: string; clientName: string;
    totalBranches: number; audited: number; unplanned: number; packets: number; progressPct: number;
  }> | null;
  activities: Array<{ id: string; action: string; detail: string | null; occurredAt: string }> | null;
}

const money = (n: number) => `₹${(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const SEVERITY: Record<Attention['severity'], string> = {
  critical: '#ef4444', high: '#f59e0b', medium: '#60a5fa',
};

const BLOCKER_TEXT: Record<string, string> = {
  NO_ASSAYER: 'no assayer confirmed',
  PACKET_NOT_SENT: 'packet not released',
};

/**
 * Operational home.
 *
 * The previous dashboard led with counts of clients, users and branches — master
 * data that does not change day to day and that nobody acts on — and a per-project
 * completion bar computed from a field the projects endpoint does not return, so
 * every bar showed 0% permanently. Below that sat three navigation tiles dressed
 * up as content.
 *
 * This shows only things someone has to do something about, ordered by urgency,
 * each linking to the screen where the work actually happens.
 */
export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  useSocketInvalidation();

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.dashboard.all, 'operations'],
    queryFn: () => api.request<Snapshot>('/system-dashboard/operations'),
    staleTime: 30_000,
  });

  const funnelMax = Math.max(1, ...(data?.funnel ?? []).map((f) => f.count));
  const dueSoon = (data?.due ?? []).filter((d) => d.daysAway >= 0).slice(0, 8);
  // Only administrators and operations run the coverage map; linking others to a
  // page they cannot open would be a dead end.
  const canSeeCommandCenter = !!data?.roles.some((r) =>
    ['SUPER_ADMINISTRATOR', 'ADMINISTRATOR', 'OPERATIONS_MANAGER', 'OPERATIONS_EXECUTIVE', 'FINANCE_MANAGER'].includes(r));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 21, fontWeight: 800, margin: 0, fontFamily: 'var(--font-display)' }}>Operations</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '3px 0 0' }}>
            {data?.focus ?? 'What needs doing, what’s at risk, and where the book stands.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all })}
            className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <RefreshCw size={14} /> Refresh
          </button>
          {canSeeCommandCenter && (
            <button onClick={() => navigate('/executive-map')} className="btn btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600 }}>
              <Map size={14} /> Command Center <ArrowRight size={13} />
            </button>
          )}
        </div>
      </div>

      {isLoading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading operational snapshot…</div>}
      {error && (
        <div style={{ padding: 14, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 'var(--radius-md)', color: '#ef4444', fontSize: 13 }}>
          Could not load the operational snapshot.
        </div>
      )}

      {data && (
        <>
          {/* 1. Needs attention — the only section that should change hour to hour. */}
          <div>
            <SectionLabel>Needs attention</SectionLabel>
            {data.attention.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px', background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 'var(--radius-md)', color: '#22c55e', fontSize: 13 }}>
                <CheckCircle2 size={16} /> Nothing blocked. No audits at risk, no paperwork waiting, nothing unbilled.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(262px, 1fr))', gap: 12 }}>
                {data.attention.map((a) => {
                  const c = SEVERITY[a.severity];
                  return (
                    <button key={a.key} onClick={() => navigate(a.link)}
                      style={{
                        textAlign: 'left', cursor: 'pointer', background: 'var(--bg-secondary)',
                        border: `1px solid ${c}44`, borderLeft: `3px solid ${c}`,
                        borderRadius: 'var(--radius-md)', padding: '13px 15px', color: 'var(--text-primary)',
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: c, fontSize: 11.5, fontWeight: 700 }}>
                        <AlertTriangle size={13} />{a.label}
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, marginTop: 5, fontFamily: 'var(--font-display)' }}>
                        {a.isMoney ? money(a.count) : a.count}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 }}>{a.detail}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 2. The week ahead, with readiness rather than just dates. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
            {data.due && (
            <div>
              <SectionLabel>Audits due — next 7 days</SectionLabel>
              <div className="glass-card" style={{ padding: 14 }}>
                {dueSoon.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No audits scheduled in the next week.</div>
                ) : dueSoon.map((d) => (
                  <div key={d.projectBranchId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, minWidth: 54, textAlign: 'center',
                      padding: '2px 7px', borderRadius: 'var(--radius-sm)',
                      background: d.daysAway === 0 ? 'rgba(239,68,68,0.15)' : 'var(--bg-tertiary)',
                      color: d.daysAway === 0 ? '#ef4444' : 'var(--text-secondary)',
                    }}>
                      {d.daysAway === 0 ? 'today' : d.daysAway === 1 ? 'tomorrow' : `${d.daysAway}d`}
                    </span>
                    <span style={{ flex: 1, minWidth: 130, fontSize: 12.5 }}>
                      <strong>{d.branchName}</strong>
                      <span style={{ color: 'var(--text-muted)' }}> · {d.district}</span>
                    </span>
                    {d.blocker ? (
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: '#f59e0b', whiteSpace: 'nowrap' }}>
                        {BLOCKER_TEXT[d.blocker]}
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: '#22c55e' }}>
                        <CheckCircle2 size={11} /> ready
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            )}

            {/* 3. Funnel — where the book is piling up. */}
            {data.funnel && (
            <div>
              <SectionLabel>Where the book stands</SectionLabel>
              <div className="glass-card" style={{ padding: 14 }}>
                {data.funnel.filter((f) => f.count > 0).map((f) => (
                  <div key={f.key} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 3 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{f.label}</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{f.count}</strong> branches · {f.packets.toLocaleString('en-IN')} pkt
                      </span>
                    </div>
                    <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${(f.count / funnelMax) * 100}%`, height: '100%', background: 'var(--accent-primary)' }} />
                    </div>
                  </div>
                ))}
                {data.funnel.every((f) => f.count === 0) && (
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No branches loaded yet.</div>
                )}
              </div>
            </div>
            )}
          </div>

          {/* Validation — only for the roles that work that queue. */}
          {data.validation && (
            <div>
              <SectionLabel>Validation queue</SectionLabel>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <Stat icon={<Inbox size={15} />} label="Assigned to you" value={String(data.validation.assignedToMe)}
                      sub="cases where you are the reviewer" color="#a78bfa" onClick={() => navigate('/validation')} />
                <Stat icon={<Layers size={15} />} label="Awaiting review" value={String(data.validation.pending + data.validation.inReview)}
                      sub={`${data.validation.pending} pending · ${data.validation.inReview} in review`} color="#60a5fa" onClick={() => navigate('/validation')} />
                <Stat icon={<AlertTriangle size={15} />} label="Needs correction" value={String(data.validation.needsCorrection)}
                      sub="sent back for rework" color={data.validation.needsCorrection ? '#f59e0b' : 'var(--text-muted)'} onClick={() => navigate('/validation')} />
                <Stat icon={<AlertTriangle size={15} />} label="Open clarifications" value={String(data.validation.openQueries)}
                      sub={data.validation.overdueQueries > 0 ? `${data.validation.overdueQueries} past deadline` : 'none overdue'}
                      color={data.validation.overdueQueries ? '#ef4444' : '#22c55e'} onClick={() => navigate('/validation')} />
              </div>
            </div>
          )}

          {/* 4. Standing position — checked occasionally, not hourly. */}
          {(data.capacity || data.documents || data.money) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
              {data.capacity && (
                <Stat icon={<Users size={15} />} label="Assayer capacity" value={`${data.capacity.dailyCapacity}/day`}
                      sub={`${data.capacity.assayers} active · ${data.capacity.idle} idle`} color="#22c55e"
                      onClick={() => navigate('/assayers')} />
              )}
              {data.documents && (
                <Stat icon={<Inbox size={15} />} label="Paperwork in flight"
                      value={String(data.documents.awaitingReturn + data.documents.awaitingOcr + data.documents.inOcr)}
                      sub={`${data.documents.awaitingReturn} with assayers · ${data.documents.awaitingOcr} at data entry`}
                      color="#a78bfa" onClick={() => navigate('/documents')} />
              )}
              {data.money && (
                <>
                  <Stat icon={<IndianRupee size={15} />} label="Unbilled" value={money(data.money.unbilled)}
                        sub={data.money.outstanding > 0 ? `${money(data.money.outstanding)} awaiting payment` : 'nothing outstanding'}
                        color="#f59e0b" onClick={() => navigate('/billing')} />
                  <Stat icon={<IndianRupee size={15} />} label="Collected" value={money(data.money.collected)}
                        sub="received from clients" color="#10b981" onClick={() => navigate('/billing')} />
                </>
              )}
            </div>
          )}

          {/* 5. Projects — real progress, counted server-side. */}
          {data.projects && (
          <div>
            <SectionLabel>Projects</SectionLabel>
            <div className="glass-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {data.projects.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No active projects.</div>}
              {data.projects.map((p) => (
                <div key={p.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/planning?projectId=${p.id}`)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>
                      {p.name} <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontFamily: 'monospace', fontSize: 11 }}>{p.projectNumber}</span>
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {p.clientName} · <strong style={{ color: 'var(--text-primary)' }}>{p.progressPct}%</strong> audited
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden', margin: '6px 0 4px' }}>
                    <div style={{ width: `${p.progressPct}%`, height: '100%', background: 'var(--gradient-neon, #22c55e)' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                    <span><Layers size={10} style={{ display: 'inline' }} /> {p.totalBranches} branches</span>
                    <span>{p.packets.toLocaleString('en-IN')} packets</span>
                    <span>{p.audited} audited</span>
                    {p.unplanned > 0 && <span style={{ color: '#f59e0b' }}>{p.unplanned} not yet planned</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          )}

          {/* 6. Activity */}
          {data.activities && data.activities.length > 0 && (
            <div>
              <SectionLabel>Recent activity</SectionLabel>
              <div className="glass-card" style={{ padding: 14, maxHeight: 220, overflowY: 'auto' }}>
                {data.activities.map((a) => (
                  <div key={a.id} style={{ display: 'flex', gap: 10, padding: '5px 0', fontSize: 12, alignItems: 'baseline' }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent-secondary)', flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, minWidth: 0 }}>{a.action.replace(/_/g, ' ').toLowerCase()}</span>
                    {a.detail && <span style={{ color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.detail}</span>}
                    <span style={{ color: 'var(--text-muted)', fontSize: 10, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                      {new Date(a.occurredAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string; color: string; onClick?: () => void }> = ({ icon, label, value, sub, color, onClick }) => (
  <button onClick={onClick} style={{
    textAlign: 'left', cursor: onClick ? 'pointer' : 'default', background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)', borderLeft: `3px solid ${color}`,
    borderRadius: 'var(--radius-md)', padding: '13px 15px', color: 'var(--text-primary)',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', fontWeight: 700 }}>
      <span style={{ color }}>{icon}</span>{label}
    </div>
    <div style={{ fontSize: 19, fontWeight: 800, marginTop: 5, fontFamily: 'var(--font-display)' }}>{value}</div>
    {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
  </button>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.9px', color: 'var(--text-muted)', marginBottom: 9 }}>{children}</div>
);
