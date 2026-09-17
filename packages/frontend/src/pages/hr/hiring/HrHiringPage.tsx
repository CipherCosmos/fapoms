import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserPlus } from 'lucide-react';
import { ONBOARDING_STAGES, isOnboardingStage } from '@fapoms/shared';

import { api } from '../../../services/api';
import { queryKeys } from '../../../hooks/queryKeys';
import { loadFailed } from '../../../queryClient';
import { LoadFailure } from '../../../components/LoadFailure';
import { AlertBanner, DataTable, EmptyState, SearchInput } from '../../../components/ui';
import type { Column } from '../../../components/ui';
import { fetchWholeAssayerRoster } from '../../../services/assayer-roster';
import { canManageAssayers, useCurrentRoles } from '../../../hooks/useCurrentRoles';
import type { RosterPerson } from '../roster-filters';
import { ViewChips, fmtWhen } from '../hr-ui';
import { ApplicationDetailDrawer } from '../applications/ApplicationDetailDrawer';
import { OnboardingVerificationDrawer } from '../OnboardingVerificationDrawer';
import type { AssayerApplicationRow } from '../applications/application-types';
import {
  buildPipeline, daysWaiting, PIPELINE_STAGES,
  type ApplicationLike, type InterviewLike, type PipelineRow, type StageKey,
} from './pipeline';
import { AddCandidateDialog } from './AddCandidateDialog';
import { InterviewDetailDrawer } from './InterviewDetailDrawer';

/**
 * HIRING, AS ONE PIPELINE.
 *
 * Interviews, Applications and Onboarding were three tabs over one funnel: a pass opened an
 * application, an approval created the assayer record, and joining carried them to Active. Each tab
 * kept its own queue, its own chips and its own words for the same people — so "who needs me today"
 * took three visits, and the same candidate could appear in two of them under two different names
 * for the same state.
 *
 * One list now, built by `pipeline.ts` from the three sources the section already fetched. The
 * chips are the funnel; the row says where somebody is and what is needed next; opening anyone
 * shows the surface that matches where they are — the application review, or the joining workspace.
 */
export const HrHiringPage: React.FC = () => {
  const queryClient = useQueryClient();
  const canManage = canManageAssayers(useCurrentRoles());
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const stage = (params.get('stage') as StageKey | 'all' | null) ?? 'all';
  const setStage = (key: StageKey | 'all') => {
    const next = new URLSearchParams(params);
    if (key === 'all') next.delete('stage'); else next.set('stage', key);
    next.delete('id');
    setParams(next, { replace: true });
  };

  /** Which row is open. `?id=` survives a reload, and both kinds of row live in one parameter. */
  const openKey = params.get('id');
  const open = (row: PipelineRow | null) => {
    const next = new URLSearchParams(params);
    if (row) next.set('id', row.key); else next.delete('id');
    setParams(next, { replace: true });
  };

  const applicationsQuery = useQuery({
    queryKey: queryKeys.hr.applicationsAll,
    queryFn: () => api.request<(AssayerApplicationRow & ApplicationLike)[]>('/hr/applications'),
  });
  const onboardingCsv = useMemo(() => ONBOARDING_STAGES.join(','), []);
  const peopleQuery = useQuery({
    queryKey: queryKeys.hr.roster(`lifecycleStatus=${onboardingCsv}`),
    queryFn: ({ signal }) => fetchWholeAssayerRoster<RosterPerson>({ query: `lifecycleStatus=${onboardingCsv}`, signal }),
  });
  const interviewsQuery = useQuery({
    queryKey: queryKeys.hr.interviews,
    queryFn: () => api.request<InterviewLike[]>('/assayer-interviews'),
  });

  const rows = useMemo(() => buildPipeline({
    applications: applicationsQuery.data ?? [],
    people: (peopleQuery.data?.people ?? []).filter((p) => isOnboardingStage(p.lifecycleStatus)),
    interviews: interviewsQuery.data ?? [],
  }), [applicationsQuery.data, peopleQuery.data, interviewsQuery.data]);

  const counts = useMemo(() => {
    const map: Partial<Record<StageKey, number>> = {};
    for (const r of rows) map[r.stage] = (map[r.stage] ?? 0) + 1;
    return map;
  }, [rows]);

  const visible = useMemo(() => {
    const byStage = stage === 'all' ? rows : rows.filter((r) => r.stage === stage);
    const q = search.trim().toLowerCase();
    if (!q) return byStage;
    return byStage.filter((r) =>
      r.name.toLowerCase().includes(q)
      || (r.mobile ?? '').includes(q)
      || (r.email ?? '').toLowerCase().includes(q)
      || (r.assayerCode ?? '').toLowerCase().includes(q));
  }, [rows, stage, search]);

  const openRow = rows.find((r) => r.key === openKey) ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.hr.applicationsAll });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hr.rosterAll });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hr.interviews });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hr.workforce });
  };

  const columns: Column<PipelineRow>[] = [
    {
      key: 'candidate',
      header: 'Candidate',
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.name}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {[r.assayerCode, r.mobile, r.email].filter(Boolean).join(' · ') || '—'}
          </div>
          {r.note && (
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: '2px' }}>{r.note}</div>
          )}
        </div>
      ),
    },
    {
      key: 'stage',
      header: 'Where they are',
      render: (r) => {
        const tone = PIPELINE_STAGES.find((s) => s.key === r.stage);
        const alarming = tone?.tone === 'alert';
        return (
          <span style={{
            display: 'inline-flex', alignItems: 'center', fontSize: 'var(--text-xs)', fontWeight: 600,
            padding: '3px 9px', borderRadius: '999px',
            background: alarming ? 'var(--status-pending-bg)' : 'var(--bg-surface-2)',
            color: alarming ? 'var(--warning)' : 'var(--text-secondary)',
          }}>
            {r.stageLabel}
          </span>
        );
      },
    },
    {
      key: 'needs',
      header: 'What is needed',
      wrap: true,
      render: (r) => <span style={{ fontSize: 'var(--text-xs)' }}>{r.needs}</span>,
    },
    {
      key: 'waiting',
      header: 'Waiting',
      render: (r) => {
        const days = daysWaiting(r.since);
        if (days === null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
        return (
          <span title={r.since ? fmtWhen(r.since) : undefined} style={{ fontSize: 'var(--text-xs)', color: days >= 7 ? 'var(--warning)' : 'var(--text-secondary)' }}>
            {days === 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`}
          </span>
        );
      },
    },
  ];

  const anyFailed = loadFailed(applicationsQuery) || loadFailed(peopleQuery) || loadFailed(interviewsQuery);

  return (
    <>
      {notice && (
        <AlertBanner type={notice.tone === 'ok' ? 'success' : 'error'} message={notice.text} onClose={() => setNotice(null)} />
      )}

      {anyFailed && (
        <LoadFailure
          loads={[
            { label: 'the applications', query: applicationsQuery },
            { label: 'the people being onboarded', query: peopleQuery },
            { label: 'the interview log', query: interviewsQuery },
          ].filter((l) => loadFailed(l.query))}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', maxWidth: '340px' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name, code, mobile or email" flex />
        </div>
        {canManage && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', padding: '8px 14px' }}
          >
            <Plus size={14} /> Add candidate
          </button>
        )}
      </div>

      <ViewChips
        value={stage}
        onChange={setStage}
        options={[
          { key: 'all' as const, label: 'Everyone', hint: 'Everybody being hired, in the order they need attention', count: rows.length, tone: 'neutral' as const },
          ...PIPELINE_STAGES.map((s) => ({ key: s.key, label: s.label, hint: s.hint, count: counts[s.key] ?? 0, tone: s.tone })),
        ]}
      />

      {visible.length === 0 ? (
        <EmptyState
          icon={<UserPlus size={26} />}
          title={search ? 'Nobody matches that' : 'Nobody at this stage'}
          message={search
            ? `No candidate matching “${search}”.`
            : stage === 'all'
              ? 'Nobody is being hired at the moment. “Add candidate” starts somebody off.'
              : 'Everyone has moved past this stage — or nobody has reached it yet.'}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={visible}
          rowKey={(r) => r.key}
          onRowClick={(r) => open(r)}
        />
      )}

      {openRow?.kind === 'application' && (
        <ApplicationDetailDrawer
          id={openRow.id}
          onClose={() => open(null)}
          onSuccess={(n) => {
            setNotice({ tone: n.tone, text: n.text });
            open(null);
            refresh();
          }}
        />
      )}

      {openRow?.kind === 'assayer' && (
        <OnboardingVerificationDrawer
          candidateId={openRow.id}
          onClose={() => open(null)}
          onSuccess={refresh}
        />
      )}

      {/* The row kind that had no drawer: a click set `?id=` and opened nothing. */}
      {openRow?.kind === 'interview' && (() => {
        const interview = (interviewsQuery.data ?? []).find((i) => i.id === openRow.id);
        return interview ? <InterviewDetailDrawer interview={interview} onClose={() => open(null)} /> : null;
      })()}

      <AddCandidateDialog open={adding} onClose={() => setAdding(false)} onAdded={refresh} />
    </>
  );
};

export default HrHiringPage;
