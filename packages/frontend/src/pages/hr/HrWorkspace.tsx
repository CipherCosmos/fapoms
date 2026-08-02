import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, Users, UserPlus, ShieldCheck, MapPin, Activity,
  ClipboardList, TrendingDown, Search, ExternalLink, CheckCircle2, Clock,
} from 'lucide-react';

import { useHrWorkforce } from '../../hooks/useHrWorkforce';
import type { HrWorkforceOverview, HrAction } from '../../hooks/useHrWorkforce';
import { useCurrentRoles, canManageAssayers } from '../../hooks/useCurrentRoles';
import { AssayerRoster } from './AssayerRoster';

/**
 * The HR workspace.
 *
 * HR previously had one page — the assayer list — with every concern folded into
 * it. That list is a record editor; it cannot answer "is this workforce
 * compliant", "who is stuck in onboarding", "where do we need to hire". This page
 * answers those, and every number on it drills through to the people behind it.
 *
 * Structure is deliberate: the worklist comes first (what to do today), the
 * reference panels come after (how the workforce looks). Nothing here is a
 * vanity total — each figure is either an action or the context for one.
 */

const TABS = [
  { key: 'overview', label: 'Overview', icon: ClipboardList },
  { key: 'roster', label: 'Roster', icon: Users },
  { key: 'onboarding', label: 'Onboarding', icon: UserPlus },
  { key: 'records', label: 'Records', icon: Users },
  { key: 'compliance', label: 'Compliance', icon: ShieldCheck },
  { key: 'deployment', label: 'Deployment', icon: MapPin },
  { key: 'utilisation', label: 'Utilisation', icon: TrendingDown },
  { key: 'activity', label: 'Activity', icon: Activity },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const SEVERITY: Record<string, { bg: string; fg: string; label: string }> = {
  critical: { bg: 'rgba(239,68,68,0.12)', fg: '#f87171', label: 'Critical' },
  high: { bg: 'rgba(249,115,22,0.12)', fg: '#fb923c', label: 'High' },
  medium: { bg: 'rgba(234,179,8,0.12)', fg: '#facc15', label: 'Medium' },
  low: { bg: 'rgba(148,163,184,0.12)', fg: '#94a3b8', label: 'Low' },
};

const POSTURE: Record<string, { fg: string; label: string; hint: string }> = {
  NO_COVERAGE: { fg: '#f87171', label: 'No coverage', hint: 'Branches here cannot be staffed at all' },
  STRETCHED: { fg: '#fb923c', label: 'Stretched', hint: 'Too much work per assayer' },
  BALANCED: { fg: '#34d399', label: 'Balanced', hint: 'Supply matches demand' },
  SURPLUS: { fg: '#60a5fa', label: 'Surplus', hint: 'More capacity than work' },
  NO_WORK: { fg: '#94a3b8', label: 'No work', hint: 'Assayers here have no branches' },
};

const card: React.CSSProperties = {
  background: 'var(--bg-card, #12151c)',
  border: '1px solid var(--border-color, #232833)',
  borderRadius: 'var(--radius-md, 10px)',
  padding: '16px',
};

const label: React.CSSProperties = {
  fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--text-muted, #7c8595)', fontWeight: 700,
};

const FIELD_LABELS: Record<string, string> = {
  pan_number: 'PAN', bank_account_number: 'Bank a/c', ifsc_code: 'IFSC',
  joining_date: 'Joining date', emergency_contact_phone: 'Emergency contact',
};

const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const fmtWhen = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** A number with a caption, and optionally a tone when it represents a problem. */
const Stat: React.FC<{ value: React.ReactNode; caption: string; tone?: string; hint?: string }> = ({
  value, caption, tone, hint,
}) => (
  <div style={{ ...card, flex: '1 1 150px', minWidth: 0 }} title={hint}>
    <div style={{ fontSize: '26px', fontWeight: 700, color: tone ?? 'var(--text-primary, #e6e9ef)', lineHeight: 1.1 }}>
      {value}
    </div>
    <div style={{ ...label, marginTop: '6px' }}>{caption}</div>
  </div>
);

/** Horizontal completeness bar — the shape reads faster than the percentage. */
const Bar: React.FC<{ pct: number; tone: string }> = ({ pct, tone }) => (
  <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(148,163,184,0.15)', overflow: 'hidden' }}>
    <div style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%`, height: '100%', background: tone, transition: 'width .3s' }} />
  </div>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted, #7c8595)', fontSize: '13px' }}>
    {children}
  </div>
);

export const HrWorkspace: React.FC = () => {
  const { data, isLoading, error } = useHrWorkforce();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const roles = useCurrentRoles();
  const canManage = canManageAssayers(roles);
  const [search, setSearch] = useState('');

  const tab = (params.get('tab') as TabKey) || 'overview';
  const setTab = (t: TabKey) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true });

  if (isLoading) return <div style={{ padding: '24px' }}>Loading workforce position…</div>;
  if (error) {
    return (
      <div style={{ padding: '24px', color: '#f87171' }}>
        Could not load the workforce overview. {(error as Error).message}
      </div>
    );
  }
  if (!data) return null;

  const d = data as HrWorkforceOverview;

  return (
    <div style={{ padding: '20px 24px', maxWidth: '1500px' }}>
      <Header data={d} canManage={canManage} onOpenRoster={() => setTab('roster')} />

      <nav style={{ display: 'flex', gap: '4px', margin: '18px 0', flexWrap: 'wrap', borderBottom: '1px solid var(--border-color,#232833)' }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          const badge = tabBadge(t.key, d);
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '9px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                background: 'transparent', border: 'none',
                borderBottom: `2px solid ${active ? '#60a5fa' : 'transparent'}`,
                color: active ? '#60a5fa' : 'var(--text-muted, #7c8595)',
              }}
            >
              <Icon size={14} /> {t.label}
              {badge !== null && (
                <span style={{
                  fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '9px',
                  background: badge > 0 ? 'rgba(239,68,68,0.15)' : 'rgba(148,163,184,0.12)',
                  color: badge > 0 ? '#f87171' : '#94a3b8',
                }}>{badge}</span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === 'overview' && <OverviewTab d={d} onJump={setTab} />}
      {tab === 'roster' && <AssayerRoster />}
      {tab === 'onboarding' && <OnboardingTab d={d} navigate={navigate} />}
      {tab === 'records' && <RecordsTab d={d} navigate={navigate} search={search} setSearch={setSearch} canManage={canManage} />}
      {tab === 'compliance' && <ComplianceTab d={d} navigate={navigate} />}
      {tab === 'deployment' && <DeploymentTab d={d} />}
      {tab === 'utilisation' && <UtilisationTab d={d} navigate={navigate} />}
      {tab === 'activity' && <ActivityTab d={d} navigate={navigate} />}
    </div>
  );
};

/** Count shown on a tab, or null where a count would be noise. */
function tabBadge(key: TabKey, d: HrWorkforceOverview): number | null {
  switch (key) {
    case 'roster': return d.headcount.total;
    case 'onboarding': return d.pipeline.stalled.length;
    case 'records': return d.compliance.incompleteCount;
    case 'compliance': return d.expiries.certifications.expired + d.expiries.documents.expired
      + d.expiries.certifications.within30 + d.expiries.documents.within30;
    case 'deployment': return d.deployment.hiringNeeded.length;
    case 'utilisation': return d.utilisation.idleCount;
    default: return null;
  }
}

const Header: React.FC<{ data: HrWorkforceOverview; canManage: boolean; onOpenRoster: () => void }> = ({
  data, canManage, onOpenRoster,
}) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
    <div>
      <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>Workforce</h1>
      <p style={{ color: 'var(--text-secondary, #9aa4b5)', fontSize: '13px', marginTop: '4px' }}>
        {data.headcount.active} active · {data.headcount.onboarding} onboarding · {data.headcount.exited} exited
        {' · '}updated {fmtWhen(data.generatedAt)}
      </p>
    </div>
    <button onClick={onOpenRoster} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}>
      <Users size={14} /> {canManage ? 'Manage roster' : 'View roster'}
    </button>
  </div>
);

// ── Overview ───────────────────────────────────────────────────────────────

const OverviewTab: React.FC<{ d: HrWorkforceOverview; onJump: (t: TabKey) => void }> = ({ d, onJump }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
    <section>
      <div style={{ ...label, marginBottom: '8px' }}>Needs attention</div>
      {d.actions.length === 0 ? (
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '10px', color: '#34d399' }}>
          <CheckCircle2 size={18} /> Nothing outstanding — records are complete, onboarding is moving and every territory is covered.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: '10px' }}>
          {d.actions.map((a: HrAction, i) => {
            const s = SEVERITY[a.severity] ?? SEVERITY.low;
            const target = (a.link.split('tab=')[1] as TabKey) || 'overview';
            return (
              <button
                key={i}
                onClick={() => onJump(target)}
                style={{ ...card, textAlign: 'left', cursor: 'pointer', borderLeft: `3px solid ${s.fg}`, display: 'flex', gap: '10px', alignItems: 'flex-start' }}
              >
                <AlertTriangle size={15} style={{ color: s.fg, flexShrink: 0, marginTop: '2px' }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '3px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: s.bg, color: s.fg }}>{s.label}</span>
                    <span style={{ ...label, fontSize: '10px' }}>{a.area}</span>
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{a.title}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted, #7c8595)', marginTop: '2px' }}>{a.detail}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>

    <section style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      <Stat value={d.headcount.total} caption="Total on roster" />
      <Stat value={d.headcount.active} caption="Active" tone="#34d399" />
      <Stat value={d.pipeline.inProgress} caption="In onboarding" tone={d.pipeline.inProgress ? '#facc15' : undefined} />
      <Stat
        value={`${d.compliance.roster - d.compliance.incompleteCount}/${d.compliance.roster}`}
        caption="Records complete"
        tone={d.compliance.incompleteCount ? '#fb923c' : '#34d399'}
        hint="Assayers with every payroll- and duty-of-care-critical field filled in"
      />
      <Stat
        value={d.utilisation.idleCount}
        caption={`Idle > ${d.utilisation.idleAfterDays}d`}
        tone={d.utilisation.idleCount ? '#facc15' : undefined}
      />
      <Stat value={`${d.attrition.attritionRate12m}%`} caption="Attrition (12m)" />
    </section>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px' }}>
      <section style={card}>
        <div style={{ ...label, marginBottom: '12px' }}>Onboarding funnel</div>
        {d.pipeline.stages.map((s) => (
          <div key={s.key} style={{ marginBottom: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
              <span>{s.label}</span>
              <span style={{ color: 'var(--text-muted,#7c8595)' }}>
                {s.count}{s.stalled > 0 && <span style={{ color: '#fb923c' }}> · {s.stalled} stalled</span>}
              </span>
            </div>
            <Bar pct={d.headcount.total ? (s.count / d.headcount.total) * 100 : 0} tone={s.stalled ? '#fb923c' : '#60a5fa'} />
          </div>
        ))}
      </section>

      <section style={card}>
        <div style={{ ...label, marginBottom: '12px' }}>Record completeness</div>
        {d.compliance.fields.slice(0, 6).map((f) => (
          <div key={f.column} style={{ marginBottom: '10px' }} title={f.blocks}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
              <span>{f.label}{f.critical && <span style={{ color: '#f87171' }}> *</span>}</span>
              <span style={{ color: 'var(--text-muted,#7c8595)' }}>{f.have}/{d.compliance.roster}</span>
            </div>
            <Bar pct={f.pct} tone={f.pct === 100 ? '#34d399' : f.critical ? '#f87171' : '#facc15'} />
          </div>
        ))}
        <div style={{ fontSize: '11px', color: 'var(--text-muted,#7c8595)', marginTop: '10px' }}>
          <span style={{ color: '#f87171' }}>*</span> blocks payroll, statutory filing or duty-of-care
        </div>
      </section>
    </div>
  </div>
);

// ── Onboarding ─────────────────────────────────────────────────────────────

const OnboardingTab: React.FC<{ d: HrWorkforceOverview; navigate: (p: string) => void }> = ({ d, navigate }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      {d.pipeline.stages.map((s) => (
        <Stat key={s.key} value={s.count} caption={s.label} tone={s.stalled ? '#fb923c' : undefined}
          hint={s.avgDaysInStage ? `Average ${s.avgDaysInStage} days in this stage` : undefined} />
      ))}
    </div>

    <section style={card}>
      <div style={{ ...label, marginBottom: '10px' }}>
        Stalled over {d.pipeline.stalledAfterDays} days ({d.pipeline.stalled.length})
      </div>
      {d.pipeline.stalled.length === 0 ? (
        <Empty>No candidate has been sitting in a stage longer than {d.pipeline.stalledAfterDays} days.</Empty>
      ) : (
        <Table
          head={['Assayer', 'Stage', 'Days waiting', 'Location', 'Last moved by', '']}
          rows={d.pipeline.stalled.map((r) => [
            <strong>{r.displayName}</strong>,
            r.stage,
            <span style={{ color: r.daysInStage > 30 ? '#f87171' : '#fb923c', fontWeight: 600 }}>{r.daysInStage}d</span>,
            [r.district, r.state].filter(Boolean).join(', ') || '—',
            r.movedBy ?? '—',
            <OpenLink onClick={() => navigate(`/assayers/${r.id}`)} />,
          ])}
        />
      )}
    </section>
  </div>
);

// ── Records ────────────────────────────────────────────────────────────────

const RecordsTab: React.FC<{
  d: HrWorkforceOverview; navigate: (p: string) => void;
  search: string; setSearch: (s: string) => void; canManage: boolean;
}> = ({ d, navigate, search, setSearch, canManage }) => {
  const [onlyField, setOnlyField] = useState<string>('');

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return d.compliance.incomplete.filter((r) => {
      if (onlyField && !r.missing.includes(onlyField)) return false;
      if (!q) return true;
      return `${r.displayName} ${r.assayerCode} ${r.state} ${r.district}`.toLowerCase().includes(q);
    });
  }, [d.compliance.incomplete, search, onlyField]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <section style={card}>
        <div style={{ ...label, marginBottom: '12px' }}>Completeness by field — click to filter the list below</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '12px' }}>
          {d.compliance.fields.map((f) => {
            const selected = onlyField === f.column;
            const selectable = f.critical;
            return (
              <div
                key={f.column}
                onClick={() => selectable && setOnlyField(selected ? '' : f.column)}
                title={f.blocks}
                style={{
                  padding: '10px', borderRadius: '8px', cursor: selectable ? 'pointer' : 'default',
                  border: `1px solid ${selected ? '#60a5fa' : 'transparent'}`,
                  background: selected ? 'rgba(96,165,250,0.08)' : 'rgba(148,163,184,0.05)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 600 }}>{f.label}{f.critical && <span style={{ color: '#f87171' }}> *</span>}</span>
                  <span style={{ color: f.missing ? '#fb923c' : '#34d399' }}>{f.missing ? `${f.missing} missing` : 'complete'}</span>
                </div>
                <Bar pct={f.pct} tone={f.pct === 100 ? '#34d399' : f.critical ? '#f87171' : '#facc15'} />
                <div style={{ fontSize: '10px', color: 'var(--text-muted,#7c8595)', marginTop: '6px' }}>{f.blocks}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '10px', flexWrap: 'wrap' }}>
          <div style={label}>
            Incomplete records ({rows.length}{onlyField ? ` missing ${FIELD_LABELS[onlyField] ?? onlyField}` : ''})
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {onlyField && (
              <button onClick={() => setOnlyField('')} className="btn btn-secondary" style={{ fontSize: '11px', padding: '5px 10px' }}>
                Clear filter
              </button>
            )}
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted,#7c8595)' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, code, location"
                style={{
                  padding: '6px 10px 6px 26px', fontSize: '12px', borderRadius: '6px',
                  border: '1px solid var(--border-color,#232833)', background: 'var(--bg-input, #0d1016)',
                  color: 'inherit', minWidth: '220px',
                }}
              />
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <Empty>
            {d.compliance.incompleteCount === 0
              ? 'Every active record has its payroll and duty-of-care fields filled in.'
              : 'No record matches this filter.'}
          </Empty>
        ) : (
          <Table
            head={['Assayer', 'Code', 'Location', 'Stage', 'Missing', '']}
            rows={rows.map((r) => [
              <strong>{r.displayName}</strong>,
              <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{r.assayerCode}</span>,
              [r.district, r.state].filter(Boolean).join(', ') || '—',
              r.lifecycleStatus,
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {r.missing.map((m) => (
                  <span key={m} style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '4px', background: 'rgba(239,68,68,0.12)', color: '#f87171' }}>
                    {FIELD_LABELS[m] ?? m}
                  </span>
                ))}
              </div>,
              <OpenLink label={canManage ? 'Fix' : 'View'} onClick={() => navigate(`/assayers/${r.id}`)} />,
            ])}
          />
        )}
      </section>
    </div>
  );
};

// ── Compliance ─────────────────────────────────────────────────────────────

const ComplianceTab: React.FC<{ d: HrWorkforceOverview; navigate: (p: string) => void }> = ({ d, navigate }) => {
  const { certifications, documents } = d.expiries;
  const gd = d.compliance.governmentDocuments;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <Stat value={certifications.expired + documents.expired} caption="Already expired" tone={certifications.expired + documents.expired ? '#f87171' : '#34d399'} />
        <Stat value={certifications.within30 + documents.within30} caption="Expiring ≤ 30 days" tone={certifications.within30 + documents.within30 ? '#fb923c' : undefined} />
        <Stat value={certifications.within90 + documents.within90} caption="Expiring 31–90 days" />
        <Stat value={`${gd.withGovDoc}/${gd.roster}`} caption="Have an ID document on file" tone={gd.withGovDoc < gd.roster ? '#fb923c' : '#34d399'} />
        <Stat value={`${gd.withFile}/${gd.roster}`} caption="Have any file uploaded" tone={gd.withFile < gd.roster ? '#fb923c' : '#34d399'} />
      </div>

      {gd.withGovDoc === 0 && (
        <div style={{ ...card, borderLeft: '3px solid #f87171', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
          <AlertTriangle size={16} style={{ color: '#f87171', flexShrink: 0, marginTop: '2px' }} />
          <div style={{ fontSize: '13px' }}>
            <strong>No identity document has been recorded for anyone on the roster.</strong>
            <div style={{ color: 'var(--text-muted,#7c8595)', marginTop: '3px' }}>
              Field staff visit client bank branches; identity verification is normally a precondition of that access.
              Upload documents from each assayer's profile to start the verification trail.
            </div>
          </div>
        </div>
      )}

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>Certifications falling due ({certifications.rows.length})</div>
        {certifications.rows.length === 0 ? (
          <Empty>No certification expires within the next 180 days.</Empty>
        ) : (
          <Table
            head={['Assayer', 'Certification', 'Level', 'Expires', 'In', '']}
            rows={certifications.rows.map((r: any) => [
              <strong>{r.displayName}</strong>,
              r.name,
              r.level ?? '—',
              fmtDate(r.expiryDate),
              <ExpiryChip days={r.daysToExpiry} />,
              <OpenLink onClick={() => navigate(`/assayers/${r.assayerId}`)} />,
            ])}
          />
        )}
      </section>

      {documents.rows.length > 0 && (
        <section style={card}>
          <div style={{ ...label, marginBottom: '10px' }}>Identity documents falling due ({documents.rows.length})</div>
          <Table
            head={['Assayer', 'Document', 'Status', 'Expires', 'In', '']}
            rows={documents.rows.map((r: any) => [
              <strong>{r.displayName}</strong>,
              r.documentType,
              r.verificationStatus ?? 'PENDING',
              fmtDate(r.expiryDate),
              <ExpiryChip days={r.daysToExpiry} />,
              <OpenLink onClick={() => navigate(`/assayers/${r.assayerId}`)} />,
            ])}
          />
        </section>
      )}

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>Capability inventory</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
          {([['Skills', d.capability.skills], ['Languages', d.capability.languages], ['Certifications', d.capability.certifications]] as const).map(
            ([title, items]) => (
              <div key={title}>
                <div style={{ ...label, fontSize: '10px', marginBottom: '8px' }}>{title}</div>
                {items.length === 0 ? <Empty>None recorded.</Empty> : items.slice(0, 10).map((s: any) => (
                  <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '3px 0' }}>
                    <span>{s.name}</span>
                    <span style={{ color: 'var(--text-muted,#7c8595)' }}>{s.assayerCount}</span>
                  </div>
                ))}
              </div>
            ),
          )}
        </div>
        {d.capability.unprofiled > 0 && (
          <div style={{ fontSize: '12px', color: '#fb923c', marginTop: '12px' }}>
            {d.capability.unprofiled} assayer(s) have no recorded skill — they cannot be matched on competency during planning.
          </div>
        )}
      </section>
    </div>
  );
};

const ExpiryChip: React.FC<{ days: number }> = ({ days }) => {
  const tone = days < 0 ? '#f87171' : days <= 30 ? '#fb923c' : days <= 90 ? '#facc15' : '#94a3b8';
  return (
    <span style={{ fontSize: '11px', fontWeight: 600, color: tone }}>
      {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`}
    </span>
  );
};

// ── Deployment ─────────────────────────────────────────────────────────────

const DeploymentTab: React.FC<{ d: HrWorkforceOverview }> = ({ d }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
    <div style={{ ...card, fontSize: '13px', color: 'var(--text-secondary,#9aa4b5)' }}>
      Branches carry the work and assayers carry the capacity, so the gap between them is the hiring brief.
      State names are normalised across the branch and assayer imports before comparison — they are spelled
      differently in each source.
    </div>

    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      <Stat value={d.deployment.hiringNeeded.length} caption="Territories needing hires" tone={d.deployment.hiringNeeded.length ? '#f87171' : '#34d399'} />
      <Stat value={d.deployment.territories.length} caption="Territories in play" />
      <Stat value={d.deployment.idleTerritories.length} caption="Assayers with no local work" tone={d.deployment.idleTerritories.length ? '#facc15' : undefined} />
    </div>

    <section style={card}>
      <div style={{ ...label, marginBottom: '10px' }}>Supply vs demand by state</div>
      <Table
        head={['State', 'Branches', 'Assayers', 'Active', 'Branches / assayer', 'Posture']}
        rows={d.deployment.territories.map((t) => {
          const p = POSTURE[t.posture] ?? POSTURE.BALANCED;
          return [
            <strong>{t.state}</strong>,
            t.branches,
            t.assayers,
            t.active,
            t.branchesPerAssayer ?? '—',
            <span title={p.hint} style={{ fontSize: '11px', fontWeight: 700, color: p.fg }}>{p.label}</span>,
          ];
        })}
      />
    </section>
  </div>
);

// ── Utilisation ────────────────────────────────────────────────────────────

const UtilisationTab: React.FC<{ d: HrWorkforceOverview; navigate: (p: string) => void }> = ({ d, navigate }) => {
  const p = d.utilisation.performance;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <Stat value={d.utilisation.idleCount} caption={`No work in ${d.utilisation.idleAfterDays} days`} tone={d.utilisation.idleCount ? '#facc15' : '#34d399'} />
        <Stat value={d.utilisation.neverAssigned} caption="Never assigned" tone={d.utilisation.neverAssigned ? '#fb923c' : undefined}
          hint="Onboarded but never deployed — an onboarding failure rather than a lull" />
        <Stat value={p.avgRating ?? '—'} caption={`Average rating (${p.rated} rated)`} />
        <Stat value={p.onTimeRate === null ? '—' : `${p.onTimeRate}%`} caption="On-time completion" />
        <Stat value={p.belowPar} caption="Rated below 3" tone={p.belowPar ? '#fb923c' : undefined} />
      </div>

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>Idle and never-deployed ({d.utilisation.idle.length})</div>
        {d.utilisation.idle.length === 0 ? (
          <Empty>Everyone active has had work in the last {d.utilisation.idleAfterDays} days.</Empty>
        ) : (
          <Table
            head={['Assayer', 'Location', 'Last assignment', 'Idle', 'Lifetime jobs', '']}
            rows={d.utilisation.idle.map((r) => [
              <strong>{r.displayName}</strong>,
              r.state ?? '—',
              r.lastAssignmentDate ? fmtDate(r.lastAssignmentDate) : <span style={{ color: '#fb923c' }}>never</span>,
              r.daysIdle === null ? '—' : `${r.daysIdle}d`,
              r.totalAssignments ?? 0,
              <OpenLink onClick={() => navigate(`/assayers/${r.id}`)} />,
            ])}
          />
        )}
      </section>

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>Attrition</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <Stat value={d.attrition.exits90d} caption="Exits (90 days)" />
          <Stat value={d.attrition.exits12m} caption="Exits (12 months)" />
          <Stat value={d.attrition.terminations} caption="Terminations" />
          <Stat value={d.attrition.joins90d} caption="Joins (90 days)" />
          <Stat value={`${d.attrition.attritionRate12m}%`} caption="Attrition rate" />
        </div>
        {d.attrition.recent.length === 0 ? (
          <Empty>Nobody has left. Note that joining and exit dates are largely unrecorded, so tenure figures are thin.</Empty>
        ) : (
          <Table
            head={['Assayer', 'State', 'Joined', 'Left', 'Mode']}
            rows={d.attrition.recent.map((r) => [
              <strong>{r.displayName}</strong>, r.state ?? '—', fmtDate(r.joiningDate), fmtDate(r.exitDate),
              <span style={{ color: r.mode === 'TERMINATED' ? '#f87171' : '#94a3b8', fontSize: '11px', fontWeight: 600 }}>{r.mode}</span>,
            ])}
          />
        )}
      </section>
    </div>
  );
};

// ── Activity ───────────────────────────────────────────────────────────────

const ActivityTab: React.FC<{ d: HrWorkforceOverview; navigate: (p: string) => void }> = ({ d, navigate }) => (
  <section style={card}>
    <div style={{ ...label, marginBottom: '4px' }}>Workforce audit trail</div>
    <p style={{ fontSize: '12px', color: 'var(--text-muted,#7c8595)', margin: '0 0 12px' }}>
      Every change to a person's record, in order, with who made it.
    </p>
    {d.activity.length === 0 ? (
      <Empty>No workforce activity recorded yet.</Empty>
    ) : (
      <Table
        head={['When', 'Assayer', 'Event', 'Change', 'By', '']}
        rows={d.activity.map((a) => [
          <span style={{ whiteSpace: 'nowrap', color: 'var(--text-muted,#7c8595)', fontSize: '11px' }}><Clock size={11} /> {fmtWhen(a.occurredAt)}</span>,
          <strong>{a.displayName}</strong>,
          <span style={{ fontSize: '11px' }}>{a.eventType.replace(/_/g, ' ').toLowerCase()}</span>,
          a.previousState || a.newState
            ? <span style={{ fontSize: '11px' }}>{a.previousState ?? '—'} → <strong>{a.newState ?? '—'}</strong></span>
            : (a.remarks ?? '—'),
          a.performedBy ?? 'system',
          <OpenLink onClick={() => navigate(`/assayers/${a.assayerId}`)} />,
        ])}
      />
    )}
  </section>
);

// ── Shared bits ────────────────────────────────────────────────────────────

const OpenLink: React.FC<{ onClick: () => void; label?: string }> = ({ onClick, label: text = 'Open' }) => (
  <button
    onClick={onClick}
    style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '3px', padding: 0 }}
  >
    {text} <ExternalLink size={11} />
  </button>
);

/** Small presentational table — every list on this page has the same shape. */
const Table: React.FC<{ head: string[]; rows: React.ReactNode[][] }> = ({ head, rows }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i} style={{ ...label, textAlign: 'left', padding: '6px 10px 8px', borderBottom: '1px solid var(--border-color,#232833)', whiteSpace: 'nowrap' }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: '1px solid rgba(148,163,184,0.07)' }}>
            {r.map((c, j) => (
              <td key={j} style={{ padding: '8px 10px', verticalAlign: 'middle' }}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default HrWorkspace;
