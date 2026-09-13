import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApplicationStatus, APPLICATION_TERMINAL_STATUSES } from '@fapoms/shared';

import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { queryKeys } from '../../../hooks/queryKeys';
import { loadFailed } from '../../../queryClient';
import { LoadFailure } from '../../../components/LoadFailure';
import { DetailDrawer, AlertBanner, StatusBadge, useConfirm } from '../../../components/ui';
import { humanizeStatus } from '../../../config/status-registry';
import { Field, fmtDate, fmtWhen, InviteLinkBox } from '../hr-ui';
import type { AssayerApplicationDetail } from './HrApplicationsPage';
import { SkeletonList } from '../../../components/ui/Loading';

/**
 * The detail view HR reviews an application from — every submitted field, the document
 * checklist, and the three decisions `HrApplicationsController` accepts: Approve, Reject (with a
 * reason), Request Info (with notes). See that controller and `RegistrationApplicationService`
 * on the backend for the exact contract.
 */
const TERM_INPUT: React.CSSProperties = {
  padding: '8px 10px', background: 'var(--bg-input)', border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-sm, 6px)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)',
  width: '100%', boxSizing: 'border-box', outline: 'none',
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px',
};

export const ApplicationDetailDrawer: React.FC<{
  id: string;
  onClose: () => void;
  /** Called only once an action has actually succeeded — the caller closes and refreshes the list. */
  onSuccess: (notice: { tone: 'ok' | 'err'; text: string }) => void;
}> = ({ id, onClose, onSuccess }) => {
  const { confirm, confirmWithReason, confirmDialog } = useConfirm();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * The freshly minted link, kept HERE rather than handed to `onSuccess`.
   *
   * Every other action on this drawer ends the review, so `onSuccess` closes it. A resend does
   * not: the desk still has to deliver the link, and the link only exists in this one response.
   * Closing the drawer on it would throw away the thing the action was for.
   */
  const [resent, setResent] = useState<{ emailed: boolean; inviteLink: string } | null>(null);
  /**
   * What the reviewer adds as they approve.
   *
   * Approving used to carry no body at all, so a joining date — a critical record field collected
   * by no form in the product — was left blank on every person promoted through this queue, and
   * the reviewer had to remember to open the new record afterwards. This is that half of the
   * person, entered in the same action by the person who just decided to hire them.
   */
  const [terms, setTerms] = useState<Record<string, string>>({});
  const setTerm = (key: string, value: string) => setTerms((t) => ({ ...t, [key]: value }));


  const detailQuery = useQuery({
    queryKey: queryKeys.hr.applicationDetail(id),
    queryFn: () => api.request<AssayerApplicationDetail>(`/hr/applications/${id}`),
  });

  const detail = detailQuery.data;

  const profileFields = detail?.application.extendedProfile?.fields ?? {};
  const candidateFacts: Array<[string, string]> = ([
    ['PAN', 'panNumber'],
    ['Aadhaar', 'aadhaarNumber'],
    ['Bank account', 'bankAccountNumber'],
    ['IFSC', 'ifscCode'],
    ['Bank', 'bankName'],
    ['Qualification', 'qualification'],
    ['Emergency contact', 'emergencyContactName'],
    ['Emergency phone', 'emergencyContactPhone'],
    ['Relationship', 'emergencyContactRelation'],
  ] as Array<[string, string]>)
    .map(([label, key]) => [label, String(profileFields[key] ?? '').trim()] as [string, string])
    .filter(([, value]) => value !== '');
  const app = detail?.application;
  const name = app?.fullName || app?.mobile || 'this candidate';
  const isReviewable = !!app && !APPLICATION_TERMINAL_STATUSES.includes(app.status);

  const handleApprove = async () => {
    setActionError(null);
    const ok = await confirm({
      title: `Approve ${name}?`,
      message: 'This promotes the application to a real assayer record and emails the candidate their Appraiser code.',
      confirmLabel: 'Approve & create assayer',
      reversible: false,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const filled = Object.fromEntries(
        Object.entries(terms).filter(([, v]) => v.trim() !== ''),
      );
      const assayer = await api.request<{ assayerCode: string; displayName: string; gaps?: string[] }>(
        `/hr/applications/${id}/approve`,
        {
          method: 'POST',
          body: JSON.stringify(Object.keys(filled).length > 0 ? { terms: filled } : {}),
        },
      );
      /**
       * A partial promotion is not a success. Some of what this action files goes through guarded
       * services that can refuse — a rate outside policy, an identity field the roster rejects —
       * and those refusals used to reach only the audit trail while the screen said "Approved."
       */
      const gaps = assayer.gaps ?? [];
      onSuccess(gaps.length === 0
        ? { tone: 'ok', text: `Approved. ${assayer.displayName} is now Appraiser ${assayer.assayerCode}.` }
        : {
          tone: 'err',
          text: `${assayer.displayName} is Appraiser ${assayer.assayerCode}, but part of it did not file: `
            + `${gaps.join('; ')}. Fix it on their record.`,
        });
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setActionError(null);
    const { confirmed, reason } = await confirmWithReason({
      title: `Reject ${name}?`,
      message: 'The candidate will be emailed that their application was declined, along with this reason.',
      confirmLabel: 'Reject application',
      tone: 'danger',
      reversible: false,
      reasonPrompt: {
        label: 'Reason (sent to the candidate)',
        placeholder: 'e.g. Does not meet the minimum experience requirement',
      },
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.request(`/hr/applications/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      onSuccess({ tone: 'ok', text: `${name}'s application was rejected.` });
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRequestInfo = async () => {
    setActionError(null);
    const { confirmed, reason: notes } = await confirmWithReason({
      title: `Ask ${name} for more information?`,
      message: 'They will be emailed a fresh link to resume their application, along with these notes.',
      confirmLabel: 'Send request',
      reasonPrompt: {
        label: 'What do you need from them?',
        placeholder: 'e.g. Please upload a clearer PAN card scan',
      },
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.request(`/hr/applications/${id}/request-info`, {
        method: 'POST',
        body: JSON.stringify({ notes }),
      });
      onSuccess({ tone: 'ok', text: `Asked ${name} for more information.` });
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The way out of an invite that never arrived.
   *
   * A candidate whose email was lost, filtered or never sent sits in DRAFT with a link nobody
   * holds — and the message they see if they find an old one says "Ask HR to resend it". This is
   * that action. It mints a new link and retires the previous one.
   */
  const handleResend = async () => {
    setActionError(null);
    setBusy(true);
    try {
      const { emailed, inviteLink } = await api.request<{ emailed: boolean; inviteLink: string }>(
        `/hr/applications/${id}/resend-invite`,
        { method: 'POST' },
      );
      setResent({ emailed, inviteLink });
      void queryClient.invalidateQueries({ queryKey: queryKeys.hr.applicationsAll });
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {confirmDialog}
      <DetailDrawer
        open
        onClose={onClose}
        title={name}
        subtitle={app ? <StatusBadge domain="applicationStatus" status={app.status} /> : undefined}
        width={620}
        footer={
          app ? (
            isReviewable ? (
              <>
                {/* Offered whether or not an address is on file. It used to be hidden without
                    one, because the server refused that case — but a link the desk delivers by
                    hand needs no mailbox, and on a deployment with email switched off that is the
                    only delivery there is. */}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleResend}
                  disabled={busy}
                  title="Mint a fresh registration link. Any earlier link stops working."
                  style={{ fontSize: 'var(--text-xs)', padding: '8px 14px', marginRight: 'auto' }}
                >
                  {app.email ? 'Resend link' : 'Get link'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleRequestInfo} disabled={busy} style={{ fontSize: 'var(--text-xs)', padding: '8px 14px' }}>
                  Request info
                </button>
                {/* `.btn-danger` carries no rule in index.css (see ConfirmDialog.tsx's own danger
                    button) — background/border are overridden inline the same way that one is. */}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleReject}
                  disabled={busy}
                  style={{ fontSize: 'var(--text-xs)', padding: '8px 14px', background: 'var(--danger)', borderColor: 'var(--danger)' }}
                >
                  Reject
                </button>
                <button type="button" className="btn btn-primary" onClick={handleApprove} disabled={busy} style={{ fontSize: 'var(--text-xs)', padding: '8px 14px' }}>
                  {busy ? 'Working…' : 'Approve'}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: 'var(--text-xs)', padding: '8px 14px' }}>
                Close
              </button>
            )
          ) : undefined
        }
      >
        {loadFailed(detailQuery) ? (
          <LoadFailure loads={[{ label: 'this application', query: detailQuery }]} />
        ) : !detail || !app ? (
          <div className="deferred-appear"><SkeletonList rows={5} height={40} /></div>
        ) : (
          <>
            {actionError && (
              <AlertBanner type="error" onClose={() => setActionError(null)}>
                {actionError}
              </AlertBanner>
            )}

            {/* An undelivered invite is an action item, not a cheerful confirmation — the same
                reading the interview screen gives it. AlertBanner has no warning tone. */}
            {resent && (
              <AlertBanner type={resent.emailed ? 'success' : 'error'} onClose={() => setResent(null)}>
                {resent.emailed
                  ? `A fresh registration link was emailed to ${app.email}. Any earlier link has stopped working.`
                  : app.email
                    ? `A fresh link was minted but the email to ${app.email} did not go out — send it yourself, and check email delivery in Platform Settings.`
                    : 'A fresh link was minted. There is no email address on this application, so send it to the candidate yourself.'}
                <InviteLinkBox link={resent.inviteLink} />
              </AlertBanner>
            )}

            {!isReviewable && (
              <AlertBanner type={app.status === ApplicationStatus.APPROVED ? 'success' : 'error'}>
                {app.status === ApplicationStatus.APPROVED
                  ? 'This application has already been approved and promoted to a live assayer record.'
                  : 'This application has already been rejected.'}
              </AlertBanner>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              <Field title="Mobile">
                <div>
                  {app.mobile}
                  {detail?.invitedMobile && (
                    /* The candidate's confirmed number wins — they know their own. HR's interview
                       number is shown beside it so a mismatch is a decision, not a silent swap. */
                    <div style={{ color: 'var(--warning, var(--text-muted))', fontSize: 'var(--text-xs)', marginTop: '2px' }}>
                      Interview record had {detail.invitedMobile}
                    </div>
                  )}
                </div>
              </Field>
              <Field title="Email"><div>{app.email || '—'}</div></Field>
              <Field title="Date of birth"><div>{fmtDate(app.dateOfBirth)}</div></Field>
              <Field title="Gender"><div>{app.gender || '—'}</div></Field>
              <Field title="Employment category"><div>{app.employmentCategory ? humanizeStatus(app.employmentCategory) : '—'}</div></Field>
              <Field title="Experience"><div>{app.experienceYears != null ? `${app.experienceYears} yrs` : '—'}</div></Field>
              <Field title="Current employer"><div>{app.currentEmployer || '—'}</div></Field>
              <Field title="Submitted"><div>{fmtWhen(app.createdAt)}</div></Field>
            </div>

            <Field title="Address" wide>
              <div>
                {app.address || '—'}
                {(app.city || app.state || app.pincode) && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginTop: '2px' }}>
                    {[app.city, app.state, app.pincode].filter(Boolean).join(', ')}
                  </div>
                )}
              </div>
            </Field>

            <Field title="Expertise" wide><div>{app.expertise || '—'}</div></Field>
            <Field title="Availability" wide><div>{app.availability || '—'}</div></Field>

            {/*
              What the candidate actually sent, which the reviewer could not see.

              The row type carried no `extendedProfile`, so the person approving an application was
              deciding without the PAN, the bank account or the emergency contact in front of them
              — the three things that decide whether the person can be paid and reached.
            */}
            {candidateFacts.length > 0 && (
              <div>
                <div style={SECTION_LABEL}>Identity, payment and next of kin</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                  {candidateFacts.map(([label, value]) => (
                    <Field key={label} title={label}><div>{value}</div></Field>
                  ))}
                </div>
              </div>
            )}

            {/*
              The gaps, named with what each one stops.

              `registrationGaps()` existed with no callers and a docblock claiming it was "offered
              to every screen that shows an application". This is that screen.
            */}
            {(detail?.gaps?.length ?? 0) > 0 && (
              <div>
                <div style={SECTION_LABEL}>Still missing</div>
                <ul style={{ margin: 0, paddingLeft: '18px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                  {detail!.gaps.map((g) => (
                    <li key={g.key} style={{ marginBottom: '3px' }}>
                      <strong>{g.label}</strong> — {g.blocks.toLowerCase()}
                    </li>
                  ))}
                </ul>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '6px' }}>
                  None of these stops the approval. Each one stops the thing it names, until it is
                  filled in on their record.
                </div>
              </div>
            )}

            {/*
              The half of the person only the desk can supply, entered while deciding to hire them.

              A joining date is a critical record field that no form in this product collected, so
              every person promoted through this queue arrived with it blank and the reviewer had
              to remember to go back for it. Nothing here is required: an approval is not refused
              over a blank, it just leaves the gap above it standing.
            */}
            {isReviewable && (
              <div>
                <div style={SECTION_LABEL}>Employment terms</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                  <Field title="Joining date">
                    <input
                      type="date"
                      value={terms.joiningDate ?? ''}
                      onChange={(e) => setTerm('joiningDate', e.target.value)}
                      style={TERM_INPUT}
                    />
                  </Field>
                  <Field title="Employment type">
                    <select
                      value={terms.employmentType ?? ''}
                      onChange={(e) => setTerm('employmentType', e.target.value)}
                      style={TERM_INPUT}
                    >
                      <option value="">Not set</option>
                      <option value="INTERNAL">Internal</option>
                      <option value="EXTERNAL">External</option>
                      <option value="CONTRACT">Contract</option>
                    </select>
                  </Field>
                  <Field title="Most jobs in a day">
                    <input
                      type="number" min={0} max={20}
                      value={terms.maxDailyWorkload ?? ''}
                      onChange={(e) => setTerm('maxDailyWorkload', e.target.value)}
                      style={TERM_INPUT}
                    />
                  </Field>
                  <Field title="Most jobs in a week">
                    <input
                      type="number" min={0} max={100}
                      value={terms.maxWeeklyWorkload ?? ''}
                      onChange={(e) => setTerm('maxWeeklyWorkload', e.target.value)}
                      style={TERM_INPUT}
                    />
                  </Field>
                  <Field title="Department">
                    <input
                      value={terms.department ?? ''}
                      onChange={(e) => setTerm('department', e.target.value)}
                      style={TERM_INPUT}
                    />
                  </Field>
                  <Field title="HR owner">
                    <input
                      value={terms.hrOwnerName ?? ''}
                      onChange={(e) => setTerm('hrOwnerName', e.target.value)}
                      placeholder="Who looks after this person"
                      style={TERM_INPUT}
                    />
                  </Field>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '6px' }}>
                  Filed as part of the approval. Anything left blank stays blank on their record and
                  is listed above as a gap.
                </div>
              </div>
            )}

            <Field title="Consent">
              <div>{app.consentAcceptedAt ? `Accepted ${fmtWhen(app.consentAcceptedAt)}` : 'Not yet accepted'}</div>
            </Field>

            {app.reviewedAt && (
              <Field title="HR decision" wide>
                <div>
                  {fmtWhen(app.reviewedAt)}
                  {app.reviewNotes && <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>{app.reviewNotes}</div>}
                </div>
              </Field>
            )}

            <div>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>
                Documents submitted
              </div>
              {detail.documents.length === 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No documents uploaded yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {detail.documents.map((doc) => (
                    <div
                      key={doc.id}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '8px 12px', borderRadius: '7px', background: 'var(--bg-surface)',
                        border: '1px solid var(--border-hair)', fontSize: 'var(--text-xs)',
                      }}
                    >
                      <span>{humanizeStatus(doc.requirement)}</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {doc.filePaths.length} file{doc.filePaths.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </DetailDrawer>
    </>
  );
};

export default ApplicationDetailDrawer;
