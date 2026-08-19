import React, { useMemo, useState } from 'react';

/**
 * The searchable chip picker that every "choose from a canonical list" field uses.
 *
 * This pattern was written out by hand three times — the branch form's competencies, the
 * project form's skills/certifications, and the zone form's states — and a fourth and fifth
 * were about to be pasted into the rules page and the client configuration panel. Each copy
 * had drifted slightly (one filtered on the label, one showed no "no match" line, only one
 * preserved a value that is no longer in the vocabulary), so the codebase's one-implementation
 * rule says this belongs in one place.
 *
 * Two behaviours are worth calling out because they are the reason the free-text boxes this
 * replaces were dangerous:
 *
 * - A selected value that is NOT in `options` is still offered, marked "(as recorded)". These
 *   fields are edited long after they were first written, and the vocabulary behind them moves.
 *   Dropping such a value would silently rewrite a client's requirement to whatever the user
 *   clicked to get past the field — exactly the class of silent change this component exists
 *   to prevent.
 * - `options` being empty is a real state, not an error: the workforce vocabulary endpoint is
 *   HR-scoped, so a coordinator may not be able to read it. Callers render their previous free
 *   text box in that case rather than losing the ability to record a requirement at all.
 */
export interface ChipOption {
  value: string;
  label: string;
}

export interface ChipMultiSelectProps {
  options: ChipOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Radio behaviour: picking one clears the other. Used where the field holds a single value. */
  single?: boolean;
  /** Search box appears above the chips once the list is long enough to need one. */
  searchPlaceholder?: string;
  searchThreshold?: number;
  /** Shown inside the chip area when `options` is empty for a reason the caller understands. */
  emptyText?: string;
  noMatchText?: string;
  maxHeight?: number;
  disabled?: boolean;
  'aria-label'?: string;
}

export const ChipMultiSelect: React.FC<ChipMultiSelectProps> = ({
  options,
  value,
  onChange,
  single = false,
  searchPlaceholder = 'Search…',
  searchThreshold = 8,
  emptyText = 'Nothing to choose from.',
  noMatchText = 'No match.',
  maxHeight = 150,
  disabled = false,
  'aria-label': ariaLabel,
}) => {
  const [search, setSearch] = useState('');

  /** Options, plus any selected value the vocabulary no longer contains — see the file comment. */
  const allOptions = useMemo(() => {
    const known = new Set(options.map((o) => o.value));
    const orphans = value.filter((v) => v && !known.has(v)).map((v) => ({ value: v, label: `${v} (as recorded)` }));
    return [...options, ...orphans];
  }, [options, value]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? allOptions.filter((o) => o.label.toLowerCase().includes(q)) : allOptions;
  }, [allOptions, search]);

  const toggle = (v: string) => {
    if (disabled) return;
    if (single) {
      onChange(value.includes(v) ? [] : [v]);
      return;
    }
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };

  return (
    <div>
      {allOptions.length > searchThreshold && (
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={searchPlaceholder}
          disabled={disabled}
          aria-label={searchPlaceholder}
          style={{
            width: '100%', padding: '7px 9px', marginBottom: '6px', background: 'var(--bg-primary)',
            border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)',
            fontSize: '12px', boxSizing: 'border-box',
          }}
        />
      )}
      <div
        role="group"
        aria-label={ariaLabel}
        style={{
          display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight, overflowY: 'auto', padding: '8px',
          background: 'var(--bg-primary)', borderRadius: '6px', border: '1px solid var(--border-color)',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {visible.map((o) => {
          const isSelected = value.includes(o.value);
          return (
            <button
              type="button"
              key={o.value}
              onClick={() => toggle(o.value)}
              disabled={disabled}
              aria-pressed={isSelected}
              style={{
                padding: '4px 8px', borderRadius: '4px', fontSize: '11px', border: 'none',
                cursor: disabled ? 'not-allowed' : 'pointer',
                backgroundColor: isSelected ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: isSelected ? 'var(--on-accent)' : 'var(--text-primary)',
              }}
            >
              {isSelected ? `✓ ${o.label}` : o.label}
            </button>
          );
        })}
        {allOptions.length === 0 && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{emptyText}</span>}
        {allOptions.length > 0 && visible.length === 0 && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{noMatchText}</span>
        )}
      </div>
    </div>
  );
};

export default ChipMultiSelect;
