import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, MapPin, Phone, Mail, Briefcase, Award, Clock, Star, Send,
  AlertTriangle, CheckCircle2, Edit2, ArrowRightLeft, FileText, ClipboardList,
  CreditCard, MessageSquare, ExternalLink, ShieldCheck,
} from 'lucide-react';
import { nextAssayerLifecycleStates } from '@fapoms/shared';

import { api } from '../services/api';
import { GeoPrecisionBadge, geoNeedsFixing } from '../components/GeoPrecisionBadge';
import { PinCoordinateControl } from '../components/PinCoordinateControl';
import { connectSocket, getSocket } from '../services/socket';
import { useCurrentRoles, canManageAssayers } from '../hooks/useCurrentRoles';
import { EditAssayerModal } from './hr/AssayerForms';
import {
  STATUS_COLORS, fmtDate, fmtWhen, money, missingCriticalFields,
  fieldLabelStyle as label,
} from './hr/assayer-shared';
import type { Assayer } from './hr/assayer-shared';
import { userMessage } from '../services/errors';

/**
 * The full record for one assayer.
 *
 * This page previously read two endpoints and rendered five cards, leaving it
 * disconnected from everything the person is actually involved in: their work,
 * their pay, their paperwork, and the trail of who changed what. `/profile`
 * already returns earnings, rates, acceptance and capability — most of it was
 * simply never displayed.
 *
 * It now pulls assignments, documents, rate history and the audit trail alongside,
 * and links out to the pages that own each, so the profile is a hub rather than a
 * leaf. Completeness uses the same rule and wording as the roster and HR console,
 * so the three views cannot disagree about who is missing what.
 */

interface ProfileData extends Assayer {
  /** How the home coordinate was obtained — see GeoPrecisionBadge. */
  geoSource?: string | null;
  geoAccuracyMeters?: number | null;
  geoMatchedName?: string | null;
  averageRating: string | number;
  totalEarnings: string | number;
  earningsPaid: number;
  earningsAwaitingApproval: number;
  runningBalance: number;
  queryCount: number;
  acceptanceRate: number;
  rejectionRate: number;
  totalAssignments: number;
  completedAssignments: number;
  cancelledAssignments: number;
  onTimeCompletions: number;
  lastAssignmentDate: string | null;
  activeCommercialProfile: any | null;
}


const TABS = [
  { key: 'work', label: 'Work', icon: ClipboardList },
  { key: 'pay', label: 'Pay', icon: CreditCard },
  { key: 'capability', label: 'Capability', icon: Award },
  { key: 'documents', label: 'Documents', icon: FileText },
  { key: 'remarks', label: 'Remarks', icon: MessageSquare },
  { key: 'activity', label: 'Activity', icon: Clock },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: '10px', padding: '16px',
};

export const AssayerProfile: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canManage = canManageAssayers(useCurrentRoles());

  const [p, setP] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [remarkText, setRemarkText] = useState('');

  /** Each tab's payload, fetched the first time that tab is opened. */
  const [side, setSide] = useState<Record<string, any>>({});

  const tab = (params.get('tab') as TabKey) || 'work';
  const setTab = (t: TabKey) => setParams({ tab: t }, { replace: true });

  const loadProfile = useCallback(async () => {
    if (!id) return;
    try {
      setP(await api.request<ProfileData>(`/assayers/${id}/profile`));
      setErr(null);
    } catch (e) {
      setErr(userMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  useEffect(() => {
    connectSocket();
    const socket = getSocket();
    const onUpdate = (data: any) => {
      if (data?.aggregateId === id || data?.payload?.id === id) loadProfile();
    };
    socket?.on('assayer:updated', onUpdate);
    return () => { socket?.off('assayer:updated', onUpdate); };
  }, [id, loadProfile]);

  useEffect(() => {
    if (!id || side[tab] !== undefined) return;
    const fetchers: Record<TabKey, () => Promise<any>> = {
      // Assignments come back as { items } rather than { data }, so the envelope has
      // to be read explicitly — unwrapping .data yields undefined and renders empty.
      work: () => api.request<{ items: any[] }>(`/assignments/assayer/${id}`, { withMeta: true } as any).then((r: any) => r?.items ?? []),
      pay: () => api.request<any[]>(`/assayers/${id}/commercial`),
      capability: () => api.request<any[]>(`/assayers/${id}/workforce-attribute`),
      documents: () => Promise.all([
        api.request<any[]>(`/assayers/${id}/document`).catch(() => []),
        api.request<any[]>(`/assayers/${id}/government-document`).catch(() => []),
      ]).then(([files, gov]) => ({ files: files ?? [], gov: gov ?? [] })),
      remarks: () => api.request<any[]>(`/assayers/${id}/remark`),
      activity: () => api.request<any[]>(`/assayers/${id}/activity`),
    };
    fetchers[tab]()
      .then((d) => setSide((s) => ({ ...s, [tab]: d })))
      .catch(() => setSide((s) => ({ ...s, [tab]: tab === 'documents' ? { files: [], gov: [] } : [] })));
  }, [tab, id, side]);

  const missing = useMemo(() => missingCriticalFields(p), [p]);

  const transitions = p ? nextAssayerLifecycleStates(p.lifecycleStatus) : [];

  const move = async () => {
    if (!target || !id) return;
    setBusy(true);
    try {
      await api.request(`/assayers/${id}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: target, reason: `Moved to ${target}` }),
      });
      setTarget('');
      setSide((s) => ({ ...s, activity: undefined }));
      await loadProfile();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  const addRemark = async () => {
    if (!remarkText.trim() || !id) return;
    setBusy(true);
    try {
      await api.request(`/assayers/${id}/remark`, {
        method: 'POST',
        body: JSON.stringify({ content: remarkText, category: 'GENERAL', visibility: 'INTERNAL' }),
      });
      setRemarkText('');
      setSide((s) => ({ ...s, remarks: undefined }));
    } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  if (loading) return <div style={{ padding: '28px' }}>Loading profile…</div>;
  if (!p) return <div style={{ padding: '28px', color: 'var(--danger)' }}>{err ?? 'Profile not found.'}</div>;

  const tone = STATUS_COLORS[p.lifecycleStatus] ?? 'var(--text-muted)';
  const completionRate = p.totalAssignments > 0 ? Math.round((p.completedAssignments / p.totalAssignments) * 100) : null;

  return (
    <div style={{ padding: '20px 26px', maxWidth: '1280px', margin: '0 auto' }}>
      <button onClick={() => navigate('/hr/roster')} className="btn btn-secondary"
        style={{ padding: '6px 12px', fontSize: '12px', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <ArrowLeft size={14} /> Back to Workforce
      </button>

      {err && (
        <div style={{ padding: '9px 13px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', fontSize: '12.5px', marginBottom: '12px' }}>
          {err}
        </div>
      )}

      <div style={{ ...card, marginBottom: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
            <div style={{
              width: '52px', height: '52px', borderRadius: '50%', flexShrink: 0,
              background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--on-accent)', fontSize: '21px', fontWeight: 700,
            }}>{p.displayName?.charAt(0).toUpperCase()}</div>
            <div>
              <h1 style={{ fontSize: '21px', fontWeight: 700, margin: 0 }}>{p.displayName}</h1>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '5px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--text-muted)' }}>
                <span style={{ fontFamily: 'monospace' }}>{p.assayerCode}</span>
                <span style={{ color: tone, fontWeight: 700 }}>{(p.lifecycleStatus ?? '').replace(/_/g, ' ')}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Briefcase size={11} /> {p.employmentType ?? '—'}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Star size={11} /> {p.experienceYears ?? 0} yrs</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><MapPin size={11} /> {[p.city, p.state].filter(Boolean).join(', ') || '—'}</span>
                {/* The home coordinate is what the conflict-of-interest floor and the
                    serviceability radius are both measured from, so how precise it is decides
                    which branches this person can be matched to at all. */}
                <GeoPrecisionBadge source={p.geoSource} matchedName={p.geoMatchedName} compact />
              </div>
              {geoNeedsFixing(p.geoSource) && canManage && (
                <PinCoordinateControl target="assayer" id={p.id} onPinned={() => loadProfile()} />
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {p.phone && <a href={`tel:${p.phone}`} className="btn btn-secondary" style={{ fontSize: '13px', fontWeight: 700, padding: '8px 14px', minHeight: '38px', display: 'inline-flex', alignItems: 'center', gap: '6px', textDecoration: 'none' }}><Phone size={14} /> {p.phone}</a>}
            {p.email && <a href={`mailto:${p.email}`} className="btn btn-secondary" style={{ fontSize: '13px', fontWeight: 700, padding: '8px 14px', minHeight: '38px', display: 'inline-flex', alignItems: 'center', gap: '6px', textDecoration: 'none' }}><Mail size={14} /> Email</a>}
            {canManage && <button onClick={() => setEditing(true)} className="btn btn-secondary" style={{ fontSize: '13px', fontWeight: 700, padding: '8px 14px', minHeight: '38px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Edit2 size={14} /> Edit Profile</button>}
          </div>
        </div>

        {canManage && transitions.length > 0 && (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '14px', paddingTop: '13px', borderTop: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
            <span style={{ ...label, display: 'inline-flex', alignItems: 'center', gap: '5px' }}><ArrowRightLeft size={12} /> Lifecycle</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}
              style={{ padding: '8px 12px', minHeight: '38px', fontSize: '13px', fontWeight: 600, borderRadius: '6px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }}>
              <option value="">Move to stage…</option>
              {transitions.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
            <button onClick={move} disabled={!target || busy} className="btn btn-primary" style={{ fontSize: '13px', fontWeight: 700, padding: '8px 16px', minHeight: '38px' }}>
              {busy ? 'Moving…' : '✓ Apply Transition'}
            </button>
          </div>
        )}
      </div>

      {missing.length > 0 ? (
        <div style={{ ...card, marginBottom: '14px', borderLeft: '3px solid var(--warning)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--warning)', fontWeight: 700, fontSize: '13px' }}>
            <AlertTriangle size={15} /> {missing.length} required field(s) missing
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '6px' }}>
            {missing.map((f) => `${f.label} (blocks ${f.why})`).join(' · ')}
          </div>
          {canManage && (
            <button onClick={() => setEditing(true)} className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '5px 10px', marginTop: '9px' }}>
              Fill them in
            </button>
          )}
        </div>
      ) : (
        <div style={{ ...card, marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--success)', fontSize: '12.5px' }}>
          <CheckCircle2 size={15} /> Record complete — payroll and duty-of-care fields are all present.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        <Kpi value={p.totalAssignments ?? 0} caption="Assignments" />
        <Kpi value={p.completedAssignments ?? 0} caption={completionRate === null ? 'Completed' : `Completed · ${completionRate}%`} tone="var(--success)" />
        <Kpi value={`${p.acceptanceRate ?? 100}%`} caption="Acceptance" tone="var(--accent)" />
        <Kpi value={`${p.rejectionRate ?? 0}%`} caption="Rejection" tone={(p.rejectionRate ?? 0) > 15 ? 'var(--danger)' : undefined} />
        <Kpi value={p.queryCount ?? 0} caption="Queries raised" tone={(p.queryCount ?? 0) > 0 ? 'var(--warning)' : undefined} />
        <Kpi value={Number(p.averageRating) > 0 ? Number(p.averageRating).toFixed(1) : '—'} caption="Avg rating" />
        <Kpi value={money(p.earningsPaid)} caption="Paid" tone="var(--success)" />
        <Kpi value={money(p.earningsAwaitingApproval)} caption="Awaiting approval" tone={(p.earningsAwaitingApproval ?? 0) > 0 ? 'var(--warning)' : undefined} />
        <Kpi value={money(p.runningBalance)} caption="Balance owed" tone={(p.runningBalance ?? 0) > 0 ? 'var(--warning)' : undefined} />
      </div>

      <nav style={{ display: 'flex', gap: '2px', borderBottom: '1px solid var(--border-color)', marginBottom: '14px', flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '9px 13px',
                fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
                color: on ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
              }}>
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
      </nav>

      {tab === 'work' && (
        <Panel rows={side.work} empty="No assignments yet. Once this assayer is offered branch work it appears here."
          render={(rows) => (
            <Table
              head={['Assignment', 'Status', 'Scheduled', 'Fee', '']}
              rows={rows.map((w: any) => [
                <span style={{ fontFamily: 'monospace', fontSize: '11.5px' }}>{w.assignmentNumber ?? String(w.id ?? '').slice(0, 8)}</span>,
                <span style={{ fontWeight: 600 }}>{(w.status ?? '').replace(/_/g, ' ')}</span>,
                fmtDate(w.scheduledDate),
                money(w.agreedFee ?? w.proposedFee),
                <button onClick={() => navigate('/assignments')} style={linkBtn}>Open <ExternalLink size={11} /></button>,
              ])}
            />
          )}
        />
      )}

      {tab === 'pay' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={card}>
            <div style={{ ...label, marginBottom: '9px' }}>Current rate</div>
            {p.activeCommercialProfile ? (
              <div style={{ display: 'flex', gap: '22px', flexWrap: 'wrap', fontSize: '13px' }}>
                <span><strong>{money(p.activeCommercialProfile.baseFee)}</strong> per audit</span>
                <span>{money(p.activeCommercialProfile.hourlyRate)} / hr</span>
                <span>{money(p.activeCommercialProfile.dailyRate)} / day</span>
                <span>{money(p.activeCommercialProfile.travelReimbursement)} travel</span>
              </div>
            ) : (
              <div style={{ fontSize: '12.5px', color: 'var(--warning)' }}>
                No active rate — this assayer cannot be billed or paid until one is set.
              </div>
            )}
          </div>
          <Panel rows={side.pay} empty="No rate history."
            render={(rows) => (
              <Table
                head={['Base fee', 'Hourly', 'Daily', 'Travel', 'Effective']}
                rows={rows.map((c: any) => [
                  <strong>{money(c.baseFee)}</strong>, money(c.hourlyRate), money(c.dailyRate), money(c.travelReimbursement),
                  `${fmtDate(c.effectiveStartDate ?? c.startDate)} → ${(c.effectiveEndDate ?? c.endDate) ? fmtDate(c.effectiveEndDate ?? c.endDate) : 'open'}`,
                ])}
              />
            )}
          />
        </div>
      )}

      {tab === 'capability' && (
        <Panel rows={side.capability}
          empty="No skills, languages or certifications recorded — planning cannot match this person on competency."
          render={(rows) => (
            <Table
              head={['Name', 'Type', 'Level', 'Expires']}
              rows={rows.map((w: any) => {
                const days = w.expiryDate ? Math.ceil((new Date(w.expiryDate).getTime() - Date.now()) / 86400000) : null;
                return [
                  <strong>{w.name}</strong>,
                  <span style={label}>{w.type}</span>,
                  w.level ?? '—',
                  days === null ? '—' : (
                    <span style={{ color: days < 0 ? 'var(--danger)' : days <= 30 ? 'var(--warning)' : days <= 90 ? 'var(--warning)' : undefined }}>
                      {fmtDate(w.expiryDate)}{days < 0 ? ` · ${Math.abs(days)}d overdue` : ` · ${days}d`}
                    </span>
                  ),
                ];
              })}
            />
          )}
        />
      )}

      {tab === 'documents' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <section style={card}>
            <div style={{ ...label, marginBottom: '9px', display: 'flex', alignItems: 'center', gap: '5px' }}>
              <ShieldCheck size={12} /> Identity documents
            </div>
            {side.documents === undefined ? <Muted>Loading…</Muted>
              : side.documents.gov.length === 0
                ? <Muted>No identity document on file. Field staff visit client bank branches, where identity verification is normally a precondition of access.</Muted>
                : (
                  <Table
                    head={['Document', 'Number', 'Status', 'Expires']}
                    rows={side.documents.gov.map((g: any) => [
                      <strong>{g.documentType}</strong>,
                      <span style={{ fontFamily: 'monospace', fontSize: '11.5px' }}>{g.documentNumber ?? '—'}</span>,
                      g.verificationStatus ?? 'PENDING',
                      fmtDate(g.expiryDate),
                    ])}
                  />
                )}
          </section>
          <section style={card}>
            <div style={{ ...label, marginBottom: '9px' }}>Uploaded files</div>
            {side.documents === undefined ? <Muted>Loading…</Muted>
              : side.documents.files.length === 0
                ? <Muted>No files uploaded for this assayer.</Muted>
                : (
                  <Table
                    head={['File', 'Type', 'Uploaded']}
                    rows={side.documents.files.map((f: any) => [
                      <strong>{f.fileName}</strong>, f.documentType ?? '—', fmtWhen(f.createdAt),
                    ])}
                  />
                )}
          </section>
        </div>
      )}

      {tab === 'remarks' && (
        <div style={card}>
          {canManage && (
            <div style={{ display: 'flex', gap: '7px', marginBottom: '14px' }}>
              <input value={remarkText} onChange={(e) => setRemarkText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addRemark(); }}
                placeholder="Add a remark…"
                style={{ flex: 1, padding: '8px 11px', fontSize: '12.5px', borderRadius: '7px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }} />
              <button onClick={addRemark} disabled={!remarkText.trim() || busy} className="btn btn-primary" style={{ fontSize: '12px', padding: '8px 13px' }}>
                <Send size={12} />
              </button>
            </div>
          )}
          {side.remarks === undefined ? <Muted>Loading…</Muted>
            : side.remarks.length === 0 ? <Muted>No remarks yet.</Muted>
              : side.remarks.map((r: any) => (
                <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-hair)' }}>
                  <div style={{ fontSize: '12.5px' }}>{r.content}</div>
                  <div style={{ ...label, marginTop: '4px' }}>
                    {r.authorName ?? 'system'} · {fmtWhen(r.createdAt)}{r.category ? ` · ${r.category}` : ''}
                    {r.rating != null && r.rating > 0 ? ` · ${r.rating}★` : ''}
                  </div>
                </div>
              ))}
        </div>
      )}

      {tab === 'activity' && (
        <Panel rows={side.activity} empty="No recorded activity."
          render={(rows) => (
            <Table
              head={['When', 'Event', 'Change', 'By']}
              rows={rows.map((h: any) => [
                <span style={{ whiteSpace: 'nowrap', fontSize: '11.5px', color: 'var(--text-muted)' }}>{fmtWhen(h.occurredAt)}</span>,
                <span style={{ fontSize: '12px' }}>{(h.eventType ?? '').replace(/_/g, ' ').toLowerCase()}</span>,
                h.previousState || h.newState
                  ? <span style={{ fontSize: '12px' }}>{h.previousState ?? '—'} → <strong>{h.newState ?? '—'}</strong></span>
                  : (h.remarks ?? '—'),
                h.performedByName ?? 'system',
              ])}
            />
          )}
        />
      )}

      {editing && (
        <EditAssayerModal
          assayer={p as any}
          onClose={() => setEditing(false)}
          onUpdated={() => { setEditing(false); loadProfile(); }}
        />
      )}
    </div>
  );
};

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer',
  fontSize: '11.5px', display: 'inline-flex', alignItems: 'center', gap: '3px', padding: 0,
};

const Kpi: React.FC<{ value: React.ReactNode; caption: string; tone?: string }> = ({ value, caption, tone }) => (
  <div style={card}>
    <div style={{ fontSize: '21px', fontWeight: 700, color: tone ?? 'var(--text-primary)', lineHeight: 1.1 }}>{value}</div>
    <div style={{ ...label, marginTop: '5px' }}>{caption}</div>
  </div>
);

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', padding: '14px 0' }}>{children}</div>
);

/** Shared loading/empty handling so every tab behaves identically. */
const Panel: React.FC<{ rows: any; empty: string; render: (r: any[]) => React.ReactNode }> = ({ rows, empty, render }) => {
  if (rows === undefined) return <div style={card}><Muted>Loading…</Muted></div>;
  if (!rows || rows.length === 0) return <div style={card}><Muted>{empty}</Muted></div>;
  return <div style={card}>{render(rows)}</div>;
};

const Table: React.FC<{ head: string[]; rows: React.ReactNode[][] }> = ({ head, rows }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
      <thead>
        <tr>{head.map((h, i) => (
          <th key={i} style={{ ...label, textAlign: 'left', padding: '6px 10px 8px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>{h}</th>
        ))}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border-hair)' }}>
            {r.map((c, j) => <td key={j} style={{ padding: '8px 10px', verticalAlign: 'middle' }}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default AssayerProfile;
