import React, { useState } from 'react';
import { Eye, EyeOff, ShieldAlert } from 'lucide-react';

import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { SENSITIVE_FIELDS, maskedIdentifier, type SensitiveRecordKey } from './assayer-shared';

/**
 * A KYC identifier, covered by default, uncovered on purpose — and the uncovering said out loud.
 *
 * PAN, Aadhaar and bank account numbers arrive from the server already masked. That is not a
 * hedge about what is stored: each is held complete and encrypted, and this screen is simply not
 * where a whole one belongs. An HR record is open on a shared desk for most of a working day, in
 * front of whoever walks past it, for reasons — a phone number, a joining date — that have
 * nothing to do with anybody's Aadhaar.
 *
 * So the whole number is one deliberate click away for the two roles entitled to it, and that
 * click writes an audit event naming who did it and when.
 *
 * THE AUDIT IS ON SCREEN BEFORE THE CLICK, NOT ONLY AFTER IT. A reveal control whose consequence
 * is invisible is worse than no control at all: it collects a log of people who did not know they
 * were being logged, which serves neither the clerk nor the person whose record it is. The
 * warning is therefore printed beside the button in the ordinary case — not in a tooltip, not on
 * hover, not behind a dialog somebody learns to click through — and the confirmation after the
 * fact repeats it, because "was that recorded?" is a question people ask afterwards.
 *
 * Hiding it again does not un-record it, and the copy says so. Nothing here should suggest the
 * reader can take the reveal back.
 */

export type { SensitiveRecordKey };

const noteStyle: React.CSSProperties = {
  fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.45, marginTop: '4px',
};

const valueStyle: React.CSSProperties = {
  fontFamily: 'monospace', fontSize: '12.5px', letterSpacing: '0.02em',
};

const linkButton: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '4px',
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--accent)', fontSize: '12px', fontWeight: 600,
};

export const SensitiveValue: React.FC<{
  assayerId: string;
  /** The record column. Decides which `sensitive/:field` segment is asked for. */
  fieldKey: SensitiveRecordKey;
  /** The value as the record carries it, i.e. already masked. */
  masked: string | null | undefined;
  /** Only ADMIN and OPERATIONS may ask for the whole number; the endpoint enforces it too. */
  canReveal: boolean;
  /**
   * Handed the real value once, when it arrives.
   *
   * This is what makes reveal-then-edit work: the edit surfaces seed their box from here rather
   * than from the record, so a box can never open holding a mask and a save can never turn a real
   * PAN into `••••••234F`.
   */
  onRevealed?: (value: string) => void;
  /**
   * Draws the control the caller wants in place of the plain value once it is revealed — the edit
   * screens' own input. Without it the revealed number is simply printed.
   */
  renderRevealed?: (value: string) => React.ReactNode;
  /**
   * What to show when nothing is on file. The record page has its own "Not recorded" treatment
   * (which says what the gap blocks), so it passes that in rather than being given a second one.
   */
  emptyState?: React.ReactNode;
}> = ({ assayerId, fieldKey, masked, canReveal, onRevealed, renderRevealed, emptyState }) => {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { segment, what } = SENSITIVE_FIELDS[fieldKey];
  const shown = maskedIdentifier(masked);

  const reveal = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.request<{ value: string }>(
        `/assayers/${assayerId}/sensitive/${segment}`,
      );
      const full = String(res?.value ?? '');
      setValue(full);
      onRevealed?.(full);
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!shown && value === null) {
    // Nothing to cover up. An empty field is not sensitive, and offering to reveal a blank would
    // teach the clerk that the button sometimes does nothing.
    return <>{emptyState ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}</>;
  }

  if (value !== null) {
    return (
      <div>
        {/*
          The endpoint answers `{ value: "" }` when there is nothing on file, which can differ from
          what the row showed if somebody cleared the field in another tab. Printing an empty
          monospace span would read as a rendering fault; say what happened.
        */}
        {renderRevealed
          ? renderRevealed(value)
          : (value
            ? <span style={valueStyle}>{value}</span>
            : <span style={{ color: 'var(--text-muted)' }}>Nothing is on file for this any more.</span>)}
        <div style={{ ...noteStyle, display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
          <ShieldAlert size={12} style={{ flexShrink: 0, marginTop: '2px', color: 'var(--warning)' }} />
          <span>
            You have seen this {what} in full. Your name and the time are now in the audit log
            against this person.{' '}
            <button
              type="button"
              style={{ ...linkButton, fontSize: '12px' }}
              onClick={() => setValue(null)}
            >
              <EyeOff size={11} /> Cover it again
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <span style={valueStyle}>{shown}</span>
      {canReveal && (
        <div style={noteStyle}>
          <button type="button" onClick={reveal} disabled={busy} style={linkButton}>
            <Eye size={11} /> {busy ? 'Fetching…' : `Show the whole ${what}`}
          </button>
          {/*
            Stated before the click, every time, in the ordinary flow of the page. The point of an
            audit trail is that the person being audited knows about it.
          */}
          {/*
            "in the audit log", not "on their record". The event is written against this assayer,
            but by the platform audit service — the History tab on this page reads the assayer
            activity feed, which is a different list and does not show it. Saying "on their record"
            sends a clerk who wants to check to a tab that will tell them nothing happened, and a
            transparency notice that appears to be untrue is worse than none. Surfacing reveals on
            History is the right fix and is a backend change; it is in the handover.
          */}
          <div style={{ marginTop: '2px' }}>
            Doing this is recorded in the audit log, with your name and the time.
          </div>
        </div>
      )}
      {!canReveal && (
        <div style={noteStyle}>Only HR and administrators can see the whole number.</div>
      )}
      {error && (
        <div style={{ ...noteStyle, color: 'var(--danger)' }}>
          Could not show the {what}. {error}
        </div>
      )}
    </div>
  );
};

export default SensitiveValue;
