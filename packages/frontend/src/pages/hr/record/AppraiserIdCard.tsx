import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Info, Smartphone } from 'lucide-react';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { Modal, SkeletonList, AlertBanner } from '../../../components/ui';
import { DigitalIdCard, type IdCardFaceData } from '../../../components/idcard/DigitalIdCard';

/** What `GET /assayers/:id/id-card/preview` answers — the card's face and whether it is issued. */
export type IdCardTerms = IdCardFaceData;

/**
 * The ID card, as HR sees it (owner, 2026-09-23): DIGITAL ONLY.
 *
 * There is no download and no print — the card lives in the assayer's own app, with a QR and a
 * 6-digit code that change every minute and are checked on the public /verify page. What HR sees
 * here is a blurred, watermarked preview with no code: enough to see what the card says and whether
 * it is issued, and useless as identification if somebody screenshots it.
 */
export const IdCardDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  assayerId: string;
  photoUrl?: string | null;
}> = ({ open, onClose, assayerId, photoUrl }) => {
  const [terms, setTerms] = useState<IdCardTerms | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setTerms(null);
    setLoadError(null);
    api.request<IdCardTerms>(`/assayers/${assayerId}/id-card/preview`)
      .then(setTerms)
      .catch((e) => setLoadError(userMessage(e)));
  }, [assayerId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="ID card"
      width="460px"
      dismissOnBackdrop
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: 'var(--text-xs)', padding: '7px 14px' }}>
            Close
          </button>
        </div>
      )}
    >
      {loadError ? (
        <div>
          <AlertBanner type="error" message={`The ID card could not be loaded. ${loadError}`} />
          <button type="button" className="btn btn-secondary" onClick={load} style={{ marginTop: '10px', fontSize: 'var(--text-xs)', padding: '6px 12px' }}>
            Try again
          </button>
        </div>
      ) : !terms ? (
        <SkeletonList rows={4} height={36} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <Smartphone size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>
              The ID card is digital only. {terms.fullName.split(' ')[0]} shows it from the app, with a code that
              changes every minute; anyone can check it at <strong>{window.location.origin}/verify</strong>. There is
              nothing to download or print, and this preview is blurred on purpose.
            </span>
          </div>
          {!terms.issued && (
            <div data-testid="id-card-blocked" style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--status-pending-bg)', border: '1px solid var(--warning)', fontSize: 'var(--text-xs)', color: 'var(--text-primary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: 'var(--warning)' }}>
                <AlertTriangle size={14} /> Not issued yet — the app shows them why
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {terms.blockedBecause.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          )}
          {terms.issued && terms.gaps.length > 0 && (
            <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: 'var(--text-primary)' }}>
                <Info size={14} /> Issued, but these are still open
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {terms.gaps.map((g) => <li key={g}>{g}</li>)}
              </ul>
            </div>
          )}
          <DigitalIdCard face={terms} photoUrl={photoUrl} preview />
          {!terms.signatoryName && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              No signatory is set, so the card shows none. An administrator can add one in Platform Settings.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default IdCardDialog;
