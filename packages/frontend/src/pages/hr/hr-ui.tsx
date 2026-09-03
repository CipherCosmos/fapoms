import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Users, ExternalLink } from 'lucide-react';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';

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

/**
 * The `area` word the backend stamps on each worklist card.
 *
 * hr-workforce.service.ts labels its actions 'Record', 'Compliance', 'Staffing' and
 * 'Utilisation' — internal groupings, printed raw on the Overview cards. A clerk reading
 * "UTILISATION · 8 active assayer(s) have never been assigned" had to work out that the word
 * meant workload, and none of the four matched the tab the card actually sends you to. These
 * say the destination in the words the tabs and chips use, so the card and the screen it opens
 * agree. Unknown areas fall through unchanged — the backend can add one without this hiding it.
 */
export const ACTION_AREA_LABELS: Record<string, string> = {
  Record: 'Personal details',
  Onboarding: 'Onboarding',
  Compliance: 'Certificates & IDs',
  // Distinct from Compliance above, which is about paper that lapses. This one is about whether
  // the person attending is the person we vetted — the concern the drawer's Vetting tab holds.
  Vetting: 'Vetting',
  Staffing: 'Coverage',
  Utilisation: 'Workload',
};

export const actionAreaLabel = (area?: string | null): string =>
  (area && ACTION_AREA_LABELS[area]) || area || '';

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

/**
 * The caption above a fact. 12px is the floor, not a preference.
 *
 * These captions were 11px (and the record's own copy of them 10.5px), which is the size a
 * design system uses for a footnote. The people reading these screens are non-technical clerks
 * working from an office desk, and the caption is frequently the ONLY thing naming a value —
 * "Verdict", "Checked", "Emergency relation". An unreadable caption over a readable value is a
 * value with no name. Uppercase at 11px is worse again: capitals lose the word-shape the eye
 * reads by, so the size has to make up for it.
 */
export const label: React.CSSProperties = {
  fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--text-muted)', fontWeight: 700,
};

// Imported (rather than a pure re-export) because this file also uses fmtWhen itself below;
// re-exported so the 5 pages already importing these from here don't need touching — the one
// definition now lives in utils/dates.ts, same treatment utils/money.ts already got (see
// assayer-shared.ts, which does the same for `money`).
import { fmtWhen } from '../../utils/dates';
export { fmtDate, fmtWhen } from '../../utils/dates';
import { counted } from '../../utils/plural';

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

/**
 * The words under the attrition percentage — written once, because two screens print that number.
 *
 * Both of them explained it differently and one of them explained it wrongly: the Overview tile
 * quoted `headcount.total`, a population that includes everybody who left before the window, so a
 * tile reading 25% was explained underneath by two numbers that work out to 20%. The rate divides
 * by `averageHeadcount12m` — still on the roster plus those who left during the window — and the
 * server sends that denominator so the screen does not have to guess at it. Taking only the
 * attrition block as an argument is the point: there is no other population in reach to quote.
 *
 * `unaccounted` is the part neither number can hold. 25 people left with no leaving date on their
 * record; they are off the roster and cannot be placed inside a twelve-month window, so the rate
 * is computed without them. The server has published that count all along for this reason. Saying
 * it out loud is the difference between a percentage a clerk can defend in a meeting and one that
 * quietly disagrees with the exit count on the same screen.
 */
export const attritionExplainer = (a: HrWorkforceOverview['attrition']): {
  hint: string;
  unaccounted: string | null;
} => ({
  hint: `${counted(a.exits12m, 'person', 'people')} left in the last 12 months, out of `
    + `${a.averageHeadcount12m} on the roster over that period`
    + (a.undatedExits > 0
      ? `. A further ${a.undatedExits} left with no leaving date, so they are in neither number.`
      : ''),
  unaccounted: a.undatedExits > 0
    ? `${counted(a.undatedExits, 'more person', 'more people')} left without a leaving date on `
      + 'their record. There is no way to tell whether they went in the last 12 months, so this '
      + 'percentage is worked out without them — add their leaving dates and it will change.'
    : null,
});

export const OpenLink: React.FC<{ onClick: () => void; label?: string }> = ({ onClick, label: text = 'Open' }) => (
  <button onClick={onClick} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px', padding: 0 }}>
    {text} <ExternalLink size={11} />
  </button>
);

/*
  THERE IS NO `Table` HERE ANY MORE. Use `DataTable` from components/ui, with
  `density="compact"` — that is what this one was, and it is what these pages still look like.

  It took `head: string[]` and `rows: ReactNode[][]`, which is a shorter thing to write and a
  worse thing to own. A conditional column meant writing
  `head={canManage ? ['Client', 'Standing', ''] : ['Client', 'Standing']}` and then pushing the
  matching cell onto an array twenty lines further down the same function: the header and the
  cell beneath it held in the same order by nothing but attention, in five places on the vetting
  tab alone. There was also no key on a row, no sortable header, no empty state and no loading
  state, so every caller that needed one of those either went without or wrote its own — which is
  where the roster's hand-rolled `<table>` came from.
*/

/**
 * Plain-language filter chips for the merged HR pages.
 *
 * Paperwork and "Where people are" each absorbed three former tabs (see HrPaperworkPage and
 * HrWherePeopleArePage for why). The concerns did not go away, so they need a way to be narrowed
 * down to — but as a filter *inside* one destination, not as three destinations that all badge
 * off the same number.
 *
 * The choice lives in the `?view=` query string rather than component state so a chip is
 * linkable and bookmarkable, which is what the old separate URLs bought and what the legacy
 * redirects in HrLayout aim at. Labels are written the way an HR manager would say them out
 * loud; the keys are never shown.
 */
export const ViewChips = <K extends string>({ options, value, onChange }: {
  options: ReadonlyArray<{ key: K; label: string; hint?: string; count?: number | null }>;
  value: K;
  onChange: (key: K) => void;
}) => (
  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }} role="tablist">
    {options.map((o) => {
      const active = o.key === value;
      return (
        <button
          key={o.key}
          role="tab"
          aria-selected={active}
          title={o.hint}
          onClick={() => onChange(o.key)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '7px',
            padding: '7px 14px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
            borderRadius: '999px',
            border: `1px solid ${active ? 'var(--accent)' : 'var(--border-color)'}`,
            // Mixed from the theme's own accent rather than written out as the gold one theme
            // happens to use: rgba(216,174,71,…) is the dark-gold palette's accent, so on the
            // light and flame themes the selected chip was tinted a colour nothing else on the
            // page used. There are eight themes; only one of them was right.
            background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-surface-2)',
            color: active ? 'var(--accent)' : 'var(--text-secondary)',
          }}
        >
          {o.label}
          {o.count !== null && o.count !== undefined && (
            <span style={{
              fontSize: '12px', fontWeight: 700, padding: '1px 7px', borderRadius: '9px',
              background: o.count > 0 ? 'var(--status-cancelled-bg)' : 'var(--bg-surface-2)',
              color: o.count > 0 ? 'var(--danger)' : 'var(--text-muted)',
            }}>{o.count}</span>
          )}
        </button>
      );
    })}
  </div>
);

/**
 * Reads and writes the `?view=` chip selection, falling back to `fallback` for anything
 * unrecognised (an old link, a typo) so a bad value shows a page rather than a blank.
 */
export function useViewParam<K extends string>(keys: ReadonlyArray<K>, fallback: K): [K, (k: K) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('view') as K | null;
  const value = raw && keys.includes(raw) ? raw : fallback;
  const set = (k: K) => {
    const next = new URLSearchParams(params);
    next.set('view', k);
    setParams(next, { replace: true });
  };
  return [value, set];
}
