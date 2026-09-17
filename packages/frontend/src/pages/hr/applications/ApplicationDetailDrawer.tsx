import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApplicationStatus, ONBOARDING_DOCUMENT_LABELS, SCAN_UPLOAD_IMAGE_ACCEPT, scanMimeType,
  type OnboardingDocument,
} from '@fapoms/shared';
import { Eye, AlertTriangle, ShieldAlert, Check, Camera, Pencil } from 'lucide-react';

import { ScanOrAttach } from '../../../components/scanner/ScanOrAttach';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { queryKeys } from '../../../hooks/queryKeys';
import { loadFailed } from '../../../queryClient';
import { LoadFailure } from '../../../components/LoadFailure';
import { DetailDrawer, AlertBanner, StatusBadge, useConfirm, Modal } from '../../../components/ui';
import { humanizeStatus } from '../../../config/status-registry';
import { Field, fmtDate, fmtWhen, InviteLinkBox } from '../hr-ui';
import type { AssayerApplicationDetail, AssayerApplicationDocumentRow } from './application-types';
import { SkeletonList } from '../../../components/ui/Loading';
import { useCurrentUserId } from '../../../hooks/useCurrentRoles';
import { DocumentPreviewModal, type DocumentPreviewItem } from '../../../components/DocumentPreviewModal';

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

/**
 * A document requirement in the words the rest of the app uses.
 *
 * This screen ran requirements through `humanizeStatus`, which title-cases an enum: ten of the
 * twenty-seven came out differently here than everywhere else — "Nda" for the non-disclosure
 * agreement, "Pan card" for the PAN card, "Id proof" for identity proof, "Voter id" for the Voter
 * ID. A reviewer comparing this drawer against the candidate's own page was reading two names for
 * one paper. `ONBOARDING_DOCUMENT_LABELS` is the one list; `humanizeStatus` stays for the genuine
 * enums on this screen (statuses, employment category) that have no written label.
 */
const documentName = (requirement: string): string =>
  ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument] ?? humanizeStatus(requirement);

export const ApplicationDetailDrawer: React.FC<{
  id: string;
  onClose: () => void;
  /** Called only once an action has actually succeeded — the caller closes and refreshes the list. */
  onSuccess: (notice: { tone: 'ok' | 'err'; text: string; assayerId?: string }) => void;
}> = ({ id, onClose, onSuccess }) => {
  const { confirm, confirmWithReason, confirmDialog } = useConfirm();
  const queryClient = useQueryClient();
  const currentUserId = useCurrentUserId();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [staffUploading, setStaffUploading] = useState<Record<string, boolean>>({});

  // Document preview modal state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewItems, setPreviewItems] = useState<DocumentPreviewItem[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
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

  const [editingMobile, setEditingMobile] = useState(false);
  const [newMobile, setNewMobile] = useState('');
  const [savingMobile, setSavingMobile] = useState(false);
  const [mobileError, setMobileError] = useState<string | null>(null);
  const [allowSharedContact, setAllowSharedContact] = useState(false);
  const [sharedContactReason, setSharedContactReason] = useState('');

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
  const isDraft = app?.status === ApplicationStatus.DRAFT;
  const isApproved = app?.status === ApplicationStatus.APPROVED;
  const isRejected = app?.status === ApplicationStatus.REJECTED;

  const deskEditors: string[] = Array.isArray((app?.extendedProfile as any)?.deskEditors)
    ? (app?.extendedProfile as any).deskEditors
    : [];
  const isDeskEditor = Boolean(
    currentUserId &&
    ((app as any)?.createdBy === currentUserId || deskEditors.includes(currentUserId))
  );

  const hasPhotograph = Boolean(
    detail?.documents?.some((d) => d.requirement === 'PHOTOGRAPH' && d.filePaths?.length > 0),
  );
  const isReviewable = !isApproved && !isRejected;
  const canApprove = !isDraft && isReviewable && !isDeskEditor && hasPhotograph;

  const handleUpdateMobile = async () => {
    const trimmed = newMobile.trim();
    if (!trimmed) {
      setMobileError('Please enter a mobile number.');
      return;
    }
    setSavingMobile(true);
    setMobileError(null);
    try {
      await api.request(`/hr/applications/${id}/mobile`, {
        method: 'PATCH',
        body: JSON.stringify({ mobile: trimmed }),
      });
      setEditingMobile(false);
      await detailQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: queryKeys.hr.applicationsAll });
    } catch (err) {
      setMobileError(userMessage(err));
    } finally {
      setSavingMobile(false);
    }
  };

  const handleStaffUpload = async (requirement: string, file: File) => {
    setStaffUploading((prev) => ({ ...prev, [requirement]: true }));
    setActionError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      await api.request(`/hr/applications/${id}/documents/${requirement}`, {
        method: 'POST',
        body: formData,
      });
      await detailQuery.refetch();
    } catch (err) {
      setActionError(`Could not attach ${documentName(requirement)}: ${userMessage(err)}`);
    } finally {
      setStaffUploading((prev) => ({ ...prev, [requirement]: false }));
    }
  };

  const openDocumentPreview = async (doc: AssayerApplicationDocumentRow, startIdx = 0) => {
    setPreviewLoading(doc.requirement);
    setActionError(null);
    try {
      const items: DocumentPreviewItem[] = [];
      for (let i = 0; i < doc.filePaths.length; i++) {
        const filePath = doc.filePaths[i];
        const fileName = filePath.split('/').pop() ?? `${doc.requirement}-${i + 1}`;
        const blob = await api.request<Blob>(`/hr/applications/${id}/documents/${doc.requirement}/file/${i}`, { raw: true });
        // Same re-typing as everywhere else: the route sends no usable `Content-Type`, and the
        // viewer decides what to draw from the type it is handed.
        const type = scanMimeType(fileName);
        const url = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
        items.push({
          title: `${documentName(doc.requirement)}${doc.filePaths.length > 1 ? ` (File ${i + 1} of ${doc.filePaths.length})` : ''}`,
          url,
          fileName,
          mimeType: type ?? blob.type,
        });
      }
      setPreviewItems(items);
      setPreviewIndex(startIdx);
      setPreviewOpen(true);
    } catch (err) {
      setActionError(`Could not load document: ${userMessage(err)}`);
    } finally {
      setPreviewLoading(null);
    }
  };

  const handleClosePreview = () => {
    setPreviewOpen(false);
    previewItems.forEach((item) => URL.revokeObjectURL(item.url));
    setPreviewItems([]);
  };

  const handleApprove = async () => {
    if (!canApprove) return;
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
      const assayer = await api.request<{ id: string; assayerCode: string; displayName: string; gaps?: string[] }>(
        `/hr/applications/${id}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(Object.keys(filled).length > 0 ? { terms: filled } : {}),
            ...(allowSharedContact ? {
              allowSharedContact: true,
              sharedContactReason: sharedContactReason.trim() || 'HR approved shared contact override',
            } : {}),
          }),
        },
      );
      /**
       * A partial promotion is not a success. Some of what this action files goes through guarded
       * services that can refuse — a rate outside policy, an identity field the roster rejects —
       * and those refusals used to reach only the audit trail while the screen said "Approved."
       */
      const gaps = assayer.gaps ?? [];
      onSuccess(gaps.length === 0
        ? { tone: 'ok', text: `Approved. ${assayer.displayName} is now Appraiser ${assayer.assayerCode}.`, assayerId: assayer.id }
        : {
          tone: 'err',
          text: `${assayer.displayName} is Appraiser ${assayer.assayerCode}, but part of it did not file: `
            + `${gaps.join('; ')}. Fix it on their record.`,
          assayerId: assayer.id,
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
        // Was a fixed 640px on every screen, which squeezed each document row until it scrolled.
        width="min(860px, 94vw)"
        footer={
          app ? (
            isReviewable ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                {actionError && (
                  <AlertBanner type="error" onClose={() => setActionError(null)}>
                    {actionError}
                  </AlertBanner>
                )}
                {!canApprove && (
                  <div style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-secondary)',
                    background: 'var(--bg-surface-2)',
                    border: '1px solid var(--border-hair)',
                    borderRadius: '6px',
                    padding: '7px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}>
                    {isDeskEditor && !isDraft
                      ? '🔒 Maker–Checker Policy: Another authorized HR user must approve this application.'
                      : isDraft
                        ? 'ℹ️ Candidate has not submitted their application yet. You can resend their link, fill it in for them, or reject the draft.'
                        : !hasPhotograph
                          ? '📷 Photograph required: Candidate ID card cannot be issued without a photo. Attach a photo below or click "Request info".'
                          : 'Candidate cannot be approved at this time.'}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', width: '100%', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleResend}
                    disabled={busy}
                    title="Mint a fresh registration link. Any earlier link stops working."
                    style={{ fontSize: 'var(--text-xs)', padding: '8px 14px', minHeight: '38px', marginRight: 'auto' }}
                  >
                    {app.email ? 'Resend link' : 'Get link'}
                  </button>
                  {isDraft && (
                    <Link
                      to={`/hr/register/application/${id}`}
                      className="btn btn-secondary"
                      style={{ fontSize: 'var(--text-xs)', padding: '8px 14px', minHeight: '38px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                    >
                      Fill in details
                    </Link>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleRequestInfo}
                    disabled={busy || isDraft}
                    title={isDraft ? 'Cannot request info on an unsubmitted draft' : 'Ask candidate for clarifications or missing documents'}
                    style={{ fontSize: 'var(--text-xs)', padding: '8px 14px', minHeight: '38px' }}
                  >
                    Request info
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleReject}
                    disabled={busy}
                    style={{ fontSize: 'var(--text-xs)', padding: '8px 14px', minHeight: '38px', background: 'var(--danger)', borderColor: 'var(--danger)' }}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleApprove}
                    disabled={!canApprove || busy}
                    title={!canApprove
                      ? (isDraft
                        ? 'Candidate has not submitted their application yet'
                        : isDeskEditor
                          ? 'Maker–Checker Policy: Another authorized HR user must approve this application'
                          : !hasPhotograph
                            ? 'Photograph is required for ID card issuance'
                            : 'Cannot approve')
                      : 'Approve & create assayer'}
                    style={{
                      fontSize: 'var(--text-xs)', padding: '8px 14px', minHeight: '38px',
                      opacity: !canApprove ? 0.45 : 1,
                      cursor: !canApprove ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {busy ? 'Working…' : 'Approve'}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
                {isApproved && app.promotedAssayerId && (
                  <Link
                    to={`/hr/roster/${app.promotedAssayerId}`}
                    className="btn btn-primary"
                    style={{ fontSize: 'var(--text-xs)', padding: '8px 14px', textDecoration: 'none' }}
                  >
                    Open Assayer Record &rarr;
                  </Link>
                )}
                {isDraft && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleResend}
                    disabled={busy}
                    title="Mint a fresh registration link."
                    style={{ fontSize: 'var(--text-xs)', padding: '8px 14px' }}
                  >
                    {app.email ? 'Resend link' : 'Get link'}
                  </button>
                )}
                <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: 'var(--text-xs)', padding: '8px 14px', marginLeft: 'auto' }}>
                  Close
                </button>
              </div>
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

            {isDraft && (
              <div style={{
                padding: '12px 14px', borderRadius: '8px',
                background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
                border: '1px solid var(--warning)',
                display: 'flex', gap: '10px', alignItems: 'flex-start',
                marginBottom: '14px',
              }}>
                <AlertTriangle size={16} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '2px' }} />
                <div style={{ fontSize: 'var(--text-xs)', lineHeight: 1.5 }}>
                  <strong style={{ display: 'block', color: 'var(--text-primary)', marginBottom: '2px' }}>
                    Registration Incomplete (Draft)
                  </strong>
                  The candidate has not submitted their application or confirmed their OTP code yet. Approvals are gated until the candidate submits.
                  <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <Link
                      to={`/hr/register/application/${id}`}
                      className="btn btn-secondary"
                      style={{ fontSize: 'var(--text-xs)', padding: '4px 10px', textDecoration: 'none' }}
                    >
                      Fill in details for them
                    </Link>
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={busy}
                      className="btn btn-secondary"
                      style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
                    >
                      Resend link to candidate
                    </button>
                  </div>
                </div>
              </div>
            )}

            {isDeskEditor && !isDraft && isReviewable && (
              <div style={{
                padding: '12px 14px', borderRadius: '8px',
                background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
                border: '1px solid var(--warning)',
                display: 'flex', gap: '10px', alignItems: 'flex-start',
                marginBottom: '14px',
              }}>
                <ShieldAlert size={16} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '2px' }} />
                <div style={{ fontSize: 'var(--text-xs)', lineHeight: 1.5 }}>
                  <strong style={{ display: 'block', color: 'var(--text-primary)', marginBottom: '2px' }}>
                    Maker–Checker Policy Enforced
                  </strong>
                  You participated in entering or editing this application. Under company compliance policy, another authorized HR reviewer must approve it.
                </div>
              </div>
            )}

            {isApproved && (
              <div style={{
                padding: '12px 14px', borderRadius: '8px',
                background: 'color-mix(in srgb, var(--success) 12%, transparent)',
                border: '1px solid var(--success)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px',
                marginBottom: '14px',
              }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <Check size={16} style={{ color: 'var(--success)' }} />
                  <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--success)' }}>
                    Approved & Promoted to Assayer
                  </span>
                </div>
                {app.promotedAssayerId && (
                  <Link
                    to={`/hr/roster/${app.promotedAssayerId}`}
                    className="btn btn-primary"
                    style={{ fontSize: 'var(--text-xs)', padding: '5px 12px', textDecoration: 'none' }}
                  >
                    Open Assayer Record &rarr;
                  </Link>
                )}
              </div>
            )}

            {isRejected && (
              <AlertBanner type="error" style={{ marginBottom: '14px' }}>
                This application was rejected.{app.reviewNotes ? ` Reason: ${app.reviewNotes}` : ''}
              </AlertBanner>
            )}

            {detail?.phoneConflict && (
              <div style={{
                padding: '12px 14px', borderRadius: '8px',
                background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
                border: '1px solid var(--danger)',
                display: 'flex', flexDirection: 'column', gap: '8px',
                marginBottom: '14px',
              }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <AlertTriangle size={16} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                  <strong style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>
                    Mobile Number Conflict
                  </strong>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                  {detail.phoneConflict.message}
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setNewMobile(app.mobile || '');
                      setMobileError(null);
                      setEditingMobile(true);
                    }}
                    style={{ fontSize: 'var(--text-xs)', padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  >
                    <Pencil size={12} />
                    Correct Candidate Mobile Number
                  </button>

                  {isReviewable && !isDraft && (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                      <input
                        type="checkbox"
                        checked={allowSharedContact}
                        onChange={(e) => setAllowSharedContact(e.target.checked)}
                      />
                      Allow as authorized shared contact
                    </label>
                  )}
                </div>
                {allowSharedContact && (
                  <div style={{ marginTop: '4px' }}>
                    <input
                      type="text"
                      value={sharedContactReason}
                      onChange={(e) => setSharedContactReason(e.target.value)}
                      placeholder="Reason for shared contact (e.g. spouse/household member of existing assayer)"
                      style={{ ...TERM_INPUT, fontSize: 'var(--text-xs)', padding: '6px 8px' }}
                    />
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              <Field title="Mobile">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: 600 }}>{app.mobile}</span>
                    {isReviewable && (
                      <button
                        type="button"
                        onClick={() => {
                          setNewMobile(app.mobile || '');
                          setMobileError(null);
                          setEditingMobile(true);
                        }}
                        className="btn btn-secondary"
                        style={{ padding: '2px 6px', fontSize: 'var(--text-2xs)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                        title="Edit mobile number"
                      >
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                  </div>
                  {detail?.phoneConflict && (
                    <div style={{ color: 'var(--danger)', fontSize: 'var(--text-2xs)', marginTop: '2px', fontWeight: 600 }}>
                      ⚠️ Phone already registered
                    </div>
                  )}
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
              <Field title={isDraft ? 'Invited' : 'Submitted'}>
                <div>{fmtWhen(isDraft ? app.createdAt : (app.consentAcceptedAt ?? (app as any).updatedAt ?? app.createdAt))}</div>
              </Field>
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
              The interview, which the person deciding this application could not see. Its notes
              were stored every time and appeared on no screen, so a reviewer approving somebody had
              to go and ask the interviewer what they had thought.
            */}
            {detail?.interview && (
              <Field title="From the interview" wide>
                <div data-testid="application-interview" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                    {detail.interview.outcome === 'PASS' ? 'Passed' : detail.interview.outcome === 'FAIL' ? 'Did not pass' : detail.interview.outcome}
                    {' · '}{fmtWhen(detail.interview.interviewedAt)}
                    {detail.interview.interviewedByName ? ` · ${detail.interview.interviewedByName}` : ''}
                  </span>
                  {detail.interview.notes?.trim()
                    ? <span style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{detail.interview.notes}</span>
                    : <span style={{ color: 'var(--text-muted)' }}>The interviewer wrote nothing down.</span>}
                </div>
              </Field>
            )}

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
            {((detail?.gaps?.length ?? 0) > 0 || !hasPhotograph) && (
              <div>
                <div style={SECTION_LABEL}>Still missing</div>
                <ul style={{ margin: 0, paddingLeft: '18px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                  {!hasPhotograph && (
                    <li style={{ marginBottom: '3px', color: 'var(--warning)', fontWeight: 600 }}>
                      Photograph — blocks approval & ID card issuance (attach photo below)
                    </li>
                  )}
                  {detail?.gaps?.map((g) => (
                    <li key={g.key} style={{ marginBottom: '3px' }}>
                      <strong>{g.label}</strong> — {g.blocks.toLowerCase()}
                    </li>
                  ))}
                </ul>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '6px' }}>
                  {!hasPhotograph
                    ? 'Photograph is required before approval can proceed. Other missing fields can be updated after approval on the appraiser record.'
                    : 'None of these stops the approval. Each one stops the thing it names, until it is filled in on their record.'}
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
            {isReviewable && !isDraft && (
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

              {!hasPhotograph && isReviewable && !isDraft && (
                <div style={{
                  padding: '12px 14px', borderRadius: '8px',
                  background: 'var(--status-amber-bg)', border: '1px solid var(--warning)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
                  marginBottom: '10px',
                }}>
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <Camera size={14} /> Photograph Missing (Required for Approval & ID Card)
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      Attach a candidate photo from the desk, or use &ldquo;Request info&rdquo; to prompt the candidate.
                    </div>
                  </div>
                  {/* The photograph the ID card prints — taken at the desk with the person there. */}
                  <ScanOrAttach
                    documentLabel="Candidate photograph"
                    requirement="PHOTOGRAPH"
                    size="sm"
                    accept={SCAN_UPLOAD_IMAGE_ACCEPT}
                    disabled={staffUploading['PHOTOGRAPH']}
                    attachLabel={staffUploading['PHOTOGRAPH'] ? 'Uploading…' : 'Choose photo'}
                    onFiles={(files) => { if (files[0]) void handleStaffUpload('PHOTOGRAPH', files[0]); }}
                  />
                </div>
              )}

              {detail.documents.length === 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: '10px', background: 'var(--bg-surface)', borderRadius: '6px', border: '1px dashed var(--border-hair)' }}>
                  No documents uploaded yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {detail.documents.map((doc) => {
                    const hasFiles = doc.filePaths.length > 0;
                    const isLoadingThis = previewLoading === doc.requirement;
                    const isStaffUploadingThis = staffUploading[doc.requirement];
                    return (
                      <div
                        key={doc.id}
                        style={{
                          // Wraps: a long document name beside "View · Scan · Choose file" used to be
                          // one row that could not shrink, and scrolled the drawer sideways.
                          display: 'flex', flexWrap: 'wrap', gap: '8px 12px',
                          justifyContent: 'space-between', alignItems: 'center',
                          padding: '10px 14px', borderRadius: '8px', background: 'var(--bg-surface)',
                          border: '1px solid var(--border-hair)', fontSize: 'var(--text-xs)',
                        }}
                      >
                        <div
                          data-testid="application-document-name"
                          style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 180px', minWidth: 0, overflowWrap: 'anywhere' }}
                        >
                          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                            {documentName(doc.requirement)}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)' }}>
                            {doc.filePaths.length} file{doc.filePaths.length === 1 ? '' : 's'} attached
                          </span>
                        </div>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                          {hasFiles && (
                            <button
                              type="button"
                              onClick={() => openDocumentPreview(doc, 0)}
                              disabled={isLoadingThis}
                              className="btn btn-secondary"
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: '6px',
                                fontSize: 'var(--text-xs)', padding: '5px 10px',
                              }}
                              title="Inspect uploaded document scan"
                            >
                              <Eye size={13} />
                              {isLoadingThis ? 'Loading…' : 'Inspect Scan'}
                            </button>
                          )}

                          {isReviewable && (
                            <ScanOrAttach
                              documentLabel={documentName(doc.requirement)}
                              requirement={doc.requirement}
                              size="sm"
                              disabled={isStaffUploadingThis}
                              attachLabel={isStaffUploadingThis ? 'Uploading…' : hasFiles ? 'Replace' : 'Choose file'}
                              onFiles={(files) => { if (files[0]) void handleStaffUpload(doc.requirement, files[0]); }}
                            />
                          )}

                          {!hasFiles && !isReviewable && (
                            <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Pending upload</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </DetailDrawer>

      <DocumentPreviewModal
        open={previewOpen}
        onClose={handleClosePreview}
        items={previewItems}
        initialIndex={previewIndex}
      />

      <Modal
        open={editingMobile}
        onClose={() => {
          if (!savingMobile) {
            setEditingMobile(false);
            setMobileError(null);
          }
        }}
        title="Edit Candidate Mobile Number"
        width="440px"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', width: '100%' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setEditingMobile(false);
                setMobileError(null);
              }}
              disabled={savingMobile}
              style={{ fontSize: 'var(--text-xs)', padding: '6px 14px' }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleUpdateMobile()}
              disabled={savingMobile}
              style={{ fontSize: 'var(--text-xs)', padding: '6px 14px' }}
            >
              {savingMobile ? 'Saving…' : 'Update Mobile'}
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Update the mobile phone number recorded on this application. The new number will be validated against active assayers and other applications.
          </div>
          {mobileError && (
            <AlertBanner type="error" onClose={() => setMobileError(null)}>
              {mobileError}
            </AlertBanner>
          )}
          <div>
            <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, marginBottom: '4px', color: 'var(--text-primary)' }}>
              10-Digit Mobile Number
            </label>
            <div style={{ position: 'relative' }}>
              <span style={{
                position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
                color: 'var(--text-secondary)', fontSize: 'var(--text-xs)', fontWeight: 600,
              }}>
                +91
              </span>
              <input
                type="tel"
                value={newMobile}
                onChange={(e) => setNewMobile(e.target.value)}
                placeholder="9876543210"
                maxLength={15}
                style={{ ...TERM_INPUT, paddingLeft: '40px' }}
                disabled={savingMobile}
              />
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default ApplicationDetailDrawer;
