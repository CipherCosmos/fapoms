import React, { useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApplicationStatus } from '@fapoms/shared';

import { api } from '../../../services/api';
import { queryKeys } from '../../../hooks/queryKeys';
import { loadFailed } from '../../../queryClient';
import { LoadFailure } from '../../../components/LoadFailure';
import { PageHeader, AlertBanner, DataTable, StatusBadge, EmptyState } from '../../../components/ui';
import type { Column } from '../../../components/ui';
import { humanizeStatus } from '../../../config/status-registry';
import { ViewChips, useViewParam, fmtWhen } from '../hr-ui';
import { ApplicationDetailDrawer } from './ApplicationDetailDrawer';

/**
 * HR's review queue for self-registration applications — the Appraiser Recruitment spec's
 * Module 4, scoped to the NEW candidate-facing intake path only. See
 * `hr-applications.controller.ts` / `registration-application.service.ts` on the backend, and
 * `assayer-application.ts` in `@fapoms/shared` for why an application is a separate record from
 * the live assayer roster (the existing HR-desk wizard at `/hr/register` never produces one of
 * these — it still writes a live assayer directly).
 */
export interface AssayerApplicationRow {
  id: string;
  fullName: string | null;
  mobile: string;
  email: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  address: string | null;
  state: string | null;
  city: string | null;
  pincode: string | null;
  experienceYears: number | null;
  currentEmployer: string | null;
  expertise: string | null;
  availability: string | null;
  employmentCategory: 'FREELANCER' | 'PROPRIETOR' | null;
  consentAcceptedAt: string | null;
  status: ApplicationStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  promotedAssayerId: string | null;
  createdAt: string;
}

export interface AssayerApplicationDocumentRow {
  id: string;
  requirement: string;
  filePaths: string[];
}

export interface AssayerApplicationDetail {
  application: AssayerApplicationRow;
  documents: AssayerApplicationDocumentRow[];
}

/**
 * The statuses HR filters by. The backend's own default (`GET /hr/applications` with no `status`)
 * returns every row, so this screen always sends one explicitly rather than rendering that
 * unfiltered list.
 *
 * `DRAFT` was originally left out on the grounds that somebody mid-form has nothing for HR to act
 * on. That is true of half the people in it. The other half were invited and never arrived —
 * their email bounced, was filtered, or (with email delivery switched off) was never sent — and
 * they are invisible to everyone while the interview log cheerfully reports an invite. "Not
 * started" is where those are found, and the drawer's Resend link is what it is for.
 */
const STATUS_FILTERS: readonly { key: ApplicationStatus; label: string; hint: string }[] = [
  { key: ApplicationStatus.PENDING_VALIDATION, label: 'Pending review', hint: 'Submitted by the candidate; awaiting an HR decision' },
  { key: ApplicationStatus.DRAFT, label: 'Not started', hint: 'Invited, but not yet submitted — including anyone whose link never reached them' },
  { key: ApplicationStatus.AWAITING_INFO, label: 'Awaiting info', hint: 'HR asked for a correction or an extra document' },
  { key: ApplicationStatus.REJECTED, label: 'Rejected', hint: 'HR declined these' },
  { key: ApplicationStatus.APPROVED, label: 'Approved', hint: 'Promoted to a live assayer record' },
];
const STATUS_KEYS = STATUS_FILTERS.map((f) => f.key);

export const HrApplicationsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useViewParam<ApplicationStatus>(STATUS_KEYS, ApplicationStatus.PENDING_VALIDATION);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const applicationsQuery = useQuery({
    queryKey: queryKeys.hr.applications(status),
    queryFn: () => api.request<AssayerApplicationRow[]>(`/hr/applications?status=${status}`),
  });
  const rows = applicationsQuery.data ?? [];

  /**
   * Not always a success: a resend can generate a fresh link and still fail to deliver it, and
   * that outcome has to reach the operator rather than be reported as done.
   */
  const handleActionSuccess = (n: { tone: 'ok' | 'err'; text: string }) => {
    setNotice(n);
    setSelectedId(null);
    void queryClient.invalidateQueries({ queryKey: queryKeys.hr.applicationsAll });
  };

  const columns: Column<AssayerApplicationRow>[] = [
    {
      key: 'candidate',
      header: 'Candidate',
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.fullName || r.mobile}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {r.mobile}{r.email ? ` · ${r.email}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (r) => <span>{r.employmentCategory ? humanizeStatus(r.employmentCategory) : '—'}</span>,
    },
    {
      key: 'experience',
      header: 'Experience',
      render: (r) => <span>{r.experienceYears != null ? `${r.experienceYears} yrs` : '—'}</span>,
    },
    {
      key: 'location',
      header: 'Location',
      render: (r) => <span>{[r.city, r.state].filter(Boolean).join(', ') || '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge domain="applicationStatus" status={r.status} />,
    },
    {
      // `createdAt` is when the invite was raised, which is not the same as when it was submitted
      // — and on the "Not started" view nothing has been submitted at all.
      key: 'invited',
      header: 'Invited',
      render: (r) => <span>{fmtWhen(r.createdAt)}</span>,
    },
  ];

  const activeFilter = STATUS_FILTERS.find((f) => f.key === status)!;

  return (
    <div style={{ padding: '20px 24px', maxWidth: '1300px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <PageHeader
        icon={<FileCheck2 size={20} />}
        title="Applications"
        subtitle="Self-registration submissions awaiting HR action — a separate intake from the HR-desk registration wizard, which never produces one of these."
      />

      {notice && (
        <AlertBanner type={notice.tone === 'ok' ? 'success' : 'error'} onClose={() => setNotice(null)}>
          {notice.text}
        </AlertBanner>
      )}

      <ViewChips
        options={STATUS_FILTERS.map((f) => ({ key: f.key, label: f.label, hint: f.hint }))}
        value={status}
        onChange={setStatus}
      />

      {loadFailed(applicationsQuery) ? (
        <LoadFailure loads={[{ label: 'the applications queue', query: applicationsQuery }]} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => setSelectedId(r.id)}
          loading={applicationsQuery.isLoading}
          loadingRows={6}
          emptyState={
            <EmptyState
              meaning="NO_DATA"
              title={`Nothing ${activeFilter.label.toLowerCase()}`}
              message={activeFilter.hint}
            />
          }
        />
      )}

      {selectedId && (
        <ApplicationDetailDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onSuccess={handleActionSuccess}
        />
      )}
    </div>
  );
};

export default HrApplicationsPage;
