import React from 'react';
import { X } from 'lucide-react';

/**
 * Shared modal/dialog shell. The fixed-overlay + glass-card + title row + close
 * button + optional footer used to be hand-copied into ~15 places across pages
 * (Branches, Clients, Assayers, Projects, Users, Holidays, Rules, Scheduling),
 * each with slightly drifting overlay colors, close-button markup, and backdrop
 * click handling. One component renders all of it.
 *
 * Set `footer` to render a bottom action row (bordered + padded). Use `asForm`
 * to render a <form> instead of a <div> so an onSubmit can be supplied.
 */
export const Modal: React.FC<{
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  width?: number | string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  asForm?: boolean;
  onSubmit?: React.FormEventHandler;
  backdropBlur?: boolean;
  maxHeight?: string;
  closeIcon?: React.ReactNode;
  bodyClassName?: string;
  bodyStyle?: React.CSSProperties;
}> = ({
  open,
  onClose,
  title,
  width = '460px',
  footer,
  children,
  asForm = false,
  onSubmit,
  backdropBlur = true,
  maxHeight,
  closeIcon,
  bodyClassName,
  bodyStyle,
}) => {
  if (!open) return null;

  const container = (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: backdropBlur ? 'blur(4px)' : undefined,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        className="glass-card"
        onClick={(e) => e.stopPropagation()}
        style={{ width, maxHeight, display: 'flex', flexDirection: 'column', gap: '14px', padding: '20px', ...bodyStyle }}
      >
        {title !== undefined && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <h4 style={{ fontSize: '15px', fontWeight: 700, margin: 0 }}>{title}</h4>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
            >
              {closeIcon ?? <X size={18} />}
            </button>
          </div>
        )}
        <div className={bodyClassName} style={{ display: 'flex', flexDirection: 'column', gap: '14px', minHeight: 0, ...(bodyClassName ? {} : {}) }}>
          {children}
        </div>
        {footer && (
          <div
            style={{
              display: 'flex',
              gap: '10px',
              justifyContent: 'flex-end',
              borderTop: '1px solid var(--border-color)',
              paddingTop: '12px',
              flexShrink: 0,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return asForm ? (
    <form onSubmit={onSubmit}>{container}</form>
  ) : (
    <>{container}</>
  );
};
