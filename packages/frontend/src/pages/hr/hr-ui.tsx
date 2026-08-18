import React from 'react';
import { Link } from 'react-router-dom';
import { Users, ExternalLink } from 'lucide-react';
import type { HrWorkforceOverview, HrAction } from '../../hooks/useHrWorkforce';

/**
 * Presentation shared by every HR page.
 *
 * These lived inside the single HrWorkspace file when HR was one screen. Splitting that screen
 * into pages meant either duplicating them or lifting them out; they are lifted, so the pages
 * cannot drift into looking like different products.
 */

export const SEVERITY: Record<string, { bg: string; fg: string; label: string }> = {
  critical: { bg: 'var(--status-cancelled-bg)', fg: 'var(--danger)', label: 'Critical' },
  high: { bg: 'var(--status-pending-bg)', fg: 'var(--warning)', label: 'High' },
  medium: { bg: 'var(--status-pending-bg)', fg: 'var(--warning)', label: 'Medium' },
  low: { bg: 'var(--bg-surface-2)', fg: 'var(--text-muted)', label: 'Low' },
};

export const POSTURE: Record<string, { fg: string; label: string; hint: string }> = {
  NO_COVERAGE: { fg: 'var(--danger)', label: 'No coverage', hint: 'Branches here cannot be staffed at all' },
  STRETCHED: { fg: 'var(--warning)', label: 'Stretched', hint: 'Too much work per assayer' },
  BALANCED: { fg: 'var(--success)', label: 'Balanced', hint: 'Supply matches demand' },
  SURPLUS: { fg: 'var(--accent)', label: 'Surplus', hint: 'More capacity than work' },
  NO_WORK: { fg: 'var(--text-muted)', label: 'No work', hint: 'Assayers here have no branches' },
};

export const card: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md, 10px)',
  padding: '16px',
};

export const label: React.CSSProperties = {
  fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--text-muted)', fontWeight: 700,
};

export const FIELD_LABELS: Record<string, string> = {
  pan_number: 'PAN', bank_account_number: 'Bank a/c', ifsc_code: 'IFSC',
  joining_date: 'Joining date', emergency_contact_phone: 'Emergency contact',
};

// Imported (rather than a pure re-export) because this file also uses fmtWhen itself below;
// re-exported so the 5 pages already importing these from here don't need touching — the one
// definition now lives in utils/dates.ts, same treatment utils/money.ts already got (see
// assayer-shared.ts, which does the same for `money`).
import { fmtDate, fmtWhen } from '../../utils/dates';
export { fmtDate, fmtWhen };

/** A number with a caption, and optionally a tone when it represents a problem. */
export const Stat: React.FC<{ value: React.ReactNode; caption: string; tone?: string; hint?: string }> = ({
  value, caption, tone, hint,
}) => (
  <div style={{ ...card, flex: '1 1 150px', minWidth: 0 }} title={hint}>
    <div style={{ fontSize: '26px', fontWeight: 700, color: tone ?? 'var(--text-primary)', lineHeight: 1.1 }}>
      {value}
    </div>
    <div style={{ ...label, marginTop: '6px' }}>{caption}</div>
  </div>
);

/** Horizontal completeness bar — the shape reads faster than the percentage. */
export const Bar: React.FC<{ pct: number; tone: string }> = ({ pct, tone }) => (
  <div style={{ height: '6px', borderRadius: '3px', background: 'var(--bg-surface-2)', overflow: 'hidden' }}>
    <div style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%`, height: '100%', background: tone, transition: 'width .3s' }} />
  </div>
);

export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
    {children}
  </div>
);

export const HrHeader: React.FC<{ data: HrWorkforceOverview; canManage: boolean }> = ({ data, canManage }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
    <div>
      <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>Workforce</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '4px' }}>
        {data.headcount.active} active · {data.headcount.onboarding} onboarding · {data.headcount.exited} exited
        {' · '}updated {fmtWhen(data.generatedAt)}
      </p>
    </div>
    <Link to="/hr/roster" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px', textDecoration: 'none' }}>
      <Users size={14} /> {canManage ? 'Manage roster' : 'View roster'}
    </Link>
  </div>
);

/** Severity chip for a worklist row. */
export const SeverityChip: React.FC<{ severity: HrAction['severity'] }> = ({ severity }) => {
  const s = SEVERITY[severity] ?? SEVERITY.low;
  return (
    <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
};

export const OpenLink: React.FC<{ onClick: () => void; label?: string }> = ({ onClick, label: text = 'Open' }) => (
  <button onClick={onClick} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px', padding: 0 }}>
    {text} <ExternalLink size={11} />
  </button>
);

export const Table: React.FC<{ head: string[]; rows: React.ReactNode[][] }> = ({ head, rows }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} style={{ ...label, textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border-hair)' }}>
            {r.map((c, j) => (
              <td key={j} style={{ padding: '9px 10px', color: 'var(--text-secondary)', verticalAlign: 'middle' }}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const ExpiryChip: React.FC<{ days: number }> = ({ days }) => {
  const tone = days < 0
    ? { bg: 'var(--status-cancelled-bg)', fg: 'var(--danger)' }
    : days <= 30
      ? { bg: 'var(--status-pending-bg)', fg: 'var(--warning)' }
      : { bg: 'var(--bg-surface-2)', fg: 'var(--text-muted)' };
  return (
    <span style={{ fontSize: '10.5px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px', background: tone.bg, color: tone.fg }}>
      {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d left`}
    </span>
  );
};
