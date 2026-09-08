import React from 'react';
import { ShieldCheck, AlertTriangle, FileText, CheckCircle2, XCircle, Clock } from 'lucide-react';
import type { AssayerDossier } from './record-types';

export interface KycReadinessCardProps {
  dossier: AssayerDossier | null;
  assayerStatus?: string;
  onNavigateTab?: (tab: string) => void;
  onReviewDocuments?: () => void;
}

export const KycReadinessCard: React.FC<KycReadinessCardProps> = ({
  dossier,
  assayerStatus,
  onNavigateTab,
  onReviewDocuments,
}) => {
  void assayerStatus;
  const handleReview = onReviewDocuments || (() => onNavigateTab && onNavigateTab('documents'));
  void handleReview;
  if (!dossier) {
    return (
      <div style={{ padding: '14px', background: 'var(--bg-surface-1)', borderRadius: '10px', border: '1px solid var(--border-color)', fontSize: '12px', color: 'var(--text-muted)' }}>
        Loading compliance records…
      </div>
    );
  }

  const onboarding = dossier.onboarding || [];
  const identityDocs = onboarding.filter((d) => d.identity);

  const verifiedCount = identityDocs.filter((d) => d.verificationStatus === 'VERIFIED').length;
  const pendingCount = identityDocs.filter((d) => d.verificationStatus === 'PENDING' && (d.filePaths || []).length > 0).length;
  const rejectedCount = identityDocs.filter((d) => d.verificationStatus === 'REJECTED').length;
  const missingCount = identityDocs.filter((d) => (d.filePaths || []).length === 0).length;

  const getStatusBadge = (status: string | null, hasFile: boolean) => {
    if (!hasFile) {
      return <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>No scan</span>;
    }
    if (status === 'VERIFIED') {
      return (
        <span style={{ color: 'var(--success)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '11.5px' }}>
          <CheckCircle2 size={12} /> Verified
        </span>
      );
    }
    if (status === 'REJECTED') {
      return (
        <span style={{ color: 'var(--danger)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '11.5px' }}>
          <XCircle size={12} /> Rejected
        </span>
      );
    }
    return (
      <span style={{ color: 'var(--warning)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '11.5px' }}>
        <Clock size={12} /> Pending review
      </span>
    );
  };

  return (
    <div
      data-testid="kyc-readiness-card"
      style={{
        background: 'var(--bg-surface-1)',
        border: '1px solid var(--border-color)',
        borderRadius: '10px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ShieldCheck size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Compliance &amp; KYC Verification
          </span>
        </div>
        {onNavigateTab && (
          <button
            type="button"
            onClick={() => onNavigateTab('documents')}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
          >
            All documents
          </button>
        )}
      </div>

      {/* Overview Stat Counters */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12px' }}>
        <span style={{ color: 'var(--success)', fontWeight: 600 }}>{verifiedCount} verified</span>
        <span style={{ color: 'var(--text-muted)' }}>·</span>
        <span style={{ color: pendingCount > 0 ? 'var(--warning)' : 'var(--text-muted)', fontWeight: pendingCount > 0 ? 600 : 400 }}>
          {pendingCount} pending review
        </span>
        <span style={{ color: 'var(--text-muted)' }}>·</span>
        <span style={{ color: rejectedCount > 0 ? 'var(--danger)' : 'var(--text-muted)', fontWeight: rejectedCount > 0 ? 600 : 400 }}>
          {rejectedCount} rejected
        </span>
        <span style={{ color: 'var(--text-muted)' }}>·</span>
        <span style={{ color: 'var(--text-muted)' }}>{missingCount} missing file</span>
      </div>

      {/* Identity Requirements Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
        {identityDocs.map((d) => {
          const hasFile = (d.filePaths || []).length > 0;
          const currentVer = d.versions?.find((v) => v.id === d.currentVersionId) || d.versions?.[0];
          const verLabel = currentVer ? `v${currentVer.version}` : 'v1';

          return (
            <div
              key={d.requirement}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                background: 'var(--bg-surface-2)',
                borderRadius: '6px',
                fontSize: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={14} style={{ color: 'var(--text-muted)' }} />
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{d.label}</span>
                {hasFile && (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                    ({verLabel})
                  </span>
                )}
              </div>
              <div>{getStatusBadge(d.verificationStatus, hasFile)}</div>
            </div>
          );
        })}
      </div>

      {rejectedCount > 0 && (
        <div style={{ padding: '8px 10px', borderRadius: '6px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', fontSize: '11.5px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <AlertTriangle size={13} style={{ flexShrink: 0 }} />
          <span>Rejected document(s) must be replaced and re-reviewed before full clearance.</span>
        </div>
      )}
    </div>
  );
};
