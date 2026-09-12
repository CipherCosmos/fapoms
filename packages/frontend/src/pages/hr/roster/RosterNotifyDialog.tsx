import React, { useState } from 'react';
import { Send } from 'lucide-react';

import { Modal } from '../../../components/ui';
import { counted } from '../../../utils/plural';
import type { RosterPerson } from '../roster-filters';

/**
 * Message the selected assayers, in the same shape every other bulk action on this toolbar
 * uses: pick who, say what, act on all of them, report who it actually reached.
 *
 * There is no separate "are you sure?" step in front of this — the form itself is the
 * confirmation. A clerk who has typed a subject and a message and can see who it is going to
 * has already made the decision the other bulk actions ask about with a plain dialog; asking
 * again after the fact would be a second click for the same fact, not a safeguard.
 */
export const RosterNotifyDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  selectedRows: RosterPerson[];
  hiddenNote?: string | null;
  onSend: (subject: string, body: string, sendEmail: boolean) => Promise<void>;
  busy: boolean;
}> = ({ open, onClose, selectedRows, hiddenNote, onSend, busy }) => {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sendEmail, setSendEmail] = useState(false);

  const reset = () => {
    setSubject('');
    setBody('');
    setSendEmail(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const send = async () => {
    if (!subject.trim() || !body.trim() || busy) return;
    await onSend(subject.trim(), body.trim(), sendEmail);
    reset();
  };

  const names = selectedRows.slice(0, 5).map((a) => `${a.displayName} (${a.assayerCode})`);

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Notify ${counted(selectedRows.length, 'person', 'people')}`}
      width={480}
      footer={(
        <>
          <button type="button" onClick={close} disabled={busy} className="btn btn-secondary" style={{ fontSize: '12.5px', padding: '8px 14px' }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || !subject.trim() || !body.trim()}
            className="btn btn-primary"
            style={{ fontSize: '12.5px', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Send size={13} /> {busy ? 'Sending…' : `Send to ${selectedRows.length}`}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12.5px' }}>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          {names.join(', ')}
          {selectedRows.length > names.length && ` and ${selectedRows.length - names.length} more`}
          {hiddenNote && <div style={{ marginTop: '4px', color: 'var(--text-muted)' }}>{hiddenNote}</div>}
        </div>

        <label style={{ display: 'block' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>Subject</div>
          <input
            autoFocus
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="e.g. Update your bank details"
            style={{
              width: '100%', padding: '8px 10px', fontSize: '13px', boxSizing: 'border-box',
              background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
              border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm, 6px)', outline: 'none',
            }}
          />
        </label>

        <label style={{ display: 'block' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>Message</div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="What do you want them to know or do?"
            style={{
              width: '100%', padding: '8px 10px', fontSize: '13px', boxSizing: 'border-box', resize: 'vertical',
              background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
              border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm, 6px)', outline: 'none',
            }}
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer' }}>
          <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
          <span>
            Also send by email
            <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)' }}>
              Off by default — everyone gets it in-app; tick this to also reach their inbox.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
};
