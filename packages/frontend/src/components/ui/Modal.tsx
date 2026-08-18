import React from 'react';
import { createPortal } from 'react-dom';
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
  /** Fixed panel height. When set, the body scrolls internally so the dialog
   *  never grows/shrinks with its content (e.g. tabbed forms that change height). */
  height?: number | string;
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
  height,
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
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();

  // Never let the panel grow wider than the viewport (minus a small gutter) on
  // narrow screens. Works whether `width` is a number (px) or a CSS string.
  const panelWidth =
    typeof width === 'number'
      ? `min(${width}px, calc(100vw - 24px))`
      : `min(${width}, calc(100vw - 24px))`;

  // Hold the latest onClose in a ref so the focus-management effect below does NOT depend on it.
  // onClose is almost always an inline arrow at the call site, so it is a new reference on every
  // render — if the effect depended on it, every keystroke inside the modal would re-run the
  // effect, whose teardown restores focus to the element active before the modal opened and whose
  // setup refocuses the panel. The cursor was therefore thrown out of the input after a single
  // character, in every modal across the app. The effect now runs only when `open` changes.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus?.();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
    // Deliberately only [open]: see onCloseRef above. Re-running on onClose changes is what
    // stole focus from every input on each keystroke.
  }, [open]);

  if (!open) return null;

  const container = (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: backdropBlur ? 'blur(4px)' : undefined,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '12px',
        zIndex: 1100,
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        className="glass-card modal-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ width: panelWidth, maxWidth: '100%', maxHeight: maxHeight ?? 'calc(100vh - 24px)', height, outline: 'none', display: 'flex', flexDirection: 'column', gap: '14px', padding: '20px' }}
      >
        {title !== undefined && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <h4 id={titleId} style={{ fontSize: '15px', fontWeight: 700, margin: 0 }}>{title}</h4>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, flexShrink: 0 }}
            >
              {closeIcon ?? <X size={18} />}
            </button>
          </div>
        )}
        <div className={bodyClassName} style={{ display: 'flex', flexDirection: 'column', gap: '14px', minHeight: 0, flex: 1, overflowY: 'auto', ...bodyStyle }}>
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

  const tree = asForm ? <form onSubmit={onSubmit}>{container}</form> : container;

  /**
   * Rendered into <body>, not in place.
   *
   * `position: fixed` is only relative to the viewport while no ancestor establishes a
   * containing block — and `transform`, `filter`, `will-change` and `backdrop-filter` all do.
   * This app's global stylesheet puts `backdrop-filter: blur(...) saturate(165%)` on
   * `.glass-card`, `.table-container`, `[class*="modal"]`, `[class*="drawer"]` and more, so any
   * modal opened from inside one of those surfaces was being positioned and clipped against
   * that card instead of the window: the panel could sit partly outside its own scroll area,
   * which reads as "the dialog opens but I cannot scroll or click it".
   *
   * A portal takes the dialog out of that subtree entirely, so it behaves the same no matter
   * where it is opened from. React still propagates events through the React tree, so handlers
   * in the owning component keep working.
   */
  return createPortal(tree, document.body);
};
