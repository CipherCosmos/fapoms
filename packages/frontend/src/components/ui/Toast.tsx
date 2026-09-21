import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X, Loader2 } from 'lucide-react';

/**
 * Transient feedback, built for people who are not watching for it.
 *
 * Every message leaves on its own. Errors and warnings used to be pinned until
 * dismissed, on the reasoning that a failure must not vanish before it is read —
 * but in a session with several failures that left four unread cards sitting over
 * the top-right of the screen, covering the page and needing a click each to clear.
 * They now stay long enough to read and then go: ten seconds for an error, eight
 * for a warning, against four for a success. A caller that genuinely must be
 * acknowledged still says so with `duration: 0` (see App.tsx's cross-tab session
 * warning, which carries a Reload action), and `loading` stays until its owner
 * clears it because only the owner knows when it is done.
 *
 * Two rules keep the countdown honest:
 *  1. **Only the message under the pointer pauses.** Hovering used to freeze the
 *     whole stack, so a cursor resting in that corner stopped everything from
 *     leaving — which read as "the toasts are stuck".
 *  2. **Nothing but time and hovering touches the countdown.** It used to restart
 *     whenever the provider re-rendered, so a burst of messages kept the earlier
 *     ones alive indefinitely. The timer now reads its dismiss callback through a
 *     ref, so re-renders cannot reach it.
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
 * How long each kind stays. Longer the more there is to read and the worse the
 * news; `0` (loading only) means the caller clears it.
 */
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 4000,
  info: 5000,
  warning: 8000,
  error: 10000,
  loading: 0,
};

const MAX_VISIBLE = 4;

/** What a message can afford to lose to. A failure outranks four routine confirmations. */
const WEIGHT: Record<ToastType, number> = { success: 0, info: 1, loading: 2, warning: 3, error: 4 };

/**
 * Add one toast, and if the stack is full drop the one that can most afford to go.
 *
 * This used to be `[...prev, next].slice(-MAX_VISIBLE)`, which always dropped the oldest — and the
 * oldest is very often a failure nobody has read yet. Four routine "Saved" messages after a failure
 * would carry the failure off the top of the stack, leaving the person believing their work saved
 * when it had not.
 *
 * So the least important message goes: the lowest-weight one that dismisses itself anyway, oldest
 * first among equals. Picking by weight rather than by "has a countdown" is what keeps that
 * guarantee now that errors have a countdown too — otherwise the error, being oldest with a
 * duration, would be exactly the one dropped. A message pinned by its caller (`duration: 0`) is
 * given up only when every visible message is pinned, since something must go.
 */
const admit = (prev: ToastRecord[], next: ToastRecord): ToastRecord[] => {
  const grown = [...prev, next];
  if (grown.length <= MAX_VISIBLE) return grown;

  let drop = -1;
  grown.forEach((t, i) => {
    if (t.duration === 0) return;
    if (drop === -1 || WEIGHT[t.type] < WEIGHT[grown[drop].type]) drop = i;
  });
  return grown.filter((_, i) => i !== (drop === -1 ? 0 : drop));
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

/**
 * A toast floats over whatever the person was reading, so its background has to be OPAQUE.
 *
 * These cards used to take the `--status-*-bg` tints — `rgba(251,191,36,0.16)` and friends. Those
 * are made for a row inside a solid table, and at 16% opacity over a floating card they let the
 * page show through: panel edges and text ran under the message. Worse, only 13 of the 19 themes
 * define all three, so the rest fell back to the light default palette and a dark theme got a pale
 * card. Mixing the type's own colour into `--bg-surface` — both defined by every theme — keeps the
 * tint, stays solid, and cannot fall back to another theme's colours.
 */
const VISUALS: Record<ToastType, { fg: string; Icon: React.ElementType; role: 'status' | 'alert' }> = {
  success: { fg: 'var(--success)', Icon: CheckCircle2, role: 'status' },
  error: { fg: 'var(--danger)', Icon: AlertTriangle, role: 'alert' },
  warning: { fg: 'var(--warning)', Icon: AlertTriangle, role: 'alert' },
  info: { fg: 'var(--accent)', Icon: Info, role: 'status' },
  loading: { fg: 'var(--text-muted)', Icon: Loader2, role: 'status' },
};

const tinted = (fg: string) => `color-mix(in srgb, ${fg} 12%, var(--bg-surface))`;

const ToastCard: React.FC<{ t: ToastRecord; onDismiss: () => void }> = ({ t, onDismiss }) => {
  const { fg, Icon, role } = VISUALS[t.type];
  const [remaining, setRemaining] = useState(t.duration);
  const [paused, setPaused] = useState(false);

  /**
   * The countdown reads its callback through a ref so the effect's only inputs are the duration
   * and whether this card is hovered. Depending on the callback directly restarted the interval
   * on every provider render — one new message re-rendered the stack, every other card's timer
   * went back to where it was, and a busy screen kept messages alive that should have left.
   */
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  /** Survives the pauses: how much time is left when the interval is torn down and rebuilt. */
  const remainingRef = useRef(t.duration);

  useEffect(() => {
    if (t.duration === 0 || paused) return;
    const started = Date.now();
    const from = remainingRef.current;
    const tick = setInterval(() => {
      const left = from - (Date.now() - started);
      remainingRef.current = Math.max(0, left);
      if (left <= 0) {
        clearInterval(tick);
        dismissRef.current();
      } else {
        setRemaining(left);
      }
    }, 50);
    return () => clearInterval(tick);
  }, [t.duration, paused]);

  const pct = t.duration > 0 ? Math.max(0, (remaining / t.duration) * 100) : 0;

  return (
    <div
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: '100%',
        // The stack itself lets clicks through (see the container); a card takes its own.
        pointerEvents: 'auto',
        padding: '12px 12px 12px 14px',
        background: tinted(fg),
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
        {t.title && <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, marginBottom: 2 }}>{t.title}</div>}
        {/* `pre-line` so a multi-line message survives: a validation failure with several
            problems now lists each one on its own line (see `joinServerMessage`), and
            without this they collapse into one run-on sentence. Wrapping is unaffected —
            `pre-line` collapses spaces and still wraps, it only keeps the newlines. */}
        <div style={{ fontSize: 'var(--text-xs)', lineHeight: 1.45, color: t.title ? 'var(--text-secondary)' : 'var(--text-primary)', overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
          {t.message}
        </div>
        {t.action && (
          <button
            onClick={() => { t.action!.onClick(); onDismiss(); }}
            style={{
              marginTop: 8, padding: '5px 12px', fontSize: 'var(--text-xs)', fontWeight: 700,
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
        style={{
          position: 'fixed', top: 16, right: 16, zIndex: 2000,
          display: 'flex', flexDirection: 'column', gap: 8,
          width: 'min(380px, calc(100vw - 32px))',
          // Never a click-blocking sheet over the corner of the page: only the cards take clicks,
          // so the gaps between them — and the empty column when nothing is showing — stay through.
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} t={t} onDismiss={() => dismiss(t.id)} />
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
