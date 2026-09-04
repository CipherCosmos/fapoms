import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Clock, AlertTriangle, CheckCircle2, Plus, Link2 } from 'lucide-react';
import {
  getComplianceHealth, listIncidents, raiseIncident, updateIncident,
  listRightsRequests, logRightsRequest, updateRightsRequest,
  INCIDENT_CATEGORIES, INCIDENT_SEVERITIES, RIGHTS_REQUEST_TYPES,
  type SecurityIncident, type IncidentClock, type RightsRequest, type SlaClock,
} from '../../services/compliance';
import { userMessage } from '../../services/errors';

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** A statutory clock, rendered as time-left, OVERDUE, or done. */
const ClockBadge: React.FC<{ name: string; clock: IncidentClock }> = ({ name, clock }) => {
  if (!clock.applicable) return null;
  const tone = clock.satisfied ? 'var(--success)' : clock.overdue ? 'var(--danger)' : (clock.hoursRemaining ?? 99) < 2 ? 'var(--warning)' : 'var(--accent)';
  const text = clock.satisfied
    ? 'reported'
    : clock.overdue
      ? 'OVERDUE'
      : `${clock.hoursRemaining}h left`;
  const Icon = clock.satisfied ? CheckCircle2 : clock.overdue ? AlertTriangle : Clock;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: tone,
      background: `color-mix(in srgb, ${tone} 12%, transparent)`, padding: '3px 9px', borderRadius: 'var(--radius-full)' }}>
      <Icon size={12} /> {name}: {text}
    </span>
  );
};

const HealthTile: React.FC<{ label: string; value: number; bad?: boolean }> = ({ label, value, bad }) => (
  <div className="glass-card" style={{ padding: '12px 16px', minWidth: 130 }}>
    <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--font-display)', color: bad && value > 0 ? 'var(--danger)' : 'var(--text-primary)' }}>{value}</div>
    <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>{label}</div>
  </div>
);

export const CompliancePanel: React.FC = () => {
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ['compliance', 'health'], queryFn: getComplianceHealth });
  const incidents = useQuery({ queryKey: ['compliance', 'incidents'], queryFn: listIncidents });

  const [form, setForm] = useState({ title: '', category: 'UNAUTHORISED_ACCESS', severity: 'HIGH', personalDataInvolved: false, description: '' });
  const [showForm, setShowForm] = useState(false);
  const [tab, setTab] = useState<'INCIDENTS' | 'RIGHTS'>('INCIDENTS');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['compliance', 'incidents'] });
    qc.invalidateQueries({ queryKey: ['compliance', 'health'] });
  };

  const raise = useMutation({
    mutationFn: () => raiseIncident(form),
    onSuccess: () => { invalidate(); setShowForm(false); setForm({ title: '', category: 'UNAUTHORISED_ACCESS', severity: 'HIGH', personalDataInvolved: false, description: '' }); },
  });
  const act = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => updateIncident(id, body),
    onSuccess: invalidate,
  });

  const rows: SecurityIncident[] = Array.isArray(incidents.data) ? incidents.data : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1000, margin: '0 auto' }}>
      <div>
        <h2 style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--font-display)', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <ShieldAlert size={22} /> Security & Compliance
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: '4px 0 0' }}>
          The security-incident register and the statutory clocks it runs — CERT-In reporting within 6 hours,
          DPDP notification of affected people within 72 hours.
        </p>
      </div>

      {/* Health strip */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <HealthTile label="Open incidents" value={health.data?.incidents.open ?? 0} />
        <HealthTile label="CERT-In overdue" value={health.data?.incidents.certInOverdue ?? 0} bad />
        <HealthTile label="72h notice overdue" value={health.data?.incidents.principalsOverdue ?? 0} bad />
        <HealthTile label="Rights requests overdue" value={health.data?.rightsRequests.overdue ?? 0} bad />
        <HealthTile label="Audit unsealed" value={health.data?.auditUnsealed ?? 0} bad />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border-color)' }}>
        {(['INCIDENTS', 'RIGHTS'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`btn ${tab === t ? 'btn-primary' : 'btn-ghost'}`}
            style={{ padding: '8px 16px', fontSize: 13, borderRadius: 'var(--radius-md) var(--radius-md) 0 0' }}>
            {t === 'INCIDENTS' ? 'Security incidents' : 'Data-principal requests (DPDP)'}
          </button>
        ))}
      </div>

      {tab === 'RIGHTS' && <RightsRequestsSection />}

      {tab === 'INCIDENTS' && (<>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Plus size={15} /> Raise incident
        </button>
      </div>

      {showForm && (
        <div className="glass-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {raise.isError && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{userMessage(raise.error)}</div>}
          <input placeholder="What happened? (short title)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
            style={inputStyle} />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={inputStyle}>
              {INCIDENT_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
            <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} style={inputStyle}>
              {INCIDENT_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={form.personalDataInvolved} onChange={(e) => setForm({ ...form, personalDataInvolved: e.target.checked })} />
              Personal data involved (starts the 72h DPDP clock)
            </label>
          </div>
          <textarea placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
            style={{ ...inputStyle, minHeight: 70 }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" disabled={!form.title.trim() || raise.isPending} onClick={() => raise.mutate()}>
              {raise.isPending ? 'Raising…' : 'Raise incident'}
            </button>
          </div>
        </div>
      )}

      {/* Incident list */}
      {incidents.isLoading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading incidents…</div>
      ) : rows.length === 0 ? (
        <div className="glass-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
          <CheckCircle2 size={26} style={{ opacity: 0.4 }} />
          <div style={{ fontSize: 13, marginTop: 8 }}>No security incidents on record.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((inc) => {
            const resolved = inc.status === 'RESOLVED' || inc.status === 'CLOSED';
            return (
              <div key={inc.id} className="glass-card" style={{ padding: 16, opacity: resolved ? 0.7 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>
                    {inc.title}
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                      {inc.severity} · {inc.category.replace(/_/g, ' ')} · {inc.status}
                    </span>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>detected {fmt(inc.detectedAt)}</span>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  <ClockBadge name="CERT-In" clock={inc.clocks.certIn} />
                  <ClockBadge name="DPDP 72h" clock={inc.clocks.dpdpPrincipals} />
                  {inc.personalDataInvolved && (
                    <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Link2 size={11} /> personal data{inc.affectedDataPrincipals ? ` · ${inc.affectedDataPrincipals} people` : ''}
                    </span>
                  )}
                </div>

                {!resolved && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                    {!inc.certInReportedAt && (
                      <button className="btn btn-secondary" style={smallBtn} disabled={act.isPending}
                        onClick={() => act.mutate({ id: inc.id, body: { markCertInReported: true } })}>Mark CERT-In reported</button>
                    )}
                    {inc.personalDataInvolved && !inc.principalsNotifiedAt && (
                      <button className="btn btn-secondary" style={smallBtn} disabled={act.isPending}
                        onClick={() => act.mutate({ id: inc.id, body: { markPrincipalsNotified: true } })}>Mark people notified</button>
                    )}
                    <button className="btn btn-secondary" style={smallBtn} disabled={act.isPending}
                      onClick={() => act.mutate({ id: inc.id, body: { status: 'RESOLVED' } })}>Resolve</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </>)}
    </div>
  );
};

/**
 * The DPDP data-principal rights-request queue: log a request, watch its SLA, and record how it was
 * answered. Erasure carries a "legal-retention hold" flag because, for a bank vendor, "delete my
 * data" is reconciled against retention duties rather than performed blindly.
 */
const RightsRequestsSection: React.FC = () => {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['compliance', 'rights'], queryFn: listRightsRequests });
  const [form, setForm] = useState({ requestType: 'ACCESS', subjectRef: '', requesterName: '', details: '' });
  const [show, setShow] = useState(false);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['compliance', 'rights'] });
    qc.invalidateQueries({ queryKey: ['compliance', 'health'] });
  };
  const log = useMutation({
    mutationFn: () => logRightsRequest(form),
    onSuccess: () => { invalidate(); setShow(false); setForm({ requestType: 'ACCESS', subjectRef: '', requesterName: '', details: '' }); },
  });
  const act = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => updateRightsRequest(id, body),
    onSuccess: invalidate,
  });
  const rows: RightsRequest[] = Array.isArray(data) ? data : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={() => setShow((s) => !s)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Plus size={15} /> Log a request
        </button>
      </div>
      {show && (
        <div className="glass-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {log.isError && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{userMessage(log.error)}</div>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <select value={form.requestType} onChange={(e) => setForm({ ...form, requestType: e.target.value })} style={inputStyle}>
              {RIGHTS_REQUEST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input placeholder="Who is asking (name)" value={form.requesterName} onChange={(e) => setForm({ ...form, requesterName: e.target.value })} style={inputStyle} />
            <input placeholder="Their identifier (assayer code / email / phone)" value={form.subjectRef} onChange={(e) => setForm({ ...form, subjectRef: e.target.value })} style={{ ...inputStyle, minWidth: 260 }} />
          </div>
          <textarea placeholder="Details of the request" value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} style={{ ...inputStyle, minHeight: 60 }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" disabled={log.isPending} onClick={() => log.mutate()}>{log.isPending ? 'Logging…' : 'Log request'}</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading requests…</div>
      ) : rows.length === 0 ? (
        <div className="glass-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          No data-principal requests on record.
        </div>
      ) : rows.map((r) => {
        const terminal = r.status === 'COMPLETED' || r.status === 'REJECTED';
        return (
          <div key={r.id} className="glass-card" style={{ padding: 16, opacity: terminal ? 0.7 : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {r.requestType}
                <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>
                  {r.subjectRef || 'subject not identified'} · {r.status}
                </span>
              </div>
              <SlaBadge sla={r.sla} />
            </div>
            {r.details && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6 }}>{r.details}</div>}
            {r.legalHoldApplied && <div style={{ fontSize: 11.5, color: 'var(--warning)', fontWeight: 700, marginTop: 6 }}>Legal-retention hold applied — data kept per retention duty</div>}
            {!terminal && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                {r.status === 'RECEIVED' && (
                  <button className="btn btn-secondary" style={smallBtn} disabled={act.isPending}
                    onClick={() => act.mutate({ id: r.id, body: { status: 'IN_PROGRESS' } })}>Start</button>
                )}
                {r.requestType === 'ERASURE' && (
                  <button className="btn btn-secondary" style={smallBtn} disabled={act.isPending}
                    onClick={() => act.mutate({ id: r.id, body: { status: 'COMPLETED', legalHoldApplied: true } })}>Complete (retention hold)</button>
                )}
                <button className="btn btn-secondary" style={smallBtn} disabled={act.isPending}
                  onClick={() => act.mutate({ id: r.id, body: { status: 'COMPLETED' } })}>Mark completed</button>
                <button className="btn btn-secondary" style={smallBtn} disabled={act.isPending}
                  onClick={() => act.mutate({ id: r.id, body: { status: 'REJECTED' } })}>Reject</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/** An SLA countdown badge — days left, OVERDUE, or done. */
const SlaBadge: React.FC<{ sla: SlaClock }> = ({ sla }) => {
  const tone = sla.satisfied ? 'var(--success)' : sla.overdue ? 'var(--danger)' : (sla.daysRemaining ?? 99) < 5 ? 'var(--warning)' : 'var(--accent)';
  const text = sla.satisfied ? 'answered' : sla.overdue ? 'OVERDUE' : `${sla.daysRemaining}d left`;
  const Icon = sla.satisfied ? CheckCircle2 : sla.overdue ? AlertTriangle : Clock;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: tone,
      background: `color-mix(in srgb, ${tone} 12%, transparent)`, padding: '3px 9px', borderRadius: 'var(--radius-full)' }}>
      <Icon size={12} /> SLA: {text}
    </span>
  );
};

const inputStyle: React.CSSProperties = {
  padding: '9px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontSize: 13, outline: 'none',
};
const smallBtn: React.CSSProperties = { fontSize: 12, padding: '5px 11px' };

export default CompliancePanel;
