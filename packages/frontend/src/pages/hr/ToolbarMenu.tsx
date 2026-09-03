import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * A toolbar button that opens a small panel of related actions.
 *
 * The roster's toolbar had six controls in a row — two exports, an upload, a template download,
 * a filters toggle and Add — none of them primary and no two of them about the same thing. A
 * clerk reading it had to decide between "Export this view", "Full roster + pay rates (Excel)"
 * and "Download Template" before they could do anything, and the difference between the first
 * two lived in a tooltip. Grouping by the job — get data out, put data in — leaves one obvious
 * primary action and two doors, which is a toolbar somebody can read in one pass.
 *
 * Children rather than a list of items, because the import group contains a `<label>` wrapping a
 * hidden file input (`UploadExcelControls`), which is not a menu item any generic component
 * would model. Closing on outside click and on Escape is the whole behaviour; there is no
 * roving-focus menu semantics here on purpose, since the contents are ordinary buttons and
 * labels that Tab already reaches in order.
 *
 * It lives in this folder because HR is the only section with this shape of toolbar. The moment
 * a second one wants it, it belongs in components/ui with the rest of the primitives.
 */
export const ToolbarMenu: React.FC<{
  label: string;
  icon?: React.ReactNode;
  /** Given the close function so an action can shut the menu behind it. */
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  panelWidth?: number;
}> = ({ label, icon, children, panelWidth = 240 }) => {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn btn-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 12px' }}
      >
        {icon}
        {label}
        <ChevronDown size={12} style={{ opacity: 0.7 }} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 30,
            minWidth: `${panelWidth}px`,
            display: 'flex', flexDirection: 'column', gap: '8px',
            padding: '10px', borderRadius: '10px',
            background: 'var(--bg-card)', border: '1px solid var(--border-color)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
};

/** One plain action inside a `ToolbarMenu`: a title, a sentence saying what it does, one click. */
export const MenuAction: React.FC<{
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: string;
}> = ({ label, hint, icon, onClick, disabled, tone }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    role="menuitem"
    style={{
      display: 'flex', gap: '8px', alignItems: 'flex-start', textAlign: 'left',
      background: 'none', border: 'none', padding: '6px 7px', borderRadius: '7px',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
      color: 'inherit', width: '100%',
    }}
  >
    {icon && <span style={{ color: tone ?? 'var(--text-muted)', marginTop: '1px' }}>{icon}</span>}
    <span>
      <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 600 }}>{label}</span>
      {hint && (
        <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
          {hint}
        </span>
      )}
    </span>
  </button>
);
