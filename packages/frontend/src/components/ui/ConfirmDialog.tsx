import React from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { Modal } from './Modal';
import { StyledInput } from './inputs';

/**
 * The one in-app confirmation dialog. Replaces `window.confirm()` everywhere.
 *
 * Why this exists at all: `window.confirm` renders the *browser's* dialog, which is
 * unstyled, unbranded and — critically for who actually uses this product — visually
 * identical to the "allow notifications" / ad / scam pop-ups office staff have been
 * trained to dismiss without reading. Its buttons say "OK" and "Cancel", which tell the
 * reader nothing about what is about to happen, and OK is the default so an Enter
 * keypress confirms a deletion the person never read. We had 27 of them guarding real
 * actions, several irreversible.
 *
 * What replaces it has to answer three questions in words a non-native English speaker
 * can read at a glance:
 *   1. What will change?                  -> `message`
 *   2. Can I undo it?                     -> `reversible`, rendered as an explicit line
 *   3. What does the button actually do?  -> `confirmLabel` ("Delete zone", never "OK")
 *
 * Friction for genuinely dangerous actions
 * ----------------------------------------
 * For anything that destroys a record or moves money, a second click is not a decision —
 * it is the same reflex that dismissed the browser dialog. Those callers pass
 * `confirmPhrase`, which makes the user type the record's own name before the action
 * button enables. Typing "Mumbai South" is impossible to do by reflex, and it also
 * guarantees the person is deleting the row they *think* they are deleting (the common
 * real failure: right-click on the wrong row of a long table).
 *
 * `tone: 'danger'` additionally paints the action button as destructive, so the dialog
 * looks different from a routine confirmation before any text is read.
 *
 * API — a hook, not a provider
 * ----------------------------
 * `useConfirm()` returns `{ confirm, confirmDialog }`. `confirm(options)` returns a
 * Promise<boolean>, which makes replacing an existing guard a one-line, behaviour-
 * preserving edit:
 *
 *     if (!window.confirm('Delete this holiday record?')) return;
 *     // becomes
 *     if (!(await confirm({ ... }))) return;
 *
 * The owning component renders `{confirmDialog}` in its JSX. It is deliberately *not* a
 * context provider: that would mean mounting something at the app root, and the dialog
 * would then outlive the screen that opened it. Local state also means two screens can
 * each hold their own pending confirmation without fighting over one slot.
 */
export type ConfirmTone = 'normal' | 'danger';

export interface ConfirmOptions {
  /** Short question, e.g. "Delete this zone?". Shown as the dialog heading. */
  title: string;
  /**
   * What will actually change, in plain language. This is where the existing
   * `window.confirm` wording goes — much of it was already good and is preserved
   * verbatim; only wording that leaked database vocabulary was rewritten.
   */
  message: React.ReactNode;
  /** Label for the action button. Must name the action: "Delete zone", not "OK". */
  confirmLabel: string;
  /** Label for the way out. Defaults to "Cancel", which is understood universally. */
  cancelLabel?: string;
  /**
   * Whether the user can put this back afterwards. Rendered as an explicit sentence
   * rather than left implied, because "cannot be undone" is the single fact people
   * most need and most often do not infer. Omit only when genuinely not applicable.
   */
  reversible?: boolean;
  /** Overrides the sentence generated from `reversible` when the nuance matters. */
  reversibleNote?: React.ReactNode;
  /** 'danger' paints the action button destructive-red. Use for deletes and money. */
  tone?: ConfirmTone;
  /**
   * When set, the user must type this exact text before the action button enables.
   * Pass the record's own name. Reserved for deleting records and moving money.
   */
  confirmPhrase?: string;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export const useConfirm = (): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmDialog: React.ReactNode;
} => {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);
  const [typed, setTyped] = React.useState('');

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped('');
        setPending({ ...options, resolve });
      }),
    [],
  );

  // Settle the promise exactly once. A dialog dismissed any other way (Escape, the X,
  // a backdrop click) must resolve `false` and never simply hang — an unsettled promise
  // would leave the caller's `await` parked forever, and with it whatever busy flag it
  // set, so the screen would look permanently mid-action.
  const settle = React.useCallback((ok: boolean) => {
    setPending((current) => {
      current?.resolve(ok);
      return null;
    });
    setTyped('');
  }, []);

  const phrase = pending?.confirmPhrase?.trim() ?? '';
  const phraseSatisfied = !phrase || typed.trim() === phrase;
  const danger = pending?.tone === 'danger';

  const reversibleNote =
    pending?.reversibleNote ??
    (pending?.reversible === false
      ? 'This cannot be undone.'
      : pending?.reversible === true
        ? 'You can change this again later.'
        : null);

  const confirmDialog = (
    <Modal
      open={!!pending}
      onClose={() => settle(false)}
      width={440}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          {danger ? (
            <AlertTriangle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} />
          ) : (
            <HelpCircle size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          )}
          {pending?.title}
        </span>
      }
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={() => settle(false)}>
            {pending?.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            // The action button is disabled — not merely warned about — until the phrase
            // matches, so the dangerous path cannot be completed by clicking through.
            disabled={!phraseSatisfied}
            onClick={() => settle(true)}
            style={
              danger
                ? { background: 'var(--danger)', borderColor: 'var(--danger)', opacity: phraseSatisfied ? 1 : 0.5 }
                : { opacity: phraseSatisfied ? 1 : 0.5 }
            }
          >
            {pending?.confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: '13px', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        {pending?.message}
      </div>
      {reversibleNote && (
        <div
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color: pending?.reversible === false ? 'var(--danger)' : 'var(--text-muted)',
          }}
        >
          {reversibleNote}
        </div>
      )}
      {phrase && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            To continue, type <strong style={{ color: 'var(--text-primary)' }}>{phrase}</strong> below.
          </label>
          <StyledInput
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={phrase}
            autoFocus
          />
        </div>
      )}
    </Modal>
  );

  return { confirm, confirmDialog };
};
