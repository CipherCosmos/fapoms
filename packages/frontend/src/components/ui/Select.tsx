import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  /** Small muted line under the label, e.g. a count or a hint. */
  sublabel?: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Plain-text form of `label`, used for search matching when `label` is a node. */
  searchText?: string;
}

/**
 * Shared styled dropdown — replaces the browser's native `<select>`, whose menu cannot be
 * themed (it renders as an OS popup outside the page entirely) and whose options cannot carry
 * an icon, a sublabel, or a search box. Every filter, form field and picker in the app funnels
 * through this one component now, via `FilterSelect`, `PlanningWorkspace`'s local `s()` helper,
 * or directly — so fixing an interaction (positioning, keyboard nav, the empty state) here fixes
 * it everywhere at once instead of in forty places that had each hand-rolled their own `<select>`.
 *
 * Portaled to `document.body` for the same reason `Modal` is: several ancestors in this app set
 * `backdrop-filter`, which silently creates a containing block for `position: fixed` children and
 * would clip or mis-position the menu against whatever card the select happens to be opened from.
 */
export const Select: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** Tighter padding/font for dense filter bars. */
  compact?: boolean;
  /** Shows a filter box atop the menu. Defaults to on once there are enough options to need it. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Lets the value be cleared back to '' via an X button, instead of always holding one of `options`. */
  clearable?: boolean;
  leadingIcon?: React.ReactNode;
  menuWidth?: number | string;
  menuMaxHeight?: number;
  style?: React.CSSProperties;
  className?: string;
  id?: string;
  name?: string;
  'aria-label'?: string;
  error?: boolean;
}> = ({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  compact = false,
  searchable,
  searchPlaceholder = 'Search…',
  clearable = false,
  leadingIcon,
  menuWidth,
  menuMaxHeight = 300,
  style,
  className,
  id,
  name,
  error = false,
  ...aria
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Forces a re-render (and so a re-measured trigger rect) while open, so the menu tracks the
  // trigger across scroll/resize instead of a portal frozen at the position it opened at.
  const [, forceTick] = useState(0);

  const effectiveSearchable = searchable ?? options.length > 7;

  const filterOptions = (q: string) => {
    if (!effectiveSearchable || !q.trim()) return options;
    const needle = q.trim().toLowerCase();
    return options.filter((o) => {
      const text = o.searchText ?? (typeof o.label === 'string' ? o.label : '');
      return text.toLowerCase().includes(needle);
    });
  };

  const filtered = useMemo(() => filterOptions(query), [options, query, effectiveSearchable]);

  const selected = options.find((o) => o.value === value);

  /**
   * `query`/`highlight` state read directly from these closures lagged behind real key input:
   * a fast typist's last keystroke and the Enter that followed it could both land before React
   * committed the re-render each was scheduled from, so Enter would select whatever was
   * highlighted *before* that keystroke — one option off, or the default. Refs updated in the
   * same tick as the state setter give the keyboard handlers a value that is never stale,
   * independent of when React gets around to painting.
   */
  const queryRef = useRef('');
  const highlightRef = useRef(0);
  const setQueryTracked = (q: string) => { queryRef.current = q; setQuery(q); };
  const setHighlightTracked = (h: number) => { highlightRef.current = h; setHighlight(h); };

  useEffect(() => {
    if (!open) return;
    setQueryTracked('');
    const selectedIdx = options.findIndex((o) => o.value === value);
    setHighlightTracked(selectedIdx >= 0 ? selectedIdx : 0);
    // Autofocus the filter box when present; otherwise keep focus on the panel for arrow keys.
    const t = setTimeout(() => {
      if (effectiveSearchable) searchRef.current?.focus();
      else panelRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(target) &&
        panelRef.current && !panelRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onReposition = () => forceTick((n) => n + 1);
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open]);

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    const currentFiltered = filterOptions(queryRef.current);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightTracked(Math.min(highlightRef.current + 1, currentFiltered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightTracked(Math.max(highlightRef.current - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const opt = currentFiltered[highlightRef.current];
      if (opt && !opt.disabled) commit(opt.value);
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const rect = open ? triggerRef.current?.getBoundingClientRect() : undefined;
  const GUTTER = 8;
  let top = 0;
  let left = 0;
  let width: number | string = menuWidth ?? Math.max(rect?.width ?? 0, 200);
  if (rect) {
    const estimatedHeight = Math.min(menuMaxHeight, filtered.length * 34 + (effectiveSearchable ? 44 : 0) + 8) + 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < estimatedHeight + GUTTER && rect.top > estimatedHeight + GUTTER;
    top = flipUp ? Math.max(GUTTER, rect.top - estimatedHeight - 4) : rect.bottom + 4;
    const numericWidth = typeof width === 'number' ? width : rect.width;
    left = Math.min(Math.max(GUTTER, rect.left), window.innerWidth - numericWidth - GUTTER);
  }

  const pad = compact ? '7px 10px' : '8px 12px';
  const fontSize = compact ? '12px' : '13px';

  return (
    <>
      <div
        className={className}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: style?.width ?? undefined,
          padding: pad,
          fontSize,
          background: disabled ? 'var(--bg-tertiary)' : 'var(--bg-input)',
          border: `1px solid ${error ? 'var(--danger)' : open ? 'var(--accent-primary)' : 'var(--border-color)'}`,
          borderRadius: 'var(--radius-sm)',
          color: selected ? 'var(--text-primary)' : 'var(--text-muted)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          boxShadow: open ? '0 0 0 3px color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'none',
          transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
          textAlign: 'left',
          ...style,
        }}
      >
        {/* The actual focusable/keyboard-operable control. Kept separate from the clear
            button below it so the two are real siblings, not one interactive element
            nested inside another — a <span role="button"> used to sit inside this button,
            which meant it could never receive keyboard focus and had no keyboard path. */}
        <button
          ref={triggerRef}
          type="button"
          id={id}
          disabled={disabled}
          onKeyDown={onTriggerKeyDown}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={aria['aria-label']}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flex: 1,
            minWidth: 0,
            background: 'none',
            border: 'none',
            padding: 0,
            margin: 0,
            font: 'inherit',
            color: 'inherit',
            cursor: disabled ? 'not-allowed' : 'pointer',
            outline: 'none',
            textAlign: 'left',
          }}
        >
          {leadingIcon && <span style={{ display: 'flex', flexShrink: 0, color: 'var(--text-muted)' }}>{leadingIcon}</span>}
          {selected?.icon && <span style={{ display: 'flex', flexShrink: 0 }}>{selected.icon}</span>}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected ? selected.label : placeholder}
          </span>
        </button>
        {clearable && value && !disabled && (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={(e) => { e.stopPropagation(); commit(''); }}
            style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0 }}
          >
            <X size={13} />
          </button>
        )}
        <ChevronDown
          size={14}
          style={{
            flexShrink: 0,
            color: 'var(--text-muted)',
            transition: 'transform var(--transition-fast)',
            transform: open ? 'rotate(180deg)' : 'none',
          }}
        />
      </div>
      {name && <input type="hidden" name={name} value={value} />}

      {open && rect && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          tabIndex={-1}
          // Only one of {this, the search input below} ever holds focus at a time — binding the
          // same handler to both meant a keydown on the input bubbled here and ran it a second
          // time on the same keystroke, double-advancing the highlighted option.
          onKeyDown={effectiveSearchable ? undefined : onPanelKeyDown}
          style={{
            position: 'fixed',
            top,
            left,
            width,
            maxHeight: menuMaxHeight,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-surface-2)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg), 0 24px 50px rgba(0,0,0,0.35)',
            zIndex: 999999,
            outline: 'none',
            animation: 'fapoms-select-in 0.12s ease-out',
          }}
        >
          {effectiveSearchable && (
            <div style={{ position: 'relative', padding: '8px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
              <Search size={13} style={{ position: 'absolute', left: '18px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => { setQueryTracked(e.target.value); setHighlightTracked(0); }}
                onKeyDown={onPanelKeyDown}
                placeholder={searchPlaceholder}
                style={{
                  width: '100%',
                  padding: '6px 8px 6px 28px',
                  fontSize: '12.5px',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  outline: 'none',
                }}
              />
            </div>
          )}
          <div style={{ overflowY: 'auto', padding: '4px' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '16px 10px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
                No matches
              </div>
            ) : (
              filtered.map((o, i) => {
                const isSelected = o.value === value;
                const isHighlighted = i === highlight;
                return (
                  <div
                    key={o.value}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={o.disabled}
                    onMouseEnter={() => setHighlightTracked(i)}
                    onClick={() => !o.disabled && commit(o.value)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      cursor: o.disabled ? 'not-allowed' : 'pointer',
                      opacity: o.disabled ? 0.45 : 1,
                      background: isHighlighted ? 'var(--bg-tertiary)' : isSelected ? 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' : 'transparent',
                      color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)',
                      fontWeight: isSelected ? 600 : 500,
                    }}
                  >
                    {o.icon && <span style={{ display: 'flex', flexShrink: 0 }}>{o.icon}</span>}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</div>
                      {o.sublabel && (
                        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 400, marginTop: '1px' }}>{o.sublabel}</div>
                      )}
                    </span>
                    {isSelected && <Check size={13} style={{ flexShrink: 0 }} />}
                  </div>
                );
              })
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
