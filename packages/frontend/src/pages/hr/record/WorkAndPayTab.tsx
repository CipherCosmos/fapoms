import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  AssayerPayableStatus, AssignmentStatus, assignmentStatusLabel, describeAssignmentFee,
  formatRupees as money, payableStatusLabel,
} from '@fapoms/shared';

import { api } from '../../../services/api';
import { classifyError } from '../../../services/errors';
import { loadFailed } from '../../../queryClient';
import { queryKeys } from '../../../hooks/queryKeys';
import { useAssayerStatement } from '../../../hooks/useBilling';
import type { AssayerStatement } from '../../../services/billing';
import { LoadFailure } from '../../../components/LoadFailure';
import { SkeletonList } from '../../../components/ui';
import { fmtDate } from '../../../utils/dates';
import {
  StatementTotals, StatementPayments, AssayerInvoicesSection, SimpleTable, Stat, card, label,
} from '../../billing/AssayerStatementSections';
import { BILL, PAY_WORDS, payoutStageOf } from '../../billing/vocabulary';
import { statusBadgeStyle } from './CurrentAssignmentsCard';

/**
 * "Work & pay" — everything this person has done for us and what they were paid for it, on
 * their own record.
 *
 * The owner's complaint that produced it: opening one assayer showed who they are and whether
 * they may work, but not their work — what is booked, what they finished, and what each finished
 * job paid them. Those three answers already had endpoints; they were each on a different screen
 * (the assignments desk, the field app, the finance statement). This tab reads the same three and
 * joins them on the one key they share, the assignment.
 *
 * The money half is a billing read, which not every HR role holds. A refusal there is said once,
 * quietly, and the money columns go — never replaced by ₹0, which would read as "worked for free"
 * (see `money-refusal-is-not-zero.spec.tsx`).
 */

/** The statuses that mean the job is still ahead of them or under way. */
const IN_FLIGHT: readonly string[] = [
  AssignmentStatus.PENDING, AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS,
];

/** One page of finished work per "Show more"; the server's own default page. */
export const HISTORY_PAGE = 50;

/** The fields of `GET /assignments/assayer/:id` rows this tab reads. */
export interface AssayerWorkItem {
  id: string;
  assignmentNumber: string;
  status: string;
  scheduledDate?: string | null;
  completionDate?: string | null;
  proposedFee?: number | string | null;
  agreedFee?: number | string | null;
  projectBranch?: { branch?: { name?: string | null; city?: string | null } | null } | null;
  project?: { name?: string | null } | null;
}

/** The endpoint answers `{ success, items, meta }` — no `data` key, so `api.request` leaves it whole. */
interface WorkPage {
  items: AssayerWorkItem[];
  meta?: { hasMore?: boolean; nextCursor?: string | null };
}

type Payable = AssayerStatement['payables'][number];

/** What one assignment has earned them, summed over its payouts (the fee and any reimbursement). */
export interface AssignmentPay {
  earned: number | null;
  paid: number | null;
  owed: number | null;
  stage: string;
}

/**
 * The payouts for one assignment, read as one line.
 *
 * An assignment can carry more than one payout — the fee, plus a reimbursement per approved
 * expense claim — so the money is their sum. A VOIDED payout is money that will never be paid and
 * is left out of the sum. The stage is the fee's: that is the one the clerk is asked about.
 */
export function payForAssignment(payables: Payable[]): AssignmentPay | null {
  if (payables.length === 0) return null;
  const live = payables.filter((p) => p.status !== AssayerPayableStatus.VOIDED);
  const lead = live.find((p) => !p.expenseId) ?? live[0] ?? payables[0];
  const stage = payoutStageOf({ status: lead.status, onHold: lead.onHold, onBill: lead.invoiceNumber != null });
  const stageText = !stage
    ? payableStatusLabel(lead.status)
    : stage.key === 'HELD' && lead.holdReason
      ? `${stage.label}: ${lead.holdReason}`
      : stage.label;
  const sum = (pick: (p: Payable) => number) => (live.length ? live.reduce((s, p) => s + (Number(pick(p)) || 0), 0) : null);
  return {
    earned: sum((p) => p.totalAmount),
    paid: sum((p) => p.paidAmount),
    owed: sum((p) => p.outstanding),
    stage: stageText,
  };
}

const workUrl = (assayerId: string, scope: 'active' | 'history', before?: string | null) =>
  `/assignments/assayer/${assayerId}?scope=${scope}${scope === 'history' ? `&limit=${HISTORY_PAGE}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`;

const branchCell = (a: AssayerWorkItem) => {
  const b = a.projectBranch?.branch;
  if (!b?.name) return <span style={{ color: 'var(--text-muted)' }}>Not recorded</span>;
  return (
    <span>
      {b.name}
      {b.city && <span style={{ color: 'var(--text-muted)' }}> · {b.city}</span>}
    </span>
  );
};

const assignmentLink = (a: AssayerWorkItem) => (
  <Link to={`/assignments?id=${encodeURIComponent(a.id)}`} style={{ color: 'var(--accent-primary)', textDecoration: 'none', fontWeight: 600 }}>
    {a.assignmentNumber || a.id.slice(0, 8)}
  </Link>
);

const statusPill = (status: string) => (
  <span style={{ fontSize: 'var(--text-2xs)', fontWeight: 600, padding: '2px 8px', borderRadius: '999px', ...statusBadgeStyle(status) }}>
    {assignmentStatusLabel(status)}
  </span>
);

const quiet: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--text-muted)' };

const Section: React.FC<{ title: string; children: React.ReactNode; testId: string }> = ({ title, children, testId }) => (
  <section data-testid={testId} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <h3 style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</h3>
    {children}
  </section>
);

export const WorkAndPayTab: React.FC<{ assayerId: string }> = ({ assayerId }) => {
  const active = useQuery({
    queryKey: queryKeys.assignments.byAssayer(assayerId, 'active'),
    queryFn: () => api.request<WorkPage>(workUrl(assayerId, 'active')),
  });

  const history = useInfiniteQuery({
    queryKey: queryKeys.assignments.byAssayer(assayerId, 'history'),
    queryFn: ({ pageParam }) => api.request<WorkPage>(workUrl(assayerId, 'history', pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last?.meta?.hasMore && last.meta.nextCursor ? last.meta.nextCursor : undefined),
  });

  const statement = useAssayerStatement(assayerId);
  const statementFailed = loadFailed(statement);
  const refused = statementFailed
    && classifyError(statement.error ?? statement.failureReason).category === 'permission-required';
  const pay = statement.data && !statementFailed ? statement.data : null;

  const payablesByAssignment = useMemo(() => {
    const byId = new Map<string, Payable[]>();
    for (const p of pay?.payables ?? []) {
      const list = byId.get(p.assignmentId) ?? [];
      list.push(p);
      byId.set(p.assignmentId, list);
    }
    return byId;
  }, [pay]);

  // `scope=active` also carries work settled in the last few weeks — that belongs below.
  const inFlight = useMemo(() => {
    const rows = (active.data?.items ?? []).filter((a) => IN_FLIGHT.includes(a.status));
    // Soonest first; a job with no date yet goes last rather than first.
    return [...rows].sort((x, y) => String(x.scheduledDate ?? '9999').localeCompare(String(y.scheduledDate ?? '9999')));
  }, [active.data]);

  const finished = useMemo(() => (history.data?.pages ?? []).flatMap((p) => p?.items ?? []), [history.data]);
  const completedCount = finished.filter((a) => a.status === AssignmentStatus.COMPLETED).length;

  const activeFailed = loadFailed(active);
  const historyFailed = loadFailed(history);

  const completedTile = history.data
    ? `${completedCount}${history.hasNextPage ? '+' : ''}`
    : historyFailed ? '—' : '…';
  const inFlightTile = active.data && !activeFailed ? String(inFlight.length) : activeFailed ? '—' : '…';

  /** Money columns: shown with the pay, dropped (not zeroed) when the pay could not be read. */
  const showPay = !statementFailed;
  const payCells = (a: AssayerWorkItem): React.ReactNode[] => {
    if (!pay) return ['…', '…', '…', '…'];
    const line = payForAssignment(payablesByAssignment.get(a.id) ?? []);
    if (!line) {
      return a.status === AssignmentStatus.COMPLETED
        ? ['—', '—', '—', <span key="nb" style={{ color: 'var(--warning)' }}>Not billed yet</span>]
        : ['—', '—', '—', '—'];
    }
    const fig = (n: number | null) => (n === null ? '—' : money(n));
    return [fig(line.earned), fig(line.paid), fig(line.owed), line.stage];
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* D. The glance. Money tiles appear only when the money could be read. */}
      <div data-testid="work-headline" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="Completed" value={completedTile} />
        <Stat label="In progress" value={inFlightTile} />
        {!statementFailed && (
          <>
            <Stat label={PAY_WORDS.earned} value={pay ? money(pay.totals.earned) : '…'} tone="var(--accent)" />
            <Stat
              label={PAY_WORDS.owed}
              value={pay ? money(pay.totals.outstanding) : '…'}
              tone={pay && pay.totals.outstanding > 0 ? 'var(--warning)' : 'var(--text-muted)'}
            />
          </>
        )}
      </div>

      {/* A. Coming up and in progress */}
      <Section title="Coming up and in progress" testId="work-in-flight">
        {activeFailed ? (
          <LoadFailure loads={[{ label: 'their current work', query: active }]} />
        ) : active.isPending ? (
          <SkeletonList rows={2} height={32} />
        ) : inFlight.length === 0 ? (
          <div style={quiet}>Nothing is booked for them right now.</div>
        ) : (
          <SimpleTable
            leftColumns={5}
            head={['Date', 'Assignment', 'Branch', 'Project', 'Status', 'Fee']}
            rows={inFlight.map((a) => [
              fmtDate(a.scheduledDate),
              assignmentLink(a),
              branchCell(a),
              a.project?.name ?? '—',
              statusPill(a.status),
              describeAssignmentFee(a).text.total,
            ])}
          />
        )}
      </Section>

      {/* B. Completed work, with what each job paid */}
      <Section title="Completed work" testId="work-history">
        {refused && <div style={quiet}>Pay details need billing access.</div>}
        {statementFailed && !refused && (
          <LoadFailure loads={[{ label: 'their pay for this work', query: statement }]} />
        )}
        {historyFailed && <LoadFailure loads={[{ label: 'their finished work', query: history }]} />}
        {history.isPending && !historyFailed ? (
          <SkeletonList rows={3} height={32} />
        ) : finished.length === 0 ? (
          !historyFailed && <div style={quiet}>They have not finished any work yet.</div>
        ) : (
          <SimpleTable
            leftColumns={5}
            head={['Date', 'Assignment', 'Branch', 'Project', 'Status', 'Fee',
              ...(showPay ? [PAY_WORDS.earned, PAY_WORDS.paid, PAY_WORDS.owed, 'Payout stage'] : [])]}
            rows={finished.map((a) => [
              fmtDate(a.completionDate ?? a.scheduledDate),
              assignmentLink(a),
              branchCell(a),
              a.project?.name ?? '—',
              assignmentStatusLabel(a.status),
              describeAssignmentFee(a).text.total,
              ...(showPay ? payCells(a) : []),
            ])}
          />
        )}
        {history.hasNextPage && (
          <div>
            <button
              type="button"
              onClick={() => { void history.fetchNextPage(); }}
              disabled={history.isFetchingNextPage}
              style={{
                padding: '6px 14px', fontSize: 'var(--text-xs)', fontWeight: 600, cursor: 'pointer',
                background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
                border: '1px solid var(--border-color)', borderRadius: 8,
              }}
            >
              {history.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </button>
          </div>
        )}
      </Section>

      {/* C. Money — the finance statement's own parts. Hidden when the statement is not theirs to read. */}
      {pay && (
        <section data-testid="work-money" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <div style={label}>Money</div>
            <Link to={`/billing/statement?assayer=${encodeURIComponent(assayerId)}`} style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-primary)', textDecoration: 'none' }}>
              Open full statement →
            </Link>
          </div>
          <StatementTotals data={pay} />
          <StatementPayments data={pay} />
          <AssayerInvoicesSection assayerId={assayerId} title={BILL.CapMany} />
          {pay.payments.length === 0 && (
            <div style={{ ...card, ...quiet }}>No payments have been made to them yet.</div>
          )}
        </section>
      )}
      {!pay && !statementFailed && statement.isLoading && <SkeletonList rows={2} height={48} />}
    </div>
  );
};
