import React, { useCallback, useEffect, useState } from 'react';
import { Download, AlertTriangle, Info } from 'lucide-react';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { fmtDate } from '../../../utils/dates';
import { Modal, SkeletonList, AlertBanner } from '../../../components/ui';

/**
 * What the ID card will print, as the server works it out for the PDF download. The preview draws
 * only these fields, so the card on screen and the card that is printed cannot disagree — the old
 * preview invented its own validity date, signatory and "verified" badge.
 */
export interface IdCardTerms {
  canDownload: boolean;
  blockedBecause: string[];
  gaps: string[];
  issuedOn: string;
  validTill: string;
  jobTitle: string;
  fullName: string;
  assayerCode: string;
  department: string | null;
  location: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  helplinePhone: string | null;
  officeAddress: string | null;
}

const NAVY = '#0f172a';
const AMBER = '#f97316';
const GOLD = '#b45309';
const MUTED = '#64748b';
const INK = '#1e293b';

const initialsOf = (name: string) =>
  (name || '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

const CardField: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ minWidth: 0 }}>
    <div style={{ fontSize: 'var(--text-3xs)', letterSpacing: '0.06em', textTransform: 'uppercase', color: MUTED }}>{label}</div>
    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: INK, overflowWrap: 'anywhere' }}>{value}</div>
  </div>
);

/** The printed card, drawn from `IdCardTerms`. Light on purpose: it stands for a piece of card stock. */
export const AppraiserIdCard: React.FC<{ terms: IdCardTerms; photoUrl?: string | null }> = ({ terms, photoUrl }) => (
  <div
    data-testid="appraiser-id-card"
    style={{
      width: '100%',
      maxWidth: '460px',
      margin: '0 auto',
      background: '#ffffff',
      color: INK,
      border: '1px solid #e2e8f0',
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: '0 4px 14px rgba(15, 23, 42, 0.12)',
    }}
  >
    <div style={{ background: NAVY, borderBottom: `3px solid ${AMBER}`, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
      <img src="/sumeru-logo.png" alt="" style={{ height: '26px', width: 'auto' }} />
      <div>
        <div style={{ color: '#ffffff', fontWeight: 800, fontSize: 'var(--text-base)', letterSpacing: '0.04em' }}>SUMERU GLOBAL</div>
        <div style={{ color: '#94a3b8', fontSize: 'var(--text-3xs)', letterSpacing: '0.08em' }}>FIELD AUDIT OPERATIONS</div>
      </div>
    </div>

    <div style={{ display: 'flex', gap: '14px', padding: '14px', flexWrap: 'wrap' }}>
      <div
        style={{
          width: '96px', height: '118px', flexShrink: 0, borderRadius: '8px', overflow: 'hidden',
          border: `2px solid ${AMBER}`, background: '#f1f5f9',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {photoUrl ? (
          <img src={photoUrl} alt={terms.fullName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <>
            <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: GOLD }}>{initialsOf(terms.fullName)}</span>
            <span style={{ fontSize: 'var(--text-3xs)', color: MUTED, marginTop: '4px' }}>No photo on file</span>
          </>
        )}
      </div>

      <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div>
          <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: GOLD, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {terms.jobTitle}
          </div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800, color: NAVY, overflowWrap: 'anywhere' }}>{terms.fullName}</div>
          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: '#92400e', fontFamily: 'monospace' }}>ID: {terms.assayerCode}</div>
        </div>
        {terms.location && <CardField label="Location" value={terms.location} />}
        {terms.department && <CardField label="Department" value={terms.department} />}
      </div>
    </div>

    <div style={{ borderTop: '1px solid #e2e8f0', margin: '0 14px', padding: '10px 0', display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div style={{ fontSize: 'var(--text-2xs)', color: MUTED, lineHeight: 1.6 }}>
        <div>Issued: <strong style={{ color: INK }}>{fmtDate(terms.issuedOn)}</strong></div>
        <div>Valid until: <strong style={{ color: '#047857' }}>{fmtDate(terms.validTill)}</strong></div>
      </div>
      <div style={{ textAlign: 'right', minWidth: '140px' }}>
        <div style={{ borderTop: `1px solid ${MUTED}`, paddingTop: '3px' }} />
        {terms.signatoryName && <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: INK }}>{terms.signatoryName}</div>}
        {terms.signatoryTitle && <div style={{ fontSize: 'var(--text-3xs)', color: MUTED }}>{terms.signatoryTitle}</div>}
        {!terms.signatoryName && !terms.signatoryTitle && <div style={{ fontSize: 'var(--text-3xs)', color: MUTED }}>Authorised signatory</div>}
      </div>
    </div>

    {(terms.helplinePhone || terms.officeAddress) && (
      <div style={{ background: '#f8fafc', borderTop: '1px solid #e2e8f0', padding: '6px 14px', fontSize: 'var(--text-3xs)', color: MUTED, lineHeight: 1.5 }}>
        {terms.helplinePhone && <div>If found, please call {terms.helplinePhone}</div>}
        {terms.officeAddress && <div>{terms.officeAddress}</div>}
      </div>
    )}
  </div>
);

/**
 * The one place the ID card is shown and downloaded. Asks the server what the card would print
 * each time it opens, so the dates are today's and a card that cannot be issued says why.
 */
export const IdCardDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  assayerId: string;
  photoUrl?: string | null;
  /** Whether this viewer may download at all (the route is ADMIN/OPERATIONS only). */
  allowDownload: boolean;
  onDownload: () => void;
  downloading: boolean;
}> = ({ open, onClose, assayerId, photoUrl, allowDownload, onDownload, downloading }) => {
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

  const signatoryMissing = !!terms && !terms.signatoryName;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="ID card"
      width="520px"
      dismissOnBackdrop
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: 'var(--text-xs)', padding: '7px 14px' }}>
            Close
          </button>
          {allowDownload && terms?.canDownload && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onDownload}
              disabled={downloading}
              style={{ fontSize: 'var(--text-xs)', padding: '7px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Download size={13} /> {downloading ? 'Preparing…' : 'Download PDF'}
            </button>
          )}
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
          {!terms.canDownload && (
            <div data-testid="id-card-blocked" style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--status-pending-bg)', border: '1px solid var(--warning)', fontSize: 'var(--text-xs)', color: 'var(--text-primary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: 'var(--warning)' }}>
                <AlertTriangle size={14} /> This card cannot be issued yet
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {terms.blockedBecause.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          )}
          {terms.canDownload && terms.gaps.length > 0 && (
            <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: 'var(--text-primary)' }}>
                <Info size={14} /> The card can be issued, but these are still open
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {terms.gaps.map((g) => <li key={g}>{g}</li>)}
              </ul>
            </div>
          )}
          <AppraiserIdCard terms={terms} photoUrl={photoUrl} />
          {signatoryMissing && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              No signatory name is set, so the card prints a blank signature line. An administrator can add
              it in Platform Settings.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
