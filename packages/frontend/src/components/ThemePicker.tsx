import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, Palette } from 'lucide-react';
import {
  THEMES,
  ACCENTS,
  CUSTOM_BASES,
  CUSTOM_THEME_ID,
  readableOnAccent,
  useTheme,
} from '../hooks/useTheme';

const GROUPS: Array<{ key: string; label: string }> = [
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
  { key: 'glass', label: 'Glass' },
];

const CUSTOM_BASE_LABELS: Record<string, string> = {
  gold: 'Light',
  noir: 'Dark',
  'glass-light': 'Glass L',
  'glass-dark': 'Glass D',
};

export const ThemePicker: React.FC = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme, custom, setCustom, customActive, currentTheme } = useTheme();

  const base = CUSTOM_BASES.find((b) => b.id === custom.base) ?? CUSTOM_BASES[1];

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current && panelRef.current && !ref.current.contains(target) && !panelRef.current.contains(target)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // Anchor the portaled dropdown to the trigger button's viewport position so it
  // is never clipped by .main-area's overflow or buried under sibling overlays.
  const rect = ref.current?.getBoundingClientRect();

  const selectBase = (id: string) => {
    setCustom({ base: id });
    setTheme(CUSTOM_THEME_ID);
  };

  const selectAccent = (hex: string) => {
    setCustom({ accent: hex });
    setTheme(CUSTOM_THEME_ID);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        aria-label="Choose theme"
        aria-haspopup="true"
        aria-expanded={open}
        title="Choose theme"
        style={{
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-color)',
          color: 'var(--text-secondary)',
          padding: '6px 10px',
          borderRadius: 'var(--radius-sm)',
          fontSize: '12px',
          fontWeight: 500,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          transition: 'background var(--transition-fast)',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
      >
        <Palette size={12} />
        <span>{customActive ? 'Custom' : currentTheme.label}</span>
      </button>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          role="menu"
          style={{
            position: 'fixed',
            top: rect.bottom + 8,
            right: Math.max(8, window.innerWidth - rect.right),
            width: '340px',
            maxHeight: 'min(70vh, 560px)',
            overflowY: 'auto',
            backgroundColor: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 999999,
          }}
        >
          {GROUPS.map((group) => {
            const items = THEMES.filter((t) => t.group === group.key);
            if (items.length === 0) return null;
            return (
              <div key={group.key}>
                <div
                  style={{
                    padding: '8px 12px 4px',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                  }}
                >
                  {group.label}
                </div>
                {items.map((t) => {
                  const active = !customActive && theme === t.id;
                  return (
                    <button
                      key={t.id}
                      role="menuitem"
                      onClick={() => setTheme(t.id)}
                      title={t.description}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '8px 12px',
                        border: 'none',
                        background: active ? 'var(--status-pending-bg)' : 'none',
                        cursor: 'pointer',
                        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontSize: '13px',
                        fontWeight: active ? 600 : 500,
                        textAlign: 'left',
                        transition: 'background var(--transition-fast)',
                      }}
                      onMouseEnter={(e) => {
                        if (!active) e.currentTarget.style.background = 'var(--bg-glass-hover)';
                      }}
                      onMouseLeave={(e) => {
                        if (!active) e.currentTarget.style.background = 'none';
                      }}
                    >
                      <span
                        style={{
                          display: 'flex',
                          flexShrink: 0,
                          borderRadius: 'var(--radius-sm)',
                          overflow: 'hidden',
                          border: '1px solid var(--border-color)',
                          height: '16px',
                          width: '28px',
                        }}
                      >
                        <span style={{ flex: 1, backgroundColor: t.swatch[0] }} />
                        <span style={{ flex: 1, backgroundColor: t.swatch[1] }} />
                        <span style={{ flex: 1, backgroundColor: t.swatch[2] }} />
                      </span>
                      <span style={{ flex: 1 }}>{t.label}</span>
                      {active && <Check size={14} color="var(--accent)" />}
                    </button>
                  );
                })}
              </div>
            );
          })}

          <div
            style={{
              borderTop: '1px solid var(--border-color)',
              padding: '8px 12px 12px',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
                marginBottom: '8px',
              }}
            >
              Custom
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '8px',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: '46px',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                }}
              >
                Base
              </span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {CUSTOM_BASES.map((b) => {
                  const isActive = customActive && custom.base === b.id;
                  return (
                    <button
                      key={b.id}
                      onClick={() => selectBase(b.id)}
                      title={b.description}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '3px 8px',
                        border: isActive
                          ? '1px solid var(--accent)'
                          : '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-full)',
                        background: isActive ? 'var(--status-pending-bg)' : 'none',
                        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontSize: '11px',
                        fontWeight: 500,
                        cursor: 'pointer',
                        transition: 'background var(--transition-fast), border-color var(--transition-fast)',
                      }}
                    >
                      <span
                        style={{
                          width: '10px',
                          height: '10px',
                          flexShrink: 0,
                          borderRadius: 'var(--radius-full)',
                          backgroundColor: b.swatch[1],
                          border: '1px solid var(--border-color)',
                        }}
                      />
                      {CUSTOM_BASE_LABELS[b.id] ?? b.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '8px',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: '46px',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                }}
              >
                Accent
              </span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {ACCENTS.map((a) => {
                  const isActive = customActive && custom.accent === a.hex;
                  return (
                    <button
                      key={a.id}
                      onClick={() => selectAccent(a.hex)}
                      title={a.label}
                      aria-label={`Accent ${a.label}`}
                      style={{
                        width: '18px',
                        height: '18px',
                        borderRadius: 'var(--radius-full)',
                        backgroundColor: a.hex,
                        border: isActive
                          ? '2px solid var(--accent)'
                          : '1px solid var(--border-color)',
                        boxShadow: isActive ? '0 0 0 2px var(--bg-tertiary), 0 0 0 4px var(--accent)' : 'none',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '8px',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: '46px',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                }}
              >
                Custom
              </span>
              <input
                type="color"
                value={custom.accent}
                onChange={(e) => selectAccent(e.target.value)}
                aria-label="Custom accent color"
                style={{
                  width: '32px',
                  height: '24px',
                  padding: 0,
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'none',
                  cursor: 'pointer',
                }}
              />
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  color: 'var(--text-secondary)',
                }}
              >
                {custom.accent}
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-surface-2)',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  flexShrink: 0,
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                  border: '1px solid var(--border-color)',
                  height: '16px',
                  width: '40px',
                }}
              >
                <span style={{ flex: 1, backgroundColor: base.swatch[0] }} />
                <span style={{ flex: 1, backgroundColor: base.swatch[1] }} />
              </span>
              <span
                style={{
                  flexShrink: 0,
                  width: '14px',
                  height: '14px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: custom.accent,
                  border: '1px solid var(--border-color)',
                }}
              />
              <span
                style={{
                  flexShrink: 0,
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '11px',
                  fontWeight: 600,
                  backgroundColor: custom.accent,
                  color: readableOnAccent(custom.accent),
                }}
              >
                Preview
              </span>
              {customActive && (
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: '10px',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--accent)',
                  }}
                >
                  Active
                </span>
              )}
            </div>
          </div>
        </div>
      , document.body)}
    </div>
  );
};
