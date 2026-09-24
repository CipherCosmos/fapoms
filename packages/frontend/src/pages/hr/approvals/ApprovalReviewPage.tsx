import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, XCircle } from 'lucide-react';
import {
  AssayerLifecycleStatus, BackgroundCheckVerdict, BGV_PART_LABELS, assayerLifecycleLabel, bgvClearGaps, bgvPartStates, regionLabel,
} from '@fapoms/shared';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { loadFailed } from '../../../queryClient';
import { queryKeys } from '../../../hooks/queryKeys';
import { canApproveJoiners, canManageAssayers, useCurrentPermissions, useCurrentRoles, useCurrentUserId } from '../../../hooks/useCurrentRoles';
import { Page } from '../../../components/ui/Page';
import { GeoPrecisionBadge } from '../../../components/GeoPrecisionBadge';
import type { Assayer } from '../assayer-shared';
import type { AssayerDossier } from '../record/record-types';
import { ApprovalPanel } from '../record/ApprovalPanel';
import { Attachments, CheckReport, VERDICT_LABELS } from '../AssayerVettingTab';
import { bgvPartText } from '../BgvParts';
import { activationBlockers } from '../joining-readiness';
import { fmtDate, fmtWhen } from '../hr-ui';

/** The interview they joined through, as `GET /assayers/:id/approval/interview` gives it. */
interface JoiningInterview { outcome: string; interviewedAt: string; interviewedByName: string | null }

/** Only the last four digits of an account number ever reach this screen's text. */
const lastFour = (n: string | null | undefined) => (n ? `•••• ${String(n).replace(/\s/g, '').slice(-4)}` : null);

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '14px 16px',
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section style={card} aria-label={title}>
    <h2 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, margin: '0 0 10px', color: 'var(--text-primary)' }}>{title}</h2>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>{children}</div>
  </section>
);

/** One line of the file: done or missing, what it is, what it says, and a way to look at it. */
const Item: React.FC<{ ok: boolean; label: string; detail?: React.ReactNode; action?: React.ReactNode }> = ({ ok, label, detail, action }) => (
  <div data-testid={`review-item-${label}`} data-ok={ok ? 'yes' : 'no'}
    style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: 'var(--text-sm)', lineHeight: 1.45 }}>
    {ok
      ? <CheckCircle2 size={16} color="var(--success)" aria-label="done" style={{ flexShrink: 0, marginTop: '1px' }} />
      : <XCircle size={16} color="var(--danger)" aria-label="missing" style={{ flexShrink: 0, marginTop: '1px' }} />}
    <div style={{ flex: 1, minWidth: 0 }}>
      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
      {detail && <span style={{ color: 'var(--text-secondary)' }}> — {detail}</span>}
    </div>
    {action && <div style={{ flexShrink: 0 }}>{action}</div>}
  </div>
);

/** A plain fact, no tick — who they are, not a check they pass. */
const Fact: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div style={{ display: 'flex', gap: '10px', fontSize: 'var(--text-sm)' }}>
    <span style={{ color: 'var(--text-muted)', minWidth: '120px' }}>{label}</span>
    <span style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{value || '—'}</span>
  </div>
);

/**
 * THE APPROVER'S REVIEW — the whole file on one screen, and the decision beside it (owner,
 * 2026-09-24: the approver is the final person, "who can see all the details").
 *
 * Everything a senior needs to say yes: who the person is, the interview they passed, each identity
 * document with its check and its scan, the background check with its report, the bank account and
 * the home location — each marked done or missing — and the approval panel, which approves to
 * training or straight to work, asks HR for more, or rejects.
 *
 * Read-only on purpose. Anything missing is HR's to fix on the full record (linked above); the
 * approver asks for it rather than filling it in themselves, which is what keeps the person who
 * prepared the file and the person who decides it two different people.
 */
export const ApprovalReviewPage: React.FC = () => {
  const { assayerId = '' } = useParams<{ assayerId: string }>();
  const queryClient = useQueryClient();
  const roles = useCurrentRoles();
  const permissions = useCurrentPermissions();
  const currentUserId = useCurrentUserId();
  const [err, setErr] = React.useState<string | null>(null);

  // The drawer's keys: an approver who came from the Hiring page reads what is already in the cache.
  const personQuery = useQuery({
    queryKey: queryKeys.hr.assayerRecord(assayerId),
    queryFn: () => api.request<Assayer>(`/assayers/${assayerId}`),
    enabled: !!assayerId,
  });
  const dossierQuery = useQuery({
    queryKey: queryKeys.hr.assayerDossier(assayerId),
    queryFn: () => api.request<AssayerDossier>(`/assayers/${assayerId}/dossier`),
    enabled: !!assayerId,
  });
  const interviewQuery = useQuery({
    queryKey: [...queryKeys.hr.assayerDossier(assayerId), 'interview'],
    queryFn: () => api.request<JoiningInterview | null>(`/assayers/${assayerId}/approval/interview`),
    enabled: !!assayerId,
  });

  const person = personQuery.data;
  const dossier = dossierQuery.data;

  if (loadFailed(personQuery) || loadFailed(dossierQuery)) {
    return (
      <Page>
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
          Their file could not be loaded. {userMessage(personQuery.error ?? dossierQuery.error)}
        </div>
      </Page>
    );
  }
  if (!person || !dossier) {
    return <Page><div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading their file…</div></Page>;
  }

  const identity = (dossier.onboarding ?? []).filter((d) => d.identity);
  const check = dossier.currentCheck;
  const bgvReport = (dossier.onboarding ?? []).find((d) => d.requirement === 'BGV_REPORT');
  const reportFiles = check?.reportFiles ?? [];
  const interview = interviewQuery.data;
  const references = dossier.references ?? [];
  const called = references.filter((r) => !!r.checkedAt).length;
  const pinned = person.latitude != null && person.longitude != null;
  const blockers = activationBlockers(person, dossier);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.hr.assayerRecord(assayerId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hr.assayerDossier(assayerId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hr.approvals });
  };

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <Link to="/hr/approvals" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <ArrowLeft size={12} /> Approvals
          </Link>
          <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, margin: '4px 0 0', color: 'var(--text-primary)' }}>
            {person.displayName}
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-muted)' }}>
              {person.assayerCode ? ` · ${person.assayerCode}` : ''}{person.region ? ` · ${regionLabel(person.region)}` : ''}
              {` · ${assayerLifecycleLabel(person.lifecycleStatus)}`}
            </span>
          </h1>
        </div>
        <Link to={`/hr/roster/${assayerId}`} className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '6px 12px', textDecoration: 'none' }}>
          Open their full record
        </Link>
      </div>

      {err && <div role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '14px', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
          <Section title="Who they are">
            <Fact label="Phone" value={person.phone} />
            <Fact label="Email" value={person.email} />
            <Fact label="Date of birth" value={person.dateOfBirth ? fmtDate(person.dateOfBirth) : null} />
            <Fact label="Address" value={[person.address, person.city, person.district, person.state, person.pincode].filter(Boolean).join(', ')} />
            <Fact label="Experience" value={person.experienceYears != null ? `${person.experienceYears} years` : null} />
            <Fact label="Qualification" value={person.qualification} />
          </Section>

          <Section title="Interview">
            {interview
              ? <Item ok={interview.outcome === 'PASS'} label={interview.outcome === 'PASS' ? 'Passed' : 'Did not pass'}
                detail={`${fmtWhen(interview.interviewedAt)}${interview.interviewedByName ? ` · ${interview.interviewedByName}` : ''}`} />
              : <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No interview on this system — they were added directly or imported.</div>}
          </Section>

          <Section title="Identity documents">
            {identity.length === 0 && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>None on file.</div>}
            {identity.map((d) => (
              <Item
                key={d.requirement}
                ok={d.verificationStatus === 'VERIFIED'}
                label={d.label}
                detail={d.verificationStatus === 'VERIFIED' ? 'verified against the original'
                  : d.verificationStatus === 'REJECTED' ? 'sent back' : (d.filePaths ?? []).length > 0 ? 'not checked yet' : 'no scan'}
                action={<Attachments documentId={d.id} filePaths={d.filePaths ?? []} canManage={false} onRemoved={() => undefined} onError={setErr} documentLabel={d.label} />}
              />
            ))}
          </Section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
          <Section title="Background check">
            <Item
              ok={check?.verdict === BackgroundCheckVerdict.CLEAR && reportFiles.length > 0 && bgvClearGaps(check).length === 0}
              label={check ? (VERDICT_LABELS[check.verdict] ?? check.verdict) : 'Not recorded'}
              detail={check ? [check.checkedByName, check.checkedOn ? fmtDate(check.checkedOn) : null].filter(Boolean).join(' · ') || undefined : undefined}
              action={check ? <CheckReport files={reportFiles} documentPaths={bgvReport?.filePaths ?? []} onError={setErr} /> : undefined}
            />
            {/* Its three parts (2026-09-24) — what the agency actually checked, each ticked on its own. */}
            {check && bgvPartStates(check).map((p) => (
              <Item key={p.part} ok={p.clear} label={BGV_PART_LABELS[p.part]} detail={bgvPartText(p.part, check)} />
            ))}
          </Section>

          <Section title="Bank and location">
            <Item ok={!!person.bankAccountNumber} label="Bank account" detail={lastFour(person.bankAccountNumber) ?? 'not on file'} />
            <Item ok={!!person.ifscCode} label="IFSC" detail={person.ifscCode ?? 'not on file'} />
            <Item
              ok={pinned}
              label="Home location"
              detail={pinned ? <GeoPrecisionBadge source={person.geoSource} matchedName={person.geoMatchedName} compact /> : 'not pinned'}
            />
          </Section>

          <Section title="References">
            <Item ok={references.length > 0 && called === references.length}
              label={`${references.length} ${references.length === 1 ? 'reference' : 'references'}`}
              detail={references.length === 0 ? 'none recorded' : `${called} of ${references.length} called`} />
          </Section>

          {/*
            The decision, beside the file. The same panel as on the record — one place that decides,
            wherever it is shown — told what making them Active is still waiting on.
          */}
          <ApprovalPanel
            assayerId={assayerId}
            lifecycleStatus={person.lifecycleStatus}
            canManage={canManageAssayers(roles, permissions)}
            canApprove={canApproveJoiners(roles, permissions)}
            currentUserId={currentUserId}
            onChanged={refresh}
            activationBlockers={blockers}
          />
          {person.lifecycleStatus !== AssayerLifecycleStatus.FINAL_APPROVAL && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              They are {assayerLifecycleLabel(person.lifecycleStatus)} — nothing is waiting for approval.
            </div>
          )}
        </div>
      </div>
    </Page>
  );
};

export default ApprovalReviewPage;
