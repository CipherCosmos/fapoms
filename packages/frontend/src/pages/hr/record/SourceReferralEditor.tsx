import React, { useState } from 'react';
import { normalizeSourceReferral, sourceReferralLine, type SourceReferral } from '@fapoms/shared';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import {
  SourceReferralFields, referralDraftFrom, referralPayload, type SourceReferralDraft,
} from '../../../components/SourceReferralFields';

/**
 * Who referred this person — shown, and changed by HR through its own save (`PUT
 * /assayers/:id/source-referral`), which keeps the shared shape and writes the audit trail.
 * Not part of "Edit details": it is one small object, not four columns.
 */
export const SourceReferralEditor: React.FC<{
  assayerId: string;
  value: SourceReferral | null | undefined;
  canManage: boolean;
  onSaved: () => void;
}> = ({ assayerId, value, canManage, onSaved }) => {
  const [draft, setDraft] = useState<SourceReferralDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!draft) return;
    const payload = referralPayload(draft);
    const problem = normalizeSourceReferral(payload, 'HR').error;
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      await api.request(`/assayers/${assayerId}/source-referral`, {
        method: 'PUT', body: JSON.stringify({ sourceReferral: payload }),
      });
      setDraft(null);
      onSaved();
    } catch (e) { setError(userMessage(e)); } finally { setBusy(false); }
  };

  if (!draft) {
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
        <span style={{ color: value ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          {value ? sourceReferralLine(value) : 'Nobody recorded'}
          {value?.recordedBy === 'CANDIDATE' && (
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}> — as they gave it on their form</span>
          )}
        </span>
        {canManage && (
          <button type="button" className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
            onClick={() => { setDraft(referralDraftFrom(value)); setError(null); }}>
            {value ? 'Change' : 'Add who referred them'}
          </button>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <SourceReferralFields value={draft} onChange={setDraft} disabled={busy} idPrefix="record-referral" />
      {error && <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
          onClick={() => { setDraft(null); setError(null); }} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
          onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
};

export default SourceReferralEditor;
