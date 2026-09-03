import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Users, ExternalLink, AlertTriangle, Info } from 'lucide-react';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { Modal } from '../../components/ui';

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

/**
 * The one line saying what a screen is asking of the person reading it.
 *
 * Every screen in this section opened on figures. A clerk arriving at Pay & terms met four tiles
 * and a table of rupee amounts with nothing anywhere saying what they were expected to *do* about
 * them, and the vetting tab opened straight onto a card headed "Vetting" — a noun, not a request.
 * Numbers are the evidence for the ask; they are not the ask, and a worklist that never states
 * one is read as a report and closed.
 *
 * Deliberately one sentence and deliberately at the top. Two sentences here becomes a paragraph
 * nobody reads, and the same words further down are found only by whoever was already scrolling.
 */
export const Lede: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p style={{
    fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.55,
    margin: '0 0 14px', maxWidth: '86ch',
  }}>
    {children}
  </p>
);

/**
 * "Here is something about this list you need to know before you act on it."
 *
 * There were seven of these across five screens and no two looked alike: a left border on Pay &
 * terms, a full amber outline on the vetting tab, a tinted red panel with its own radius on the
 * skills panel, and a plain card with no icon at all on Workload. Same job, four visual
 * languages — so the eye had to learn each screen separately instead of learning the product
 * once, and the one on Workload did not read as a notice at all.
 *
 * The left border is the pattern kept, because it was already the most-used of the four and it
 * marks the block without boxing it in. `AlertBanner` is a different thing and stays a different
 * thing: that one is a **failure** — something went wrong and can be dismissed. This one is a
 * standing condition of the data that no amount of dismissing changes.
 */
const NOTICE_TONES = {
  info: { colour: 'var(--accent)', Icon: Info },
  warning: { colour: 'var(--warning)', Icon: AlertTriangle },
  danger: { colour: 'var(--danger)', Icon: AlertTriangle },
} as const;

export const Notice: React.FC<{
  tone?: keyof typeof NOTICE_TONES;
  /** Bolded first line, for a notice whose point is a count or a verdict. */
  title?: React.ReactNode;
  /**
   * This notice sits *inside* another card, so it drops the rounded corners and the outer border
   * and divides with a hairline instead. Without it the review queue's banner was a rounded card
   * floating inside a rounded card, and the call site was reaching past this component with four
   * style overrides to stop it — which is how one component quietly becomes two.
   */
  flush?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ tone = 'info', title, flush, children, style }) => {
  const { colour, Icon } = NOTICE_TONES[tone];
  return (
    <div style={{
      ...card,
      ...(flush
        ? { borderRadius: 0, border: 'none', borderBottom: '1px solid var(--border-hair)', padding: '10px 14px' }
        : {}),
      borderLeft: `3px solid ${colour}`,
      display: 'flex', gap: '9px', alignItems: 'flex-start', fontSize: '12.5px', ...style,
    }}>
      <Icon size={15} style={{ color: colour, flexShrink: 0, marginTop: '1px' }} />
      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.55, minWidth: 0 }}>
        {title && <div style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
};

/**
 * A titled block of one screen, with an optional count and one action.
 *
 * Lifted out of the vetting tab, where it was defined privately, because the Workload and
 * Qualification screens were each hand-rolling `<div style={card}><div style={label}>…` to
 * produce the same shape a few pixels differently.
 *
 * `count` is a prop rather than something the caller writes into `title` because the three
 * screens all showed counts and all showed them differently: "Workload, person by person (14)",
 * "3 record problems to review", and a bare number in a tile. One place decides, so a count
 * always looks like a count and never like part of the heading.
 */
export const Section: React.FC<{
  title: React.ReactNode;
  icon?: React.ElementType;
  hint?: React.ReactNode;
  count?: number | null;
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ title, icon: Icon, hint, count, action, children, style }) => (
  <div style={{ ...card, ...style }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: hint ? '4px' : '10px' }}>
      {Icon && <Icon size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
      <div style={{ ...label, flex: 1 }}>
        {title}
        {count !== null && count !== undefined && (
          <span style={{ color: 'var(--text-muted)', fontWeight: 700, marginLeft: '7px' }}>{count}</span>
        )}
      </div>
      {action}
    </div>
    {hint && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px', lineHeight: 1.5 }}>{hint}</div>}
    {children}
  </div>
);

/**
 * The text button used inside a card or a table row — Change, Remove, Record call, Decide this.
 *
 * Four files had written their own: a `linkButton` style object on the vetting tab, two inline
 * copies on the skills panel, one on the review queue, and `OpenLink` below, which is this with
 * an icon welded on. They disagreed about size and weight, so the same act was a slightly
 * different control depending on which screen you were looking at.
 *
 * `label` is separate from `children` for the icon-only case: a button whose face is a trash can
 * still has to say what it removes, and taking the accessible name as a required prop is how that
 * stops being something each call site remembers or forgets.
 */
const LINK_TONES = {
  accent: 'var(--primary)',
  danger: 'var(--danger)',
  muted: 'var(--text-muted)',
} as const;

export const LinkButton: React.FC<{
  onClick: () => void;
  children?: React.ReactNode;
  tone?: keyof typeof LINK_TONES;
  icon?: React.ReactNode;
  /** The accessible name. Required when there is no text on the button's face. */
  label?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}> = ({ onClick, children, tone = 'accent', icon, label: name, disabled, style }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={name}
    title={name}
    style={{
      background: 'none', border: 'none', padding: 0,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
      color: LINK_TONES[tone], fontSize: '12px', fontWeight: 600,
      display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {icon}{children}
  </button>
);

/** The trailing action cell of a table row, spaced the same on every table in the section. */
export const RowActions: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>{children}</div>
);

/**
 * A text box on an HR form. There were five of these — `inputStyle` on the vetting tab, `input`
 * on the skills panel, another `input` in the pay dialog, and two written inline — differing in
 * padding, radius and whether they set `fontFamily`, so a form assembled from two screens' worth
 * of habits had boxes of two different heights next to each other.
 */
export const fieldInput: React.CSSProperties = {
  width: '100%', padding: '7px 9px', fontSize: '12.5px',
  background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: '7px', fontFamily: 'inherit',
  boxSizing: 'border-box',
};

/** A caption over the control it names. `wide` takes the whole row, for a sentence-length value. */
export const Field: React.FC<{
  title: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; wide?: boolean;
}> = ({ title, hint, children, wide }) => (
  <div style={{ flex: wide ? '1 1 100%' : '1 1 150px', minWidth: 0 }}>
    <div style={{ ...label, marginBottom: '5px' }}>{title}</div>
    {hint && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '5px', lineHeight: 1.5 }}>{hint}</div>}
    {children}
  </div>
);

/**
 * THE small form. Filling in a few boxes and saving them is one act, so it has one surface.
 *
 * It had four on the vetting tab alone. Recording a background check, adding a reference and
 * typing an identity number each opened a panel that expanded *inside* the card — pushing the
 * table the clerk had just clicked in halfway down the page — while changing a client standing
 * opened a dialog. Four surfaces, four hand-written footers, and between them four different
 * primary buttons: `7px 14px` at 12.5px, `8px 16px` at 13px, `7px 13px` at 12.5px, and the
 * app's own `.btn btn-primary`. The skills panel and the review queue had a fifth and a sixth.
 *
 * A dialog rather than the inline panel, for all of them, because the inline panel was the half
 * that behaved worst: the page reflowed under the pointer on open, the form could be scrolled off
 * screen while it was still unsaved, and nothing stopped two of them being open at once. The
 * footer is `.btn btn-secondary` / `.btn btn-primary` — the app's global buttons, which is the one
 * of the six that was not invented here.
 *
 * `onSave` is wired to the form's submit, so Enter saves from any box in it. That was true on the
 * skills panel (which had bound Enter by hand) and nowhere else.
 */
export const Editor: React.FC<{
  title: React.ReactNode;
  /** One line saying what saving this will mean, where that is not obvious from the boxes. */
  intro?: React.ReactNode;
  /** Small print beside the buttons — a caveat that belongs at the moment of pressing Save. */
  note?: React.ReactNode;
  onCancel: () => void;
  onSave: () => void;
  saveLabel: string;
  busy?: boolean;
  saveDisabled?: boolean;
  width?: number;
  children: React.ReactNode;
}> = ({ title, intro, note, onCancel, onSave, saveLabel, busy, saveDisabled, width = 480, children }) => (
  <Modal
    open
    onClose={onCancel}
    title={title}
    width={width}
    asForm
    onSubmit={(e) => { e.preventDefault(); onSave(); }}
    footer={(
      <>
        {note && (
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginRight: 'auto', maxWidth: '52ch', lineHeight: 1.5, textAlign: 'left' }}>
            {note}
          </span>
        )}
        <button type="button" onClick={onCancel} className="btn btn-secondary" style={{ fontSize: '12px', padding: '8px 14px' }}>
          Cancel
        </button>
        <button type="submit" disabled={busy || saveDisabled} className="btn btn-primary" style={{ fontSize: '12px', padding: '8px 14px' }}>
          {busy ? 'Saving…' : saveLabel}
        </button>
      </>
    )}
  >
    {intro && <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.55 }}>{intro}</div>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>{children}</div>
  </Modal>
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
  <LinkButton onClick={onClick} style={{ color: 'var(--accent)' }}>
    {text} <ExternalLink size={11} />
  </LinkButton>
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
