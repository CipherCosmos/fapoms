import React, { useMemo, useState } from 'react';
import { X, Search, ChevronDown, ChevronRight } from 'lucide-react';

import {
  FILTER_GROUPS, ROSTER_FILTERS, applyRosterFilters, availableFilters, describeFilters,
  fieldChoices, ruleChoices, toggleChoice, clearFilter,
  type RosterFilter, type RosterFilterState, type RosterPerson,
} from './roster-filters';
import { counted } from '../../utils/plural';

/**
 * The filter panel, and the bar that says what it did.
 *
 * Deliberately NOT a query builder. A clerk gets a list of questions with tick boxes and a count
 * beside every option, which is the interaction they already know from every shopping site;
 * nobody has to learn what a clause is, and there is no way to build something that returns
 * nothing for a reason the screen cannot explain. The counts are what make it usable at 1,163
 * people: an option reading 0 is a question already answered, and one reading 245 is where the
 * work is.
 *
 * Everything applied is shown as a removable pill above the table. That is the other half of the
 * brief — a filter you cannot see is a filter you cannot undo — and it is why the segment chip
 * and the search box appear there too, even though they are not part of this panel.
 */

const FONT = { small: '12px', body: '12.5px', heading: '13px' };

/** One tick box with its count. The count is the option's whole value: it says whether to bother. */
const ChoiceRow: React.FC<{
  label: string;
  count: number;
  checked: boolean;
  onToggle: () => void;
}> = ({ label, count, checked, onToggle }) => (
  <label
    style={{
      display: 'flex', alignItems: 'center', gap: '7px', padding: '3px 2px',
      fontSize: FONT.body, cursor: 'pointer',
      // A zero option stays readable and stays clickable — it is an answer ("nobody is in that
      // state"), and hiding it would make the panel change shape as people are filtered.
      color: count === 0 && !checked ? 'var(--text-muted)' : 'var(--text-primary)',
    }}
  >
    <input type="checkbox" checked={checked} onChange={onToggle} style={{ cursor: 'pointer', margin: 0 }} />
    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {label}
    </span>
    <span style={{ fontSize: FONT.small, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
      {count}
    </span>
  </label>
);

const SHOWN_BEFORE_MORE = 6;

/** One filter: its name, its options, and — for the long ones — a way to find an option. */
const FilterBlock: React.FC<{
  def: RosterFilter;
  state: RosterFilterState;
  /** The people this filter would be choosing from: everything else applied, this axis open. */
  scope: RosterPerson[];
  onChange: (next: RosterFilterState) => void;
}> = ({ def, state, scope, onChange }) => {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

  const options = useMemo(
    () => (def.kind === 'field' ? fieldChoices(def, scope) : def.kind === 'rule' ? ruleChoices(def, scope) : []),
    [def, scope],
  );
  const chosen = state.choices[def.key] ?? [];
  const range = state.ranges[def.key] ?? {};

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // A chosen option always stays on screen, even when the search box or the six-row cap would
  // otherwise hide it — a tick you cannot see is a tick you cannot untick.
  const visible = expanded || matching.length <= SHOWN_BEFORE_MORE
    ? matching
    : [...matching.slice(0, SHOWN_BEFORE_MORE), ...matching.slice(SHOWN_BEFORE_MORE).filter((o) => chosen.includes(o.value))];

  const setRange = (half: 'from' | 'to', value: string) => {
    const next = { ...range, [half]: value || undefined };
    const ranges = { ...state.ranges };
    if (next.from || next.to) ranges[def.key] = next; else delete ranges[def.key];
    onChange({ ...state, ranges });
  };

  return (
    <fieldset
      style={{
        border: 'none', margin: 0, padding: 0, minWidth: '190px', flex: '1 1 200px', maxWidth: '260px',
      }}
    >
      <legend style={{
        fontSize: FONT.small, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
        color: 'var(--text-muted)', padding: 0, marginBottom: '4px',
      }}>
        {def.label}
        {chosen.length > 0 && (
          <span style={{ color: 'var(--accent)', marginLeft: '5px' }}>· {chosen.length}</span>
        )}
      </legend>
      {def.hint && (
        <div style={{ fontSize: FONT.small, color: 'var(--text-muted)', lineHeight: 1.45, marginBottom: '5px' }}>
          {def.hint}
        </div>
      )}

      {def.kind === 'date' ? (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {(['from', 'to'] as const).map((half) => (
            <label key={half} style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: FONT.small, color: 'var(--text-muted)' }}>
              {half === 'from' ? 'From' : 'To'}
              <input
                type="date"
                value={range[half] ?? ''}
                onChange={(e) => setRange(half, e.target.value)}
                aria-label={`${def.label} — ${half === 'from' ? 'from' : 'to'}`}
                style={{
                  fontSize: FONT.body, padding: '5px 6px', borderRadius: '6px', colorScheme: 'inherit',
                  border: '1px solid var(--border-color)', background: 'var(--bg-page)', color: 'inherit',
                }}
              />
            </label>
          ))}
        </div>
      ) : (
        <>
          {options.length > 8 && (
            <div style={{ position: 'relative', marginBottom: '4px' }}>
              <Search size={11} style={{ position: 'absolute', left: '7px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Find a ${def.label.toLowerCase()}…`}
                aria-label={`Find a value under ${def.label}`}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '4px 6px 4px 22px', fontSize: FONT.small,
                  borderRadius: '6px', border: '1px solid var(--border-color)',
                  background: 'var(--bg-page)', color: 'inherit', outline: 'none',
                }}
              />
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {visible.map((o) => (
              <ChoiceRow
                key={o.value}
                label={o.label}
                count={o.count}
                checked={chosen.includes(o.value)}
                onToggle={() => onChange(toggleChoice(state, def.key, o.value))}
              />
            ))}
            {matching.length === 0 && (
              <span style={{ fontSize: FONT.small, color: 'var(--text-muted)' }}>Nothing matches that.</span>
            )}
          </div>
          {matching.length > SHOWN_BEFORE_MORE && (
            <button
              onClick={() => setExpanded((v) => !v)}
              style={{
                background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
                fontSize: FONT.small, fontWeight: 600, color: 'var(--accent)',
              }}
            >
              {expanded ? 'Show fewer' : `Show all ${matching.length}`}
            </button>
          )}
        </>
      )}
    </fieldset>
  );
};

/**
 * The panel itself: four headed groups, each collapsible, opening on the group most people want.
 *
 * Nineteen filters in one flat list is the clutter this screen was asked to get rid of, not a
 * cure for it. Grouped, a clerk looking for "district" reads one heading instead of nineteen
 * labels.
 */
export const RosterFilterPanel: React.FC<{
  rows: RosterPerson[];
  state: RosterFilterState;
  onChange: (next: RosterFilterState) => void;
  onClearAll: () => void;
}> = ({ rows, state, onChange, onClearAll }) => {
  const defs = useMemo(() => availableFilters(rows), [rows]);
  const [openGroups, setOpenGroups] = useState<string[]>(['person', 'place', 'paperwork', 'dates']);

  /**
   * The population each axis counts against: everything else applied, that axis left open.
   *
   * Computed per filter rather than once, because a count that included the filter's own
   * selection would zero every option the reader has not already ticked — see `applyRosterFilters`.
   */
  const scopes = useMemo(() => {
    const out: Record<string, RosterPerson[]> = {};
    for (const def of defs) out[def.key] = applyRosterFilters(rows, state, defs, def.key);
    return out;
  }, [rows, state, defs]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '12px',
      padding: '12px 14px', borderRadius: '10px',
      background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: FONT.small, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Tick as many as you like. Options under one heading widen the list; separate headings
          narrow it. The number beside each option is how many people it would leave.
        </span>
        <button
          onClick={onClearAll}
          className="btn btn-secondary"
          style={{ fontSize: FONT.small, padding: '5px 10px', marginLeft: 'auto' }}
        >
          Clear every filter
        </button>
      </div>

      {FILTER_GROUPS.map((group) => {
        const inGroup = defs.filter((d) => d.group === group.key);
        if (inGroup.length === 0) return null;
        const open = openGroups.includes(group.key);
        const chosenHere = inGroup.reduce(
          (n, d) => n + (state.choices[d.key]?.length ?? 0) + (state.ranges[d.key]?.from || state.ranges[d.key]?.to ? 1 : 0),
          0,
        );
        return (
          <div key={group.key}>
            <button
              onClick={() => setOpenGroups((g) => (open ? g.filter((k) => k !== group.key) : [...g, group.key]))}
              aria-expanded={open}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
                background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
                fontSize: FONT.heading, fontWeight: 700, color: 'var(--text-primary)',
              }}
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {group.label}
              {chosenHere > 0 && (
                <span style={{ fontSize: FONT.small, fontWeight: 600, color: 'var(--accent)' }}>
                  · {chosenHere} chosen
                </span>
              )}
            </button>
            {open && (
              <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', padding: '8px 0 4px 19px' }}>
                {inGroup.map((def) => (
                  <FilterBlock
                    key={def.key}
                    def={def}
                    state={state}
                    scope={scopes[def.key] ?? rows}
                    onChange={onChange}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * What is currently narrowing the list, as pills you can take off one at a time.
 *
 * This is the part that makes combining filters safe. Before it, four separate controls could be
 * in force at once — a segment chip, a stage dropdown, a state dropdown and a search box — with
 * the dropdowns behind a collapsed panel, so an empty table had no visible cause. Every criterion
 * now shows itself in the words of the control that set it, and each one comes off on its own.
 */
export const AppliedFilterBar: React.FC<{
  state: RosterFilterState;
  shown: number;
  total: number;
  onChange: (next: RosterFilterState) => void;
  onClearAll: () => void;
}> = ({ state, shown, total, onChange, onClearAll }) => {
  const applied = useMemo(() => describeFilters(state, ROSTER_FILTERS), [state]);
  if (applied.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: FONT.small, fontWeight: 700, color: 'var(--text-muted)' }}>
        Showing {shown} of {counted(total, 'person', 'people')}:
      </span>
      {applied.map((pill) => (
        <button
          key={`${pill.key}:${pill.value ?? ''}`}
          onClick={() => onChange(clearFilter(state, pill.key, pill.value))}
          aria-label={`Remove filter ${pill.label}`}
          title={`Remove ${pill.label}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '3px 8px', borderRadius: '999px', cursor: 'pointer',
            fontSize: FONT.small, fontWeight: 600,
            border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
            background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
            color: 'var(--accent)',
          }}
        >
          {pill.label}
          <X size={11} />
        </button>
      ))}
      <button
        onClick={onClearAll}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: '3px 4px',
          fontSize: FONT.small, fontWeight: 700, color: 'var(--text-secondary)', textDecoration: 'underline',
        }}
      >
        Clear all
      </button>
    </div>
  );
};
