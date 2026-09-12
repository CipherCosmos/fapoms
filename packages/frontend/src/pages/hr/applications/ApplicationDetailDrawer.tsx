import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApplicationStatus, APPLICATION_TERMINAL_STATUSES } from '@fapoms/shared';

import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { queryKeys } from '../../../hooks/queryKeys';
import { loadFailed } from '../../../queryClient';
import { LoadFailure } from '../../../components/LoadFailure';
import { DetailDrawer, AlertBanner, StatusBadge, useConfirm } from '../../../components/ui';
import { humanizeStatus } from '../../../config/status-registry';
import { Field, fmtDate, fmtWhen } from '../hr-ui';
import type { AssayerApplicationDetail } from './HrApplicationsPage';

/**
 * The detail view HR reviews an application from — every submitted field, the document
 * checklist, and the three decisions `HrApplicationsController` accepts: Approve, Reject (with a
 * reason), Request Info (with notes). See that controller and `RegistrationApplicationService`
 * on the backend for the exact contract.
 */
export const ApplicationDetailDrawer: React.FC<{
  id: string;
  onClose: () => void;
  /** Called only once an action has actually succeeded — the caller closes and refreshes the list. */
  onSuccess: (notice: { tone: 'ok' | 'err'; text: string }) => void;
}> = ({ id, onClose, onSuccess }) => {
  const { confirm, confirmWithReason, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: queryKeys.hr.applicationDetail(id),
    queryFn: () => api.request<AssayerApplicationDetail>(`/hr/applications/${id}`),
  });

  const detail = detailQuery.data;
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
      const assayer = await api.request<{ assayerCode: string; displayName: string }>(
        `/hr/applications/${id}/approve`,
        { method: 'POST' },
      );
      onSuccess({ tone: 'ok', text: `Approved. ${assayer.displayName} is now Appraiser ${assayer.assayerCode}.` });
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
      const { emailed } = await api.request<{ emailed: boolean }>(`/hr/applications/${id}/resend-invite`, {
        method: 'POST',
      });
      onSuccess(emailed
        ? { tone: 'ok', text: `A fresh registration link was emailed to ${app?.email}.` }
        : { tone: 'err', text: `A fresh link was generated but the email to ${app?.email} did not go out. Check email delivery in Platform Settings.` });
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
                {/* Only where it can do anything: an application with no address on it has
                    nowhere to send, and the server refuses that case too. */}
                {app.email ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleResend}
                    disabled={busy}
                    title="Send a fresh registration link. Any earlier link stops working."
                    style={{ fontSize: '12px', padding: '8px 14px', marginRight: 'auto' }}
                  >
                    Resend link
                  </button>
                ) : null}
                <button type="button" className="btn btn-secondary" onClick={handleRequestInfo} disabled={busy} style={{ fontSize: '12px', padding: '8px 14px' }}>
                  Request info
                </button>
                {/* `.btn-danger` carries no rule in index.css (see ConfirmDialog.tsx's own danger
                    button) — background/border are overridden inline the same way that one is. */}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleReject}
                  disabled={busy}
                  style={{ fontSize: '12px', padding: '8px 14px', background: 'var(--danger)', borderColor: 'var(--danger)' }}
                >
                  Reject
                </button>
                <button type="button" className="btn btn-primary" onClick={handleApprove} disabled={busy} style={{ fontSize: '12px', padding: '8px 14px' }}>
                  {busy ? 'Working…' : 'Approve'}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: '12px', padding: '8px 14px' }}>
                Close
              </button>
            )
          ) : undefined
        }
      >
        {loadFailed(detailQuery) ? (
          <LoadFailure loads={[{ label: 'this application', query: detailQuery }]} />
        ) : !detail || !app ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
        ) : (
          <>
            {actionError && (
              <AlertBanner type="error" onClose={() => setActionError(null)}>
                {actionError}
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
              <Field title="Mobile"><div>{app.mobile}</div></Field>
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
                  <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '2px' }}>
                    {[app.city, app.state, app.pincode].filter(Boolean).join(', ')}
                  </div>
                )}
              </div>
            </Field>

            <Field title="Expertise" wide><div>{app.expertise || '—'}</div></Field>
            <Field title="Availability" wide><div>{app.availability || '—'}</div></Field>

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
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>
                Documents submitted
              </div>
              {detail.documents.length === 0 ? (
                <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No documents uploaded yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {detail.documents.map((doc) => (
                    <div
                      key={doc.id}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '8px 12px', borderRadius: '7px', background: 'var(--bg-surface)',
                        border: '1px solid var(--border-hair)', fontSize: '12.5px',
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
