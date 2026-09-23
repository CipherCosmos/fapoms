import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CHECK_TYPE_LABELS, RECHECK_STATUS_LABELS, type CheckType, type ComplianceHold, type RecheckStanding, type RecheckStatus,
} from '@fapoms/shared';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { queryKeys } from '../../hooks/queryKeys';
import { Page } from '../../components/ui/Page';
import { DataTable, type Column } from '../../components/ui/DataTable';

/** One person, as `GET /assayers/rechecks/attention` gives them. */
interface AttentionPerson {
  assayerId: string;
  displayName: string;
  assayerCode: string | null;
  standings: RecheckStanding[];
  hold: ComplianceHold | null;
}

type Filter = 'all' | 'held' | 'BLOCKED' | 'DUE' | 'DUE_SOON';

/** One row: a person and one check that needs attention, or their hold. */
interface Row {
  key: string;
  assayerId: string;
  name: string;
  code: string | null;
  check: string;
  status: 'HELD' | RecheckStatus;
  dueOn: string | null;
  blockFrom: string | null;
  lastCheckedOn: string | null;
  because: string | null;
}

const TONE: Record<Row['status'], { fg: string; bg: string; label: string }> = {
  HELD: { fg: 'var(--danger)', bg: 'var(--status-cancelled-bg)', label: 'Adverse — awaiting a decision' },
  BLOCKED: { fg: 'var(--danger)', bg: 'var(--status-cancelled-bg)', label: RECHECK_STATUS_LABELS.BLOCKED },
  DUE: { fg: 'var(--warning)', bg: 'var(--status-pending-bg)', label: RECHECK_STATUS_LABELS.DUE },
  DUE_SOON: { fg: 'var(--accent)', bg: 'var(--bg-surface-2)', label: RECHECK_STATUS_LABELS.DUE_SOON },
  OK: { fg: 'var(--success)', bg: 'var(--status-active-bg)', label: RECHECK_STATUS_LABELS.OK },
};
const ORDER: Record<Row['status'], number> = { HELD: 0, BLOCKED: 1, DUE: 2, DUE_SOON: 3, OK: 4 };

/**
 * RE-CHECKS OVER TIME — HR's list of who needs one (owner, 2026-09-23).
 *
 * Working assayers are re-checked on a schedule set in Settings (background, police, credit,
 * identity documents). This is everybody whose check is due soon, due, or overdue past the grace
 * period — held from new work — and everybody held by an adverse re-check waiting for a senior.
 * Each row opens the person's Background tab, where the check is recorded or decided.
 */
export const HrRechecksPage: React.FC = () => {
  const [filter, setFilter] = useState<Filter>('all');
  const query = useQuery({
    queryKey: queryKeys.hr.rechecks,
    queryFn: () => api.request<AttentionPerson[]>('/assayers/rechecks/attention'),
  });

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of query.data ?? []) {
      if (p.hold) {
        out.push({
          key: `${p.assayerId}:hold`, assayerId: p.assayerId, name: p.displayName, code: p.assayerCode,
          check: CHECK_TYPE_LABELS[p.hold.checkType as CheckType], status: 'HELD', dueOn: null, blockFrom: null,
          lastCheckedOn: p.hold.since, because: null,
        });
      }
      for (const s of p.standings) {
        if (s.status === 'OK') continue;
        out.push({
          key: `${p.assayerId}:${s.type}`, assayerId: p.assayerId, name: p.displayName, code: p.assayerCode,
          check: CHECK_TYPE_LABELS[s.type], status: s.status, dueOn: s.dueOn, blockFrom: s.blockFrom,
          lastCheckedOn: s.lastCheckedOn, because: s.because,
        });
      }
    }
    return out.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.dueOn ?? '').localeCompare(b.dueOn ?? ''));
  }, [query.data]);

  const counts = useMemo(() => ({
    all: rows.length,
    held: rows.filter((r) => r.status === 'HELD').length,
    BLOCKED: rows.filter((r) => r.status === 'BLOCKED').length,
    DUE: rows.filter((r) => r.status === 'DUE').length,
    DUE_SOON: rows.filter((r) => r.status === 'DUE_SOON').length,
  }), [rows]);

  const visible = rows.filter((r) => filter === 'all' || (filter === 'held' ? r.status === 'HELD' : r.status === filter));

  const columns: Column<Row>[] = [
    {
      key: 'person', header: 'Person',
      render: (r) => (
        <Link to={`/hr/roster/${r.assayerId}?section=background`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
          {r.name}{r.code ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {r.code}</span> : null}
        </Link>
      ),
    },
    { key: 'check', header: 'Check', render: (r) => <>{r.check}</> },
    {
      key: 'status', header: 'Where it stands',
      render: (r) => (
        <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: 'var(--text-2xs)', fontWeight: 700, color: TONE[r.status].fg, background: TONE[r.status].bg }}>
          {TONE[r.status].label}
        </span>
      ),
    },
    {
      key: 'due', header: 'Due',
      render: (r) => (r.status === 'HELD'
        ? <>Held since {r.lastCheckedOn}</>
        : <>{r.dueOn}{r.status !== 'BLOCKED' && r.blockFrom ? <span style={{ color: 'var(--text-muted)' }}> · held from {r.blockFrom}</span> : null}</>),
    },
    {
      key: 'last', header: 'Last done',
      render: (r) => (r.status === 'HELD' ? <>—</> : <>{r.lastCheckedOn ?? (r.because ?? 'Never')}</>),
    },
  ];

  const chip = (key: Filter, label: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={filter === key}
      onClick={() => setFilter(key)}
      style={{
        padding: '4px 10px', fontSize: 'var(--text-xs)', fontWeight: 600, borderRadius: '999px', cursor: 'pointer',
        border: `1px solid ${filter === key ? 'var(--accent)' : 'var(--border-color)'}`,
        background: filter === key ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
        color: filter === key ? 'var(--accent)' : 'var(--text-secondary)',
      }}
    >
      {label} ({key === 'all' ? counts.all : counts[key]})
    </button>
  );

  return (
    <Page>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55, maxWidth: '760px' }}>
        Working appraisers are re-checked over time — background verification, police verification,
        credit and identity documents — on the schedule set in Settings. Anyone overdue past the grace
        period, or whose re-check came back adverse, is held from new work until it is recorded or
        decided. Open a person to record the check on their Background tab.
      </p>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {chip('all', 'All')}
        {chip('held', 'Adverse, awaiting a decision')}
        {chip('BLOCKED', 'Held from new work')}
        {chip('DUE', 'Due now')}
        {chip('DUE_SOON', 'Due soon')}
      </div>
      {query.isError ? (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
          The re-checks list could not be loaded. {userMessage(query.error)}
        </div>
      ) : query.isLoading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
          {rows.length === 0 ? 'Nobody’s re-checks need attention right now.' : 'Nothing in this group.'}
        </div>
      ) : (
        <DataTable density="compact" rows={visible} rowKey={(r) => r.key} columns={columns} />
      )}
    </Page>
  );
};

export default HrRechecksPage;
