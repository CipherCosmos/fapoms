import React from 'react';
import {
  Briefcase, Award, AlertTriangle, CheckCircle2, Phone, Mail, MapPin, Calendar, Star,
  TrendingUp, DollarSign, X, ShieldCheck, ShieldAlert, Clock, Globe, Compass, Layers,
} from 'lucide-react';
import type { AssayerQualificationView, PartnerQualificationView } from '@fapoms/shared';
import { EmpanelmentStatus, PLANNABLE_EMPANELMENT_STANDINGS, formatRouteDistance, formatTravelTime } from '@fapoms/shared';

import { Modal } from '../../components/ui';
import { AssayerRemarks } from '../../components/AssayerRemarks';
import { api } from '../../services/api';
import { LoadFailure, caughtLoad } from '../../components/LoadFailure';
import { ScoreBreakdown } from './ScoreBreakdown';
import type { AssayerDetail, Candidate } from '../PlanningWorkspace';

/**
 * The candidate-detail view opened from Planning ("Details" on a candidate card).
 *
 * Used to be a single read-only card of lifetime stats — no qualification score, no eligibility
 * for the client actually being staffed, no live workload, no risk flags, and nothing about the
 * branch it was opened for. A planner had to leave Planning entirely (the HR roster) to see
 * whether someone had a clean background check, then come back and re-find them in the list.
 * Everything below is data the platform already computes; this wires it into the one screen a
 * planner is actually using, and tabs it so a fast glance and a careful check are both one click.
 */

const STANDING_LABEL: Record<string, string> = {
  [EmpanelmentStatus.ACTIVE]: 'Active — empanelled and taking work',
  [EmpanelmentStatus.RECOMMENDED]: 'Recommended — put forward, awaiting the client’s decision',
  [EmpanelmentStatus.NOT_RECOMMENDED]: 'Not recommended for this client',
  [EmpanelmentStatus.REJECTED]: 'Rejected by this client',
  [EmpanelmentStatus.RESIGNED]: 'Resigned from this client',
  [EmpanelmentStatus.DOCUMENTS_PENDING]: 'Documents pending with this client',
  [EmpanelmentStatus.INACTIVE]: 'Empanelled once, dormant now',
  [EmpanelmentStatus.TERMINATED]: 'Terminated by this client',
};

const scoreTone = (n: number | null | undefined): string =>
  n == null ? 'var(--text-muted)'
    : n >= 80 ? 'var(--success)'
    : n >= 60 ? 'var(--accent)'
    : n >= 40 ? 'var(--warning)'
    : 'var(--danger)';

const timeAgo = (iso: string): string => {
  const hrs = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hrs < 1) return 'just now';
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

/** A stat tile that reads as one thing to a screen reader, not two disconnected text nodes. */
const StatTile: React.FC<{ icon: React.ReactNode; caption: string; value: React.ReactNode; valueText: string; tone?: string }> = ({ icon, caption, value, valueText, tone }) => (
  <div role="group" aria-label={`${caption}: ${valueText}`} className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
    <div aria-hidden="true" style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}>{icon} {caption}</div>
    <div aria-hidden="true" style={{ fontSize: '20px', fontWeight: 700, color: tone ?? 'var(--accent-primary)' }}>{value}</div>
  </div>
);

const TABS = [
  { key: 'overview', label: 'Overview', icon: Briefcase },
  { key: 'qualification', label: 'Qualification & Risk', icon: ShieldCheck },
  { key: 'history', label: 'History', icon: Calendar },
  { key: 'remarks', label: 'Remarks', icon: Star },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export const AssayerDetailModal: React.FC<{
  open: boolean;
  onClose: () => void;
  assayerId: string | null;
  profile: AssayerDetail | null;
  loadingProfile: boolean;
  /**
   * Why there is no profile, when there is no profile because the request failed. Told apart from
   * `profile === null`, which this modal renders as "Assayer not found." — a claim about a person
   * that must never be produced by a refusal or an outage.
   */
  profileError?: unknown;
  onRetryProfile?: () => void;
  /** The card this modal was opened from — branch-specific match context. Null off a bare id. */
  candidate: Candidate | null;
  branchName?: string | null;
  clientId?: string | null;
  onCallAndAssign: (c: Candidate) => void;
  onSendToApp: (c: Candidate) => void;
}> = ({ open, onClose, assayerId, profile, loadingProfile, profileError, onRetryProfile, candidate, branchName, clientId, onCallAndAssign, onSendToApp }) => {
  const [tab, setTab] = React.useState<TabKey>('overview');
  const [qualification, setQualification] = React.useState<(AssayerQualificationView & { printSummary?: unknown }) | null>(null);
  const [partners, setPartners] = React.useState<PartnerQualificationView[] | null>(null);
  const [snapshot, setSnapshot] = React.useState<{ workload: { activeCount: number; maxWeeklyCapacity: number; remaining: number }; riskFlags: Array<{ reason: string; rawValue: string; createdAt: string }> } | null>(null);
  const [loadingExtra, setLoadingExtra] = React.useState(false);

  React.useEffect(() => {
    if (!open || !assayerId) return;
    setTab('overview');
    setQualification(null);
    setPartners(null);
    setSnapshot(null);
    setLoadingExtra(true);
    let cancelled = false;
    void Promise.all([
      api.request<AssayerQualificationView>(`/assayers/${assayerId}/qualification`).catch(() => null),
      api.request<PartnerQualificationView[]>(`/assayers/${assayerId}/qualification/partners`).catch(() => null),
      api.request<{ workload: { activeCount: number; maxWeeklyCapacity: number; remaining: number }; riskFlags: Array<{ reason: string; rawValue: string; createdAt: string }> }>(`/assayers/${assayerId}/planning-snapshot`).catch(() => null),
    ]).then(([q, p, s]) => {
      if (cancelled) return;
      setQualification(q);
      setPartners(p);
      setSnapshot(s);
    }).finally(() => { if (!cancelled) setLoadingExtra(false); });
    return () => { cancelled = true; };
  }, [open, assayerId]);

  if (!open) return null;

  const partnerForClient = clientId ? (partners ?? []).find((p) => p.client.id === clientId) ?? null : null;
  const plannableForClient = partnerForClient ? PLANNABLE_EMPANELMENT_STANDINGS.includes(partnerForClient.standing as EmpanelmentStatus) : null;

  const onTabKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const idx = TABS.findIndex((t) => t.key === tab);
    const next = e.key === 'ArrowRight' ? (idx + 1) % TABS.length : (idx - 1 + TABS.length) % TABS.length;
    setTab(TABS[next].key);
    (document.getElementById(`adm-tab-${TABS[next].key}`) as HTMLElement | null)?.focus();
  };

  return (
    <Modal open onClose={onClose} title="Assayer Details" width="880px" maxHeight="90vh" bodyStyle={{ padding: '0 4px 0 0', gap: 0 }}>
      {loadingProfile ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading assayer details...</div>
      ) : profileError != null ? (
        <div style={{ padding: '20px' }}>
          <LoadFailure loads={[{ label: "this assayer's profile", query: caughtLoad(profileError, () => onRetryProfile?.()) }]} />
        </div>
      ) : !profile ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Assayer not found.</div>
      ) : (() => {
        const effectiveTotal = Math.max(profile.totalAssignments, profile.auditHistory?.length || 0);
        const effectiveCompleted = Math.max(profile.completedAssignments, profile.auditHistory?.filter(a => ['COMPLETED', 'AUDIT_COMPLETED', 'CLOSED', 'VALIDATION_COMPLETED'].includes(a.status)).length || 0);
        const completionRate = effectiveTotal > 0 ? Math.round((effectiveCompleted / effectiveTotal) * 100) : 0;
        const onTimeRate = effectiveCompleted > 0 ? Math.round((Math.max(profile.onTimeCompletions, effectiveCompleted) / effectiveCompleted) * 100) : 0;

        return (
          <>
            {/* Header — unchanged shape, plus the fields the response already carried and the
                old card never showed: languages, specializations, full address, joining date. */}
            <div className="glass-card" style={{ padding: '20px', borderRadius: 'var(--radius-md)', margin: '0 4px 12px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-accent)', fontSize: '18px', fontWeight: 700, flexShrink: 0 }}>
                    {profile.displayName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <h3 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>{profile.displayName}</h3>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{profile.assayerCode}</span>
                      <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                      <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '8px', background: profile.lifecycleStatus === 'ACTIVE' ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: profile.lifecycleStatus === 'ACTIVE' ? 'var(--status-active)' : 'var(--warning)', fontWeight: 500 }}>{profile.lifecycleStatus}</span>
                      <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}><Briefcase size={10} /> {profile.employmentType}</span>
                      <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}><Star size={10} /> {profile.experienceYears} yrs exp</span>
                      {profile.joiningDate && (
                        <>
                          <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Joined {new Date(profile.joiningDate).toLocaleDateString()}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '24px', fontWeight: 700, color: profile.averageRating >= 4 ? 'var(--status-active)' : profile.averageRating >= 3 ? 'var(--warning)' : 'var(--danger)' }}>
                      {Number(profile.averageRating) > 0 ? Number(profile.averageRating).toFixed(1) : '—'}
                    </div>
                    <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>Avg Rating</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--accent-primary)' }}>{Number(profile.performanceRating).toFixed(1)}</div>
                    <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>Perf. Rating</div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> {[profile.address, profile.city, profile.district, profile.state, profile.pincode].filter(Boolean).join(', ') || `${profile.city}, ${profile.state}`}</div>
                {profile.phone && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Phone size={11} /> {profile.phone}</div>}
                {profile.email && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Mail size={11} /> {profile.email}</div>}
                {profile.department && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Briefcase size={11} /> {profile.department}</div>}
                {profile.region && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> Region: {profile.region}</div>}
                {profile.languages && profile.languages.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Globe size={11} /> {profile.languages.join(', ')}</div>}
              </div>
              {profile.specializations && profile.specializations.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '8px' }}>
                  {profile.specializations.map(s => <span key={s} style={{ padding: '2px 6px', background: 'var(--bg-surface-2)', color: 'var(--text-secondary)', borderRadius: '8px', fontSize: '10px' }}>{s}</span>)}
                </div>
              )}
              {(profile as any).locationNeedsConfirmation && (
                <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10.5px', fontWeight: 600, color: 'var(--warning)' }}>
                  <AlertTriangle size={11} /> This person's map location is unconfirmed — distance and routing figures for them may be approximate.
                </div>
              )}
            </div>

            {/* Tabs */}
            <div role="tablist" aria-label="Assayer detail sections" onKeyDown={onTabKeyDown}
              style={{ display: 'flex', gap: '2px', padding: '0 4px', borderBottom: '1px solid var(--border-color)', overflowX: 'auto', flexShrink: 0 }}>
              {TABS.map((t) => {
                const Icon = t.icon;
                const on = tab === t.key;
                return (
                  <button key={t.key} id={`adm-tab-${t.key}`} role="tab" aria-selected={on} aria-controls={`adm-panel-${t.key}`}
                    tabIndex={on ? 0 : -1} onClick={() => setTab(t.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '5px', padding: '9px 12px',
                      fontSize: '12px', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
                      whiteSpace: 'nowrap', flexShrink: 0,
                      color: on ? 'var(--accent)' : 'var(--text-muted)',
                      borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                    }}>
                    <Icon size={12} /> {t.label}
                    {t.key === 'qualification' && snapshot && snapshot.riskFlags.length > 0 && (
                      <span aria-label={`${snapshot.riskFlags.length} open flags`} style={{ fontSize: '9px', fontWeight: 700, padding: '0px 5px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)' }}>{snapshot.riskFlags.length}</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div id={`adm-panel-${tab}`} role="tabpanel" aria-labelledby={`adm-tab-${tab}`} tabIndex={0} style={{ padding: '14px 4px 4px 2px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {tab === 'overview' && (
                <>
                  {candidate && (
                    <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-hair)' }}>
                      <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '5px' }}><Compass size={13} /> This match{branchName ? ` — ${branchName}` : ''}</h4>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                        <span>{formatRouteDistance(candidate.distanceKm, candidate.distanceSource ?? null)}</span>
                        {candidate.durationMinutes != null && <span>{formatTravelTime(candidate.durationMinutes, candidate.distanceSource ?? null)}</span>}
                        <span title={candidate.usedFallbackBaseFee ? 'No priced rate on file — platform default, not a contracted figure.' : undefined}>
                          Base: {candidate.baseFee != null ? `₹${candidate.baseFee}` : '—'}{candidate.usedFallbackBaseFee ? ' (platform default)' : ''}
                        </span>
                        {candidate.score != null && (
                          <span style={{ fontWeight: 700, color: candidate.score >= 90 ? 'var(--status-active)' : 'var(--warning)' }}>{Math.round(candidate.score)}% Match</span>
                        )}
                      </div>
                      {candidate.dateConflict && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10.5px', fontWeight: 600, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--status-pending-bg)', color: 'var(--warning)', marginBottom: '8px' }}>
                          <AlertTriangle size={10} /> {candidate.dateConflict}
                        </div>
                      )}
                      <ScoreBreakdown
                        breakdown={candidate.scoreBreakdown}
                        contribution={candidate.scoreContribution ?? null}
                        route={{ distanceKm: candidate.distanceKm, durationMinutes: candidate.durationMinutes ?? null, distanceSource: candidate.distanceSource ?? null }}
                      />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px' }}>
                        <button onClick={() => onCallAndAssign(candidate)} className="btn btn-primary" style={{ padding: '7px 10px', fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                          <Phone size={12} /> Call & Assign
                        </button>
                        <button onClick={() => onSendToApp(candidate)} className="btn btn-secondary" style={{ padding: '7px 10px', fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                          Send to app (no fee)
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px' }}>
                    <StatTile icon={<Briefcase size={10} />} caption="Total Audits" value={effectiveTotal} valueText={String(effectiveTotal)} />
                    <StatTile icon={<CheckCircle2 size={10} />} caption="Completed" value={<>{effectiveCompleted}<span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 500 }}> ({completionRate}%)</span></>} valueText={`${effectiveCompleted}, ${completionRate} percent`} tone="var(--status-active)" />
                    <StatTile icon={<TrendingUp size={10} />} caption="Acceptance" value={`${profile.acceptanceRate ?? 100}%`} valueText={`${profile.acceptanceRate ?? 100} percent`} />
                    <StatTile icon={<X size={10} />} caption="Rejection Rate" value={`${profile.rejectionRate ?? 0}%`} valueText={`${profile.rejectionRate ?? 0} percent`} tone={(profile.rejectionRate || 0) > 15 ? 'var(--danger)' : 'var(--success)'} />
                    <StatTile icon={<AlertTriangle size={10} />} caption="Queries Raised" value={profile.queryCount ?? 0} valueText={String(profile.queryCount ?? 0)} tone={(profile.queryCount || 0) > 0 ? 'var(--warning)' : 'var(--success)'} />
                    <a href={`/billing/statement?assayer=${profile.id}`} className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)', textDecoration: 'none', color: 'inherit' }} title="Open the assayer's statement — earned, paid, owed">
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><DollarSign size={10} /> Earnings</div>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--accent)' }}>Statement →</div>
                    </a>
                  </div>

                  {profile.notes && (
                    <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)', fontSize: '11.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>NOTES</div>
                      {profile.notes}
                    </div>
                  )}
                </>
              )}

              {tab === 'qualification' && (
                <>
                  <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><ShieldCheck size={13} /> Qualification score</h4>
                    {loadingExtra ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading…</div>
                    ) : !qualification ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Could not load the qualification profile.</div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '10px' }}>
                          <span style={{ fontSize: '28px', fontWeight: 800, color: scoreTone(qualification.overall.effective), fontVariantNumeric: 'tabular-nums' }}>
                            {qualification.overall.effective ?? '—'}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>/ 100 overall</span>
                          {qualification.overall.override && <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--warning)', textTransform: 'uppercase' }}>adjusted</span>}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {qualification.dimensions.map((d) => (
                            <div key={d.key} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                                <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{d.label}</span>
                                <span style={{ fontWeight: 700, color: scoreTone(d.effective), fontVariantNumeric: 'tabular-nums' }}>{d.effective ?? '—'}</span>
                              </div>
                              {d.basis.length > 0 && (
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{d.basis.join(' · ')}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)', border: clientId && partnerForClient && !plannableForClient ? '1px solid var(--danger)' : undefined }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><ShieldAlert size={13} /> Eligibility for this client</h4>
                    {!clientId ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Open this candidate from a branch to see client-specific eligibility.</div>
                    ) : loadingExtra ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading…</div>
                    ) : !partnerForClient ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No empanelment record for this client yet.</div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '8px', background: partnerForClient.barred ? 'var(--status-cancelled-bg)' : plannableForClient ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: partnerForClient.barred ? 'var(--danger)' : plannableForClient ? 'var(--success)' : 'var(--warning)' }}>
                            {partnerForClient.barred ? 'Barred by this client' : STANDING_LABEL[partnerForClient.standing ?? ''] ?? partnerForClient.standing ?? 'No standing on file'}
                          </span>
                          <span style={{ fontSize: '18px', fontWeight: 800, color: scoreTone(partnerForClient.effective), fontVariantNumeric: 'tabular-nums' }}>{partnerForClient.effective ?? '—'}</span>
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>for {partnerForClient.client.name}</span>
                        </div>
                        {partnerForClient.standingCap != null && (
                          <div style={{ fontSize: '10.5px', color: 'var(--warning)', marginBottom: '6px' }}>Score capped at {partnerForClient.standingCap} — {partnerForClient.standingReason || 'empanelment standing'}.</div>
                        )}
                        {partnerForClient.gaps.length > 0 && (
                          <div style={{ fontSize: '10.5px', color: 'var(--text-secondary)' }}>
                            <div style={{ fontWeight: 600, marginBottom: '3px' }}>What would raise it:</div>
                            <ul style={{ margin: 0, paddingLeft: '16px', lineHeight: 1.6 }}>
                              {partnerForClient.gaps.map((g, i) => <li key={i}>{g}</li>)}
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Clock size={13} /> Current workload</h4>
                    {loadingExtra ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading…</div>
                    ) : !snapshot ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Could not load live workload.</div>
                    ) : (
                      <>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                          <b style={{ color: 'var(--text-primary)' }}>{snapshot.workload.activeCount}</b> active of {snapshot.workload.maxWeeklyCapacity}/week capacity — {snapshot.workload.remaining} remaining
                        </div>
                        <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(100, (snapshot.workload.activeCount / Math.max(1, snapshot.workload.maxWeeklyCapacity)) * 100)}%`, background: snapshot.workload.remaining === 0 ? 'var(--danger)' : snapshot.workload.remaining <= 2 ? 'var(--warning)' : 'var(--status-active)', borderRadius: '3px' }} />
                        </div>
                      </>
                    )}
                  </div>

                  <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><AlertTriangle size={13} /> Data-integrity flags</h4>
                    {loadingExtra ? (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading…</div>
                    ) : !snapshot ? (
                      /* An all-clear is a finding. "No open flags on this record", in green, with
                         a tick, was printed whenever the snapshot failed to load — the panel next
                         to it already admitted "Could not load live workload" off the SAME request.
                         A planner reads this before deciding somebody is safe to send. */
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Could not load the data-integrity flags, so this is not saying there are none.</div>
                    ) : snapshot.riskFlags.length === 0 ? (
                      <div style={{ fontSize: '11px', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '5px' }}><CheckCircle2 size={12} /> No open flags on this record.</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {snapshot.riskFlags.map((f, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '6px 8px', background: 'var(--status-cancelled-bg)', borderRadius: 'var(--radius-sm)', fontSize: '10.5px' }}>
                            <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{f.reason}{f.rawValue ? ` — "${f.rawValue}"` : ''}</span>
                            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{timeAgo(f.createdAt)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Award size={13} /> Skills & Certifications</h4>
                    <div style={{ marginBottom: '10px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>SKILLS</div>
                      {profile.skills && profile.skills.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                          {profile.skills.map(s => <span key={s} style={{ padding: '2px 6px', background: 'rgba(216,174,71,0.1)', color: 'var(--accent-primary)', borderRadius: '8px', fontSize: '10px' }}>{s}</span>)}
                        </div>
                      ) : <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No skills recorded</div>}
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>CERTIFICATIONS</div>
                      {profile.certifications && profile.certifications.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {profile.certifications.map(c => (
                            <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px', background: 'var(--status-active-bg)', borderRadius: 'var(--radius-sm)' }}>
                              <span style={{ fontSize: '11px', color: 'var(--text-primary)' }}>{c.name}</span>
                              <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Exp: {new Date(c.expiryDate).toLocaleDateString()}</span>
                            </div>
                          ))}
                        </div>
                      ) : <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No certifications recorded</div>}
                    </div>
                  </div>
                </>
              )}

              {tab === 'history' && (
                <>
                  <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><TrendingUp size={13} /> Performance Insights</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>COMPLETION RATE</div>
                        <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${completionRate}%`, background: completionRate >= 80 ? 'var(--status-active)' : completionRate >= 50 ? 'var(--warning)' : 'var(--danger)', borderRadius: '3px' }} />
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '1px' }}>{completionRate}%</div>
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>ON-TIME DELIVERY</div>
                        <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${onTimeRate}%`, background: onTimeRate >= 80 ? 'var(--status-active)' : onTimeRate >= 50 ? 'var(--warning)' : 'var(--danger)', borderRadius: '3px' }} />
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '1px' }}>{onTimeRate}%</div>
                      </div>
                      <div style={{ display: 'flex', gap: '14px', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        {profile.cancelledAssignments != null && <span>{profile.cancelledAssignments} cancelled</span>}
                        {profile.lastAssignmentDate && <span>Last assignment {new Date(profile.lastAssignmentDate).toLocaleDateString()}</span>}
                      </div>
                      {profile.activeCommercialProfile && (
                        <div style={{ padding: '8px', background: 'rgba(216,174,71,0.1)', borderRadius: '6px', border: '1px solid rgba(216,174,71,0.2)' }}>
                          <div style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 700, marginBottom: '2px' }}>ACTIVE COMMERCIAL RATE</div>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>₹{profile.activeCommercialProfile.baseFee?.toLocaleString()} / audit</div>
                          <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            Travel: ₹{profile.activeCommercialProfile.travelReimbursement || 0} | Daily: ₹{profile.activeCommercialProfile.dailyRate || 0}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Layers size={13} /> Audit History & Fee Logs</h4>
                    {profile.auditHistory && profile.auditHistory.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '260px', overflowY: 'auto' }}>
                        {profile.auditHistory.map(ah => (
                          <div key={ah.id} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--accent)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{ah.branch_name || 'Branch Audit'}</div>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{ah.branch_city}, {ah.branch_state} | {ah.project_name || 'GSS Project'}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--warning)' }}>₹{(ah.agreed_fee || ah.proposed_fee || 0).toLocaleString()}</div>
                              <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '3px', background: 'rgba(216,174,71,0.2)', color: 'var(--accent)', fontWeight: 600 }}>{ah.status}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : <div style={{ textAlign: 'center', padding: '12px', color: 'var(--text-muted)', fontSize: '11px' }}>No audit history recorded.</div>}
                  </div>
                </>
              )}

              {tab === 'remarks' && (
                <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Star size={13} /> Staff remarks</h4>
                  <AssayerRemarks assayerId={profile.id} compact />
                </div>
              )}
            </div>
          </>
        );
      })()}
    </Modal>
  );
};
