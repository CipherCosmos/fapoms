import React from 'react';

/**
 * The pieces an admin screen is made of.
 *
 * Every configuration page in this app had been rebuilding the same three shapes inline — a
 * titled card, a labelled row with an explanation, an on/off switch — each slightly differently,
 * so the settings pages drifted away from the rest of the product a little more with each one
 * added. These are those shapes, once.
 *
 * Styling follows the house convention: inline style objects over CSS custom properties, no
 * Tailwind and no component library.
 */

export const SectionCard: React.FC<{
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, icon, actions, children }) => (
  <div className="glass-card" style={{ padding: '20px 22px' }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: description ? '16px' : '14px' }}>
      {icon && <div style={{ color: 'var(--accent)', display: 'flex', marginTop: '1px' }}>{icon}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
        {description && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.5 }}>
            {description}
          </div>
        )}
      </div>
      {actions}
    </div>
    {children}
  </div>
);

/**
 * One setting: what it is, what it does, and what it is currently.
 *
 * The description sits under the label rather than in a tooltip on purpose — the whole reason
 * these values were unreachable before is that nobody could tell what they did without reading
 * the code, and hiding the explanation behind a hover reproduces that for anyone skimming.
 */
export const SettingRow: React.FC<{
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Rendered on the right of the label block — the input itself. */
  control: React.ReactNode;
  /** Small print under the control: where the value came from, when a change applies. */
  footnote?: React.ReactNode;
  /** Right-aligned extras, e.g. a reset button. */
  aside?: React.ReactNode;
  last?: boolean;
}> = ({ label, description, control, footnote, aside, last }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 320px)',
      gap: '20px',
      alignItems: 'start',
      padding: '16px 0',
      borderBottom: last ? 'none' : '1px solid var(--border-hair, var(--border-color))',
    }}
  >
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
      {description && (
        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.55, maxWidth: '62ch' }}>
          {description}
        </div>
      )}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>{control}</div>
        {aside}
      </div>
      {footnote && <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>{footnote}</div>}
    </div>
  </div>
);

/** A real switch rather than a bare checkbox — these turn organisation-wide behaviour on and off. */
export const Toggle: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}> = ({ checked, onChange, disabled, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    style={{
      width: '40px',
      height: '22px',
      flexShrink: 0,
      borderRadius: '11px',
      border: `1px solid ${checked ? 'var(--accent-primary)' : 'var(--border-color)'}`,
      background: checked ? 'var(--accent-primary)' : 'var(--bg-secondary)',
      position: 'relative',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'background 120ms ease, border-color 120ms ease',
      padding: 0,
    }}
  >
    <span
      style={{
        position: 'absolute',
        top: '2px',
        left: checked ? '20px' : '2px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: checked ? 'var(--on-accent, #fff)' : 'var(--text-muted)',
        transition: 'left 120ms ease',
      }}
    />
  </button>
);

/** The house tab strip, extracted from the four pages that had each written their own. */
export const Tabs = <T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ key: T; label: React.ReactNode; count?: number }>;
  active: T;
  onChange: (key: T) => void;
}) => (
  <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid var(--border-color)' }}>
    {tabs.map((t) => (
      <button
        key={t.key}
        onClick={() => onChange(t.key)}
        style={{
          padding: '10px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontSize: '13px',
          fontWeight: 700,
          color: active === t.key ? 'var(--text-primary)' : 'var(--text-muted)',
          borderBottom: active === t.key ? '2px solid var(--accent)' : '2px solid transparent',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        {t.label}
        {t.count !== undefined && (
          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{t.count}</span>
        )}
      </button>
    ))}
  </div>
);

/** Small status word with a tone — "in force", "from environment", "default". */
export const Pill: React.FC<{ tone?: 'accent' | 'muted' | 'success' | 'warning'; children: React.ReactNode }> = ({
  tone = 'muted',
  children,
}) => {
  const colours: Record<string, { bg: string; fg: string }> = {
    accent: { bg: 'rgba(216,174,71,0.14)', fg: 'var(--accent)' },
    muted: { bg: 'var(--border-hair, rgba(255,255,255,0.06))', fg: 'var(--text-muted)' },
    success: { bg: 'rgba(52,168,83,0.14)', fg: 'var(--success, #34a853)' },
    warning: { bg: 'rgba(216,120,71,0.14)', fg: 'var(--warning)' },
  };
  const c = colours[tone];
  return (
    <span
      style={{
        fontSize: '9.5px',
        fontWeight: 800,
        letterSpacing: '0.03em',
        padding: '2px 7px',
        borderRadius: '9px',
        background: c.bg,
        color: c.fg,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
};

/** The one input style these pages share. */
export const controlStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: '6px',
  color: 'var(--text-primary)',
  fontSize: '13px',
  boxSizing: 'border-box',
};
