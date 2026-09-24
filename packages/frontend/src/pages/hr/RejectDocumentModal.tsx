import React, { useState } from 'react';
import { DOCUMENT_REJECTION_LABELS } from '@fapoms/shared';
import { Select } from '../../components/ui';
import { Editor } from './hr-ui';

/**
 * Which of the fixed reasons applies, and anything worth remembering about it.
 *
 * Extracted from `registration/DocumentsStep.tsx` when the registration wizard stopped writing to
 * a live record: that file was the wizard's own copy of the vetting tab's document machinery —
 * upload, scan viewer, document number, holder-name matching, verify and reject — and the wizard's
 * half no longer applies to an application, which stores `{requirement, filePaths}` and nothing
 * else. This modal was the one piece the vetting tab imported FROM it, so it moved here and the
 * other eight hundred lines went.
 *
 * The reason list is `@fapoms/shared`'s now. The file this came from carried a hand-typed copy of
 * the same eight strings, which is the kind of duplicate that stays right until somebody adds a
 * ninth reason to one of them.
 */
/** The server's bounds on the note it forwards to the assayer (request-reupload body). */
const REUPLOAD_NOTE_MIN = 10;
const REUPLOAD_NOTE_MAX = 500;

export const RejectDocumentModal: React.FC<{
  label: string;
  onCancel: () => void;
  onSubmit: (reason: string, note: string) => void;
  /**
   * `sendBack` reviews a scan nobody has accepted yet. `reupload` reopens one HR already VERIFIED
   * (or the locked ID-card photo): the note is then required, because the server sends it to the
   * assayer's phone as the reason they are asked again — and it is the only unlock, so it should
   * say what to fix.
   */
  mode?: 'sendBack' | 'reupload';
}> = ({ label, onCancel, onSubmit, mode = 'sendBack' }) => {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  // `--bg-surface-2`, not `--bg-page`: the modal panel itself renders at `--bg-card`, the same
  // colour as `--bg-page` in the dark themes, so a field at the page colour disappeared into it.
  const fieldStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', fontSize: 'var(--text-sm)', fontFamily: 'inherit',
    background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
    border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', outline: 'none',
    boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px',
  };

  const reupload = mode === 'reupload';
  const noteTooShort = reupload && note.trim().length < REUPLOAD_NOTE_MIN;

  return (
    <Editor
      title={reupload ? `Ask for ${label} again?` : `Why is ${label} being sent back?`}
      intro={reupload
        ? 'It was checked and accepted, so it is locked. This unlocks it for them to send a new one. The accepted copy stays on the record.'
        : 'They are told this, on their phone, with what to do about it.'}
      onCancel={onCancel}
      onSave={() => onSubmit(reason, note.trim())}
      // Not "Send it back" again — that is the row's own button, which stays on screen behind this
      // dialog, and two controls with one name is confusing to click and to test alike.
      saveLabel={reupload ? 'Yes, ask them again' : 'Yes, send it back'}
      saveDisabled={!reason || noteTooShort}
    >
      <div>
        <label style={labelStyle}>Reason</label>
        {/* `Select` takes no `id`/`for`, so it is named directly rather than through the visual
            label above it — the same pattern `renderFormField`'s own place fields use. */}
        <Select
          value={reason}
          onChange={(v) => setReason(String(v))}
          options={Object.entries(DOCUMENT_REJECTION_LABELS).map(([value, text]) => ({ value, label: text }))}
          placeholder="-- Choose a reason --"
          aria-label="Why this document is being sent back"
        />
      </div>
      <div>
        <label htmlFor="reject-note" style={labelStyle}>
          {reupload
            ? 'What to tell them (required — sent to their phone)'
            : 'Note (optional — kept on the record, not shown to them)'}
        </label>
        <textarea
          id="reject-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={reupload ? REUPLOAD_NOTE_MAX : undefined}
          placeholder={reupload
            ? 'For example: The photo is from before your haircut. Please take a new one against a plain wall.'
            : 'Anything worth remembering about this, for whoever looks at this record next.'}
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
        {reupload && noteTooShort && note.length > 0 && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>
            A few more words, please — at least {REUPLOAD_NOTE_MIN} characters.
          </div>
        )}
      </div>
    </Editor>
  );
};

export default RejectDocumentModal;
