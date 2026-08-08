import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { card, label, Stat, Empty, Table, OpenLink, ExpiryChip, fmtDate } from './hr-ui';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';

/**
 * Identity documents and certifications, and what is about to lapse.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const ComplianceTabBody = ({ d, navigate }: { d: HrWorkforceOverview; navigate: (path: string) => void }) => {
  const { certifications, documents } = d.expiries;
  const gd = d.compliance.governmentDocuments;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <Stat value={certifications.expired + documents.expired} caption="Already expired" tone={certifications.expired + documents.expired ? 'var(--danger)' : 'var(--success)'} />
        <Stat value={certifications.within30 + documents.within30} caption="Expiring ≤ 30 days" tone={certifications.within30 + documents.within30 ? 'var(--warning)' : undefined} />
        <Stat value={certifications.within90 + documents.within90} caption="Expiring 31–90 days" />
        <Stat value={`${gd.withGovDoc}/${gd.roster}`} caption="Have an ID document on file" tone={gd.withGovDoc < gd.roster ? 'var(--warning)' : 'var(--success)'} />
        <Stat value={`${gd.withFile}/${gd.roster}`} caption="Have any file uploaded" tone={gd.withFile < gd.roster ? 'var(--warning)' : 'var(--success)'} />
      </div>

      {gd.withGovDoc === 0 && (
        <div style={{ ...card, borderLeft: '3px solid var(--danger)', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
          <AlertTriangle size={16} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: '2px' }} />
          <div style={{ fontSize: '13px' }}>
            <strong>No identity document has been recorded for anyone on the roster.</strong>
            <div style={{ color: 'var(--text-muted)', marginTop: '3px' }}>
              Field staff visit client bank branches; identity verification is normally a precondition of that access.
              Upload documents from each assayer's profile to start the verification trail.
            </div>
          </div>
        </div>
      )}

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>Certifications falling due ({certifications.rows.length})</div>
        {certifications.rows.length === 0 ? (
          <Empty>No certification expires within the next 180 days.</Empty>
        ) : (
          <Table
            head={['Assayer', 'Certification', 'Level', 'Expires', 'In', '']}
            rows={certifications.rows.map((r: any) => [
              <strong>{r.displayName}</strong>,
              r.name,
              r.level ?? '—',
              fmtDate(r.expiryDate),
              <ExpiryChip days={r.daysToExpiry} />,
              <OpenLink onClick={() => navigate(`/assayers/${r.assayerId}`)} />,
            ])}
          />
        )}
      </section>

      {documents.rows.length > 0 && (
        <section style={card}>
          <div style={{ ...label, marginBottom: '10px' }}>Identity documents falling due ({documents.rows.length})</div>
          <Table
            head={['Assayer', 'Document', 'Status', 'Expires', 'In', '']}
            rows={documents.rows.map((r: any) => [
              <strong>{r.displayName}</strong>,
              r.documentType,
              r.verificationStatus ?? 'PENDING',
              fmtDate(r.expiryDate),
              <ExpiryChip days={r.daysToExpiry} />,
              <OpenLink onClick={() => navigate(`/assayers/${r.assayerId}`)} />,
            ])}
          />
        </section>
      )}

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>Capability inventory</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
          {([['Skills', d.capability.skills], ['Languages', d.capability.languages], ['Certifications', d.capability.certifications]] as const).map(
            ([title, items]) => (
              <div key={title}>
                <div style={{ ...label, fontSize: '10px', marginBottom: '8px' }}>{title}</div>
                {items.length === 0 ? <Empty>None recorded.</Empty> : items.slice(0, 10).map((s: any) => (
                  <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '3px 0' }}>
                    <span>{s.name}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{s.assayerCount}</span>
                  </div>
                ))}
              </div>
            ),
          )}
        </div>
        {d.capability.unprofiled > 0 && (
          <div style={{ fontSize: '12px', color: 'var(--warning)', marginTop: '12px' }}>
            {d.capability.unprofiled} assayer(s) have no recorded skill — they cannot be matched on competency during planning.
          </div>
        )}
      </section>
    </div>
  );
};


// ── Deployment ─────────────────────────────────────────────────────────────

export const HrCompliancePage: React.FC = () => {
  const { data: d } = useHr();
  const navigate = useNavigate();
  return <ComplianceTabBody d={d} navigate={navigate} />;
};
