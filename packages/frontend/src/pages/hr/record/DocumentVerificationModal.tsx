import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, AlertTriangle, X, RefreshCw } from 'lucide-react';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import type { PaperworkDocument, DocumentVersionInfo } from './record-types';

interface DocumentVerificationModalProps {
  open: boolean;
  onClose: () => void;
  document: PaperworkDocument;
  onSuccess: () => void;
  assayerName: string;
}

export const DocumentVerificationModal: React.FC<DocumentVerificationModalProps> = ({
  open,
  onClose,
  document: doc,
  onSuccess,
  assayerName,
}) => {
  const [verdict, setVerdict] = useState<'VERIFIED' | 'REJECTED'>('VERIFIED');
  const [selectedVersionId, setSelectedVersionId] = useState<string>(
    doc.currentVersionId || doc.id || 'default-ver',
  );
  const [holderName, setHolderName] = useState(doc.holderName || assayerName || '');
  const [rejectionReason, setRejectionReason] = useState<string>('ILLEGIBLE');
  const [remarks, setRemarks] = useState('');
  const [nameMismatchNote, setNameMismatchNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflictError, setConflictError] = useState<{
    code: 'DOCUMENT_VERSION_STALE' | 'CANNOT_VERIFY_SUPERSEDED_VERSION' | 'CONTENT_HASH_MISMATCH' | 'DOCUMENT_ALREADY_REVIEWED' | 'OTHER';
    message: string;
  } | null>(null);

  if (!open) return null;

  const versions: DocumentVersionInfo[] = doc.versions && doc.versions.length > 0
    ? doc.versions
    : [{
        id: doc.currentVersionId || doc.id || 'default-ver',
        version: doc.docVersion || 1,
        verificationStatus: doc.verificationStatus || 'PENDING',
        contentSha256: doc.contentSha256 || null,
        createdAt: doc.uploadedAt || new Date().toISOString(),
      }];

  const currentVersion = versions.find((v) => v.id === selectedVersionId) || versions[0];
  const isSuperseded = Boolean(
    currentVersion?.supersededByVersionId ||
    (doc.currentVersionId && currentVersion?.id !== doc.currentVersionId),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setConflictError(null);

    const payload: any = {
      verdict,
      targetVersionId: currentVersion.id,
      expectedDocVersion: doc.docVersion || (doc as any).version || currentVersion.version,
      expectedContentHash: currentVersion.contentSha256 || null,
    };

    if (verdict === 'VERIFIED') {
      payload.holderName = holderName;
      if (nameMismatchNote.trim()) {
        payload.nameMismatchNote = nameMismatchNote.trim();
      }
    } else {
      payload.rejectionReason = rejectionReason;
      if (remarks.trim()) {
        payload.remarks = remarks.trim();
      }
    }

    try {
      await api.request(`/assayers/document/${doc.id}/verify`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      const msg = userMessage(err);
      if (msg.includes('DOCUMENT_VERSION_STALE')) {
        setConflictError({
          code: 'DOCUMENT_VERSION_STALE',
          message: 'This document was updated by another operator or user concurrently. Please reload fresh server state before reviewing.',
        });
      } else if (msg.includes('CANNOT_VERIFY_SUPERSEDED_VERSION')) {
        setConflictError({
          code: 'CANNOT_VERIFY_SUPERSEDED_VERSION',
          message: 'The version you are inspecting has been superseded by a newer upload. Only the current active version can be verified.',
        });
      } else if (msg.includes('CONTENT_HASH_MISMATCH')) {
        setConflictError({
          code: 'CONTENT_HASH_MISMATCH',
          message: 'The document file content has changed since you opened this review. Verification aborted for safety.',
        });
      } else if (msg.includes('DOCUMENT_ALREADY_REVIEWED')) {
        setConflictError({
          code: 'DOCUMENT_ALREADY_REVIEWED',
          message: 'This document has already been reviewed by another operator.',
        });
      } else {
        setConflictError({
          code: 'OTHER',
          message: msg,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="document-verification-modal"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '16px',
      }}
    >
      <div
        style={{
          background: 'var(--bg-card)',
          borderRadius: '12px',
          maxWidth: '560px',
          width: '100%',
          border: '1px solid var(--border-color)',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)',
          overflow: 'hidden',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--bg-surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={18} style={{ color: 'var(--accent-primary)' }} />
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
              Verify Document: {doc.label || doc.requirement}
            </h3>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: '4px',
            }}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {conflictError && (
            <div
              data-testid="verification-conflict-alert"
              style={{
                padding: '12px',
                borderRadius: '8px',
                background: 'color-mix(in srgb, var(--danger) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
                display: 'flex',
                gap: '10px',
                alignItems: 'flex-start',
              }}
            >
              <AlertTriangle size={18} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: '2px' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '12.5px', color: 'var(--danger)' }}>
                  {conflictError.code}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-primary)', marginTop: '2px' }}>
                  {conflictError.message}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onSuccess();
                    onClose();
                  }}
                  className="btn btn-secondary"
                  style={{ fontSize: '11.5px', padding: '4px 8px', marginTop: '8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <RefreshCw size={11} /> Reload fresh document
                </button>
              </div>
            </div>
          )}

          {/* Version Selector & Provenance */}
          <div
            style={{
              padding: '12px',
              borderRadius: '8px',
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Target Version & Provenance
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {versions.length} version{versions.length > 1 ? 's' : ''} on record
              </span>
            </div>

            {versions.length > 1 ? (
              <select
                value={selectedVersionId}
                onChange={(e) => setSelectedVersionId(e.target.value)}
                style={{
                  padding: '6px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-surface)',
                  fontSize: '12.5px',
                  color: 'var(--text-primary)',
                }}
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    Version v{v.version} ({v.verificationStatus}) {v.id === doc.currentVersionId ? '— CURRENT' : '— SUPERSEDED'}
                  </option>
                ))}
              </select>
            ) : (
              <div style={{ fontSize: '12.5px', fontWeight: 500 }}>
                Version v{currentVersion.version} · {currentVersion.verificationStatus}
              </div>
            )}

            {currentVersion.contentSha256 && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                SHA-256: {currentVersion.contentSha256}
              </div>
            )}

            {isSuperseded && (
              <div style={{ fontSize: '11.5px', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <AlertTriangle size={13} />
                <span>Notice: This version has been superseded by a newer version. The backend prohibits verifying historical superseded versions.</span>
              </div>
            )}
          </div>

          {/* Verdict Switcher */}
          <div>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
              Verification Action
            </label>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                onClick={() => setVerdict('VERIFIED')}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: `1px solid ${verdict === 'VERIFIED' ? 'var(--success)' : 'var(--border-color)'}`,
                  background: verdict === 'VERIFIED' ? 'var(--status-active-bg)' : 'var(--bg-surface-2)',
                  color: verdict === 'VERIFIED' ? 'var(--success)' : 'var(--text-secondary)',
                  fontWeight: 600,
                  fontSize: '12.5px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                }}
              >
                <ShieldCheck size={16} /> Verify as Original
              </button>
              <button
                type="button"
                onClick={() => setVerdict('REJECTED')}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: `1px solid ${verdict === 'REJECTED' ? 'var(--danger)' : 'var(--border-color)'}`,
                  background: verdict === 'REJECTED' ? 'color-mix(in srgb, var(--danger) 10%, transparent)' : 'var(--bg-surface-2)',
                  color: verdict === 'REJECTED' ? 'var(--danger)' : 'var(--text-secondary)',
                  fontWeight: 600,
                  fontSize: '12.5px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                }}
              >
                <ShieldAlert size={16} /> Reject Scan
              </button>
            </div>
          </div>

          {verdict === 'VERIFIED' ? (
            <>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                  Name on Document
                </label>
                <input
                  type="text"
                  value={holderName}
                  onChange={(e) => setHolderName(e.target.value)}
                  placeholder="Exact name printed on document"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-surface)',
                    fontSize: '12.5px',
                    color: 'var(--text-primary)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                  Name Mismatch Note (optional)
                </label>
                <input
                  type="text"
                  value={nameMismatchNote}
                  onChange={(e) => setNameMismatchNote(e.target.value)}
                  placeholder="Required if printed name differs from record name (min 10 chars)"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-surface)',
                    fontSize: '12.5px',
                    color: 'var(--text-primary)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                  Rejection Reason
                </label>
                <select
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-surface)',
                    fontSize: '12.5px',
                    color: 'var(--text-primary)',
                    boxSizing: 'border-box',
                  }}
                >
                  <option value="ILLEGIBLE">Illegible or low resolution scan</option>
                  <option value="EXPIRED">Document expired</option>
                  <option value="NAME_MISMATCH">Name does not match and no reason provided</option>
                  <option value="SUSPECTED_FORGERY">Suspected altered / forged scan</option>
                  <option value="INCORRECT_DOCUMENT">Wrong document type uploaded</option>
                  <option value="OTHER">Other compliance reason</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>
                  Rejection Remarks
                </label>
                <textarea
                  rows={2}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Explain why this document was rejected..."
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-surface)',
                    fontSize: '12.5px',
                    color: 'var(--text-primary)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={busy}
              style={{ fontSize: '12.5px', padding: '7px 14px' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || isSuperseded}
              style={{
                fontSize: '12.5px',
                padding: '7px 14px',
                background: verdict === 'VERIFIED' ? 'var(--accent-primary)' : 'var(--danger)',
                borderColor: verdict === 'VERIFIED' ? 'var(--accent-primary)' : 'var(--danger)',
              }}
            >
              {busy ? 'Submitting…' : verdict === 'VERIFIED' ? 'Confirm Verification' : 'Reject Document'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
