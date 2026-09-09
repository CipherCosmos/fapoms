import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X, Loader2 } from 'lucide-react';

/**
 * Transient feedback, built for people who are not watching for it.
 *
 * Two things drive the design here, both learned the hard way from this app's
 * users being non-technical:
 *
 *  1. **Errors do not auto-dismiss.** The previous version cleared every toast
 *     after 3.5s regardless of type, so a failure notice could disappear before
 *     it had been read — leaving someone believing their work saved when it had
 *     not. Successes still fade on their own (nothing to act on); errors and
 *     warnings stay until dismissed.
 *  2. **The countdown is visible and pausable.** A bar drains so it is obvious
 *     the message is about to go, and hovering or focusing anywhere in the stack
 *     freezes it — reading should never be a race.
 *
 * The original `toast('success', 'Saved')` signature is preserved because 60+
 * call sites use it; the object form adds a title, an action button and an
 * explicit duration for the cases that need more.
 */

export type ToastType = 'success' | 'error' | 'info' | 'warning' | 'loading';

export interface ToastOptions {
  type?: ToastType;
  /** Bold first line. Without it the message carries the whole weight. */
  title?: string;
  message: string;
  /** One recovery affordance — "Retry", "Undo". Dismisses on click. */
  action?: { label: string; onClick: () => void };
  /** ms. `0` pins the toast open. Defaults by type. */
  duration?: number;
}

interface ToastRecord extends Required<Pick<ToastOptions, 'message'>> {
  id: number;
  type: ToastType;
  title?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
  createdAt: number;
}

/**
 * Errors and warnings persist (0) — the user must acknowledge them. `loading`
 * persists because only the caller knows when it is done.
 */
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 4000,
  info: 5000,
  warning: 0,
  error: 0,
  loading: 0,
};

const MAX_VISIBLE = 4;

/**
 * Add one toast, and if the stack is full drop something that can afford to go.
 *
 * This used to be `[...prev, next].slice(-MAX_VISIBLE)`, which always dropped the oldest — and
 * the oldest is very often a pinned error nobody has read yet. That quietly undid the guarantee
 * at the top of this file: four routine "Saved" messages after a failure would carry the failure
 * off the top of the stack, and the person would be left believing their work saved when it had
 * not. Exactly the outcome the persist-errors rule exists to prevent, arriving by a different
 * door.
 *
 * So: evict the oldest toast that dismisses itself anyway (success, info — anything with a
 * countdown), because it was leaving in a few seconds regardless and losing it costs nothing.
 * Only when every visible toast is pinned does the oldest pinned one go, since something must,
 * and by then the stack is four unacknowledged problems deep and the newest is the most likely
 * to be about what the person just did.
 */
const admit = (prev: ToastRecord[], next: ToastRecord): ToastRecord[] => {
  const grown = [...prev, next];
  if (grown.length <= MAX_VISIBLE) return grown;

  const victim = grown.findIndex((t) => t.duration > 0);
  const drop = victim === -1 ? 0 : victim;
  return grown.filter((_, i) => i !== drop);
};

interface ToastApi {
  toast: (a: ToastType | ToastOptions, b?: string) => number;
  dismiss: (id: number) => void;
}

/**
 * The default is deliberately loud rather than a silent no-op: an unmounted
 * provider previously swallowed every toast in the app with no trace. If this
 * ever fires again it says so in the console instead of hiding.
 */
const ToastContext = createContext<ToastApi>({
  toast: (a, b) => {
    const msg = typeof a === 'string' ? b : a?.message;
    console.error('[Toast] ToastProvider is not mounted — message dropped:', msg);
    return -1;
  },
  dismiss: () => {},
});

export const useToast = () => useContext(ToastContext);

const VISUALS: Record<ToastType, { fg: string; bg: string; Icon: React.ElementType; role: 'status' | 'alert' }> = {
  success: { fg: 'var(--success)', bg: 'var(--status-active-bg)', Icon: CheckCircle2, role: 'status' },
  error: { fg: 'var(--danger)', bg: 'var(--status-cancelled-bg)', Icon: AlertTriangle, role: 'alert' },
  warning: { fg: 'var(--warning)', bg: 'var(--status-pending-bg)', Icon: AlertTriangle, role: 'alert' },
  info: { fg: 'var(--accent)', bg: 'rgba(216,174,71,0.12)', Icon: Info, role: 'status' },
  loading: { fg: 'var(--text-muted)', bg: 'var(--bg-surface-2)', Icon: Loader2, role: 'status' },
};

const ToastCard: React.FC<{ t: ToastRecord; paused: boolean; onDismiss: () => void }> = ({ t, paused, onDismiss }) => {
  const { fg, bg, Icon, role } = VISUALS[t.type];
  const [remaining, setRemaining] = useState(t.duration);

  // Drain the countdown only while unpaused, so hovering genuinely stops it
  // rather than merely hiding a timer that keeps running underneath.
  useEffect(() => {
    if (t.duration === 0 || paused) return;
    const started = Date.now();
    const from = remaining;
    const tick = setInterval(() => {
      const left = from - (Date.now() - started);
      if (left <= 0) {
        clearInterval(tick);
        onDismiss();
      } else {
        setRemaining(left);
      }
    }, 50);
    return () => clearInterval(tick);
    // `remaining` is intentionally excluded: including it restarts the interval
    // on every tick, which compounds drift badly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.duration, paused, onDismiss]);

  const pct = t.duration > 0 ? Math.max(0, (remaining / t.duration) * 100) : 0;

  return (
    <div
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: '100%',
        padding: '12px 12px 12px 14px',
        background: bg,
        border: '1px solid var(--border-color)',
        borderLeft: `3px solid ${fg}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--text-primary)',
        overflow: 'hidden',
        animation: 'toastIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <Icon
        size={17}
        style={{ color: fg, flexShrink: 0, marginTop: 1, ...(t.type === 'loading' ? { animation: 'toastSpin 1s linear infinite' } : null) }}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        {t.title && <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{t.title}</div>}
        {/* `pre-line` so a multi-line message survives: a validation failure with several
            problems now lists each one on its own line (see `joinServerMessage`), and
            without this they collapse into one run-on sentence. Wrapping is unaffected —
            `pre-line` collapses spaces and still wraps, it only keeps the newlines. */}
        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: t.title ? 'var(--text-secondary)' : 'var(--text-primary)', overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
          {t.message}
        </div>
        {t.action && (
          <button
            onClick={() => { t.action!.onClick(); onDismiss(); }}
            style={{
              marginTop: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700,
              color: fg, background: 'transparent', border: `1px solid ${fg}`,
              borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            }}
          >
            {t.action.label}
          </button>
        )}
      </div>

      <button
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, padding: 0, marginTop: -3, marginRight: -3,
          background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
          color: 'var(--text-muted)', cursor: 'pointer',
        }}
      >
        <X size={14} />
      </button>

      {t.duration > 0 && (
        <div style={{ position: 'absolute', left: 0, bottom: 0, height: 2, width: `${pct}%`, background: fg, opacity: 0.55, transition: 'width 50ms linear' }} />
      )}
    </div>
  );
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [paused, setPaused] = useState(false);
  const idRef = useRef(0);

  /**
   * The list, held where a decision can be made against it synchronously.
   *
   * `toast()` has to answer two questions in the same call: what goes on screen, and what id to
   * hand back. A `setToasts(prev => ...)` updater answers the first perfectly and cannot answer
   * the second — React batches it, so it has not run by the time this function returns. Keeping
   * the array in a ref and driving state from it lets both answers come from the same list.
   */
  const listRef = useRef<ToastRecord[]>([]);
  const commit = useCallback((next: ToastRecord[]) => {
    listRef.current = next;
    setToasts(next);
  }, []);

  const dismiss = useCallback((id: number) => {
    commit(listRef.current.filter((t) => t.id !== id));
  }, [commit]);

  const toast = useCallback((a: ToastType | ToastOptions, b?: string) => {
    const opts: ToastOptions = typeof a === 'string' ? { type: a, message: b ?? '' } : a;
    const type = opts.type ?? 'info';

    // Collapse an identical message already on screen instead of stacking duplicates — a
    // double-clicked Save should not read as two failures.
    //
    // The id handed back is the SURVIVING toast's, not a fresh one. Minting an id for a toast
    // that was never created breaks the only contract this return value has: `dismiss(id)` would
    // match nothing, so a caller that showed a pinned 'loading' and then tried to clear it would
    // leave it spinning for ever with no way to reach it. Nothing calls it that way today, which
    // is exactly why it was worth fixing now rather than after someone relies on it.
    const dupe = listRef.current.find((t) => t.message === opts.message && t.type === type);
    if (dupe) return dupe.id;

    const id = ++idRef.current;
    commit(admit(listRef.current, {
      id,
      type,
      title: opts.title,
      message: opts.message,
      action: opts.action,
      duration: opts.duration ?? DEFAULT_DURATION[type],
      createdAt: Date.now(),
    }));
    return id;
  }, [commit]);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
        style={{
          position: 'fixed', top: 16, right: 16, zIndex: 2000,
          display: 'flex', flexDirection: 'column', gap: 8,
          width: 'min(380px, calc(100vw - 32px))',
          pointerEvents: toasts.length ? 'auto' : 'none',
        }}
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} t={t} paused={paused} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
      <style>{`
        @keyframes toastIn { from { opacity: 0; transform: translateX(16px) scale(0.97) } to { opacity: 1; transform: none } }
        @keyframes toastSpin { to { transform: rotate(360deg) } }
        @media (prefers-reduced-motion: reduce) {
          @keyframes toastIn { from { opacity: 0 } to { opacity: 1 } }
        }
      `}</style>
    </ToastContext.Provider>
  );
};
