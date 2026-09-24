import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Hourglass } from 'lucide-react';
import { AssayerInvoiceStatus, InvoiceStatus, SystemRole } from '@fapoms/shared';
import { useBillingOverview, useAssayerInvoices, useBillingInvoices, useInvoiceable } from '../../hooks/useBilling';
import { queryKeys } from '../../hooks/queryKeys';
import { hasAnyRole, useCurrentRoles } from '../../hooks/useCurrentRoles';
import { getPendingExpenses } from '../../services/expenses';
import { moneyTotal as money } from '../../utils/money';
import { LoadFailure, type MonitoredLoad } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { Card, Empty } from './shared';
import { AttentionList, MoneyPosition } from './MoneyPosition';
import type { BillingJob, PayoutStage } from './vocabulary';

/**
 * To do — the whole billing desk's day, as a numbered list, in the order the work has to happen.
 *
 * The screen this replaces opened on four big totals and hid the day's work in a card below
 * them, and its top action card was wrong in a way that cost real time: it read "39 payouts to
 * approve · ₹56,100" and its button went to the list of *submitted assayer bills*, which on the
 * live book had nothing in it. Two different populations, one link between them. A clerk pressed
 * the biggest number on the page and arrived at an empty table.
 *
 * So every row here obeys one rule: **the number, the sentence and the destination are the same
 * rows.** If a row says seven, pressing it lands on those seven. Where that cannot be promised —
 * a count that failed to load — the row says so and offers nothing to press, because a money
 * screen that draws a refusal as "nothing to do" is the defect `money-refusal-is-not-zero.spec`
 * exists to prevent.
 *
 * The order is the dependency order, and it is the reason this is a numbered list rather than a
 * dashboard: a claim has to be approved before it is a payout, a payout has to be billed and
 * approved before it can be paid, and work has to be invoiced before a client can pay for it.
 * Someone new to the desk can work down it.
 */
export const TodoTab: React.FC<{
  onGo: (job: BillingJob, opts?: { stage?: PayoutStage; bills?: string; invoices?: string }) => void;
}> = ({ onGo }) => {
  const overview = useBillingOverview();

  /**
   * The four counts the overview does not carry, each read from the list it links to — so the
   * number on the row and the table behind it are the same query, not two that agree by luck.
   * `limit: 1` because only `total` is read; the page itself is fetched when the tab opens.
   */
  const submitted = useAssayerInvoices({ status: AssayerInvoiceStatus.SUBMITTED, page: 1, limit: 1 });
  const withAssayer = useAssayerInvoices({ status: AssayerInvoiceStatus.INVITED, page: 1, limit: 1 });
  const drafts = useBillingInvoices({ status: InvoiceStatus.DRAFT, page: 1, limit: 1 });
  const readyToSend = useBillingInvoices({ status: InvoiceStatus.HOD_APPROVED, page: 1, limit: 1 });
  const invoiceable = useInvoiceable();
  /**
   * Only the roles the server lets review claims (ADMIN, OPERATIONS) ask for them. An auditor or a
   * custom billing role (a custom HOD role, say) was sent the same request, got a 403, and saw
   * "could not load the expense claims" on the tab billing opens on.
   */
  const canReviewClaims = hasAnyRole(useCurrentRoles(), [SystemRole.ADMIN, SystemRole.OPERATIONS]);
  const claims = useQuery({
    queryKey: queryKeys.billing.pendingExpenses(),
    queryFn: getPendingExpenses,
    staleTime: 30_000,
    enabled: canReviewClaims,
  });

  const data = overview.data;
  if (overview.isLoading) return <Empty>Loading the book…</Empty>;
  if (!data) return <LoadFailure loads={[{ label: 'the finance overview', query: overview }]} />;

  const { payouts, receivables } = data;
  const overdue = receivables.aging.d1_30 + receivables.aging.d31_60 + receivables.aging.d61_90 + receivables.aging.d90_plus;
  const claimTotal = (claims.data ?? []).reduce((s, c) => s + Number(c.amount ?? 0), 0);

  /**
   * `unbilled` / `inClaimReview` are optional on `BillingOverview` — an older backend does not
   * send them. Without them the two piles inside "due" cannot be told apart, so the rows that
   * depend on the split are suppressed rather than guessed at, and the undivided total is shown
   * on the pay row instead. Nothing here ever invents a number it was not given.
   */
  const splitKnown = payouts.unbilled !== undefined && payouts.inClaimReview !== undefined;

  const steps: Step[] = [
    {
      key: 'claims',
      show: canReviewClaims && !loadFailed(claims) && (claims.data?.length ?? 0) > 0,
      failed: canReviewClaims && loadFailed(claims),
      failLabel: 'the expense claims waiting for review',
      failQuery: claims,
      title: `${claims.data?.length ?? 0} expense ${claims.data?.length === 1 ? 'claim' : 'claims'} to approve`,
      amount: claimTotal,
      why: 'Approving a claim books it as a payout in the same step, so an unreviewed claim is money the assayer cannot be paid yet.',
      cta: 'Review claims',
      go: () => onGo('expenses'),
      tone: 'var(--warning)',
    },
    {
      key: 'not-billed',
      show: splitKnown && (payouts.unbilledCount ?? 0) > 0,
      title: `${payouts.unbilledCount} completed ${payouts.unbilledCount === 1 ? 'job has' : 'jobs have'} not been billed`,
      amount: payouts.unbilled ?? 0,
      why: 'Nobody has asked these assayers to confirm their fees, so they have not seen this money. Send the bills.',
      cta: 'Send bills',
      go: () => onGo('bills'),
      tone: 'var(--accent)',
    },
    {
      key: 'bills-to-approve',
      show: !loadFailed(submitted) && (submitted.data?.total ?? 0) > 0,
      failed: loadFailed(submitted),
      failLabel: 'the assayer bills waiting for your approval',
      failQuery: submitted,
      title: `${submitted.data?.total} assayer ${submitted.data?.total === 1 ? 'bill' : 'bills'} confirmed, waiting for you`,
      why: 'The assayer has agreed the amounts. Approving the bill approves every payout on it in one go.',
      cta: 'Approve bills',
      go: () => onGo('bills', { bills: AssayerInvoiceStatus.SUBMITTED }),
      tone: 'var(--accent)',
    },
    {
      /*
        Ready to pay = approved by the office AND the HOD (2026-09-24). What is still with the HOD is
        not this desk's move, so it is its own line, and says so.
      */
      key: 'with-hod',
      show: (payouts.awaitingHodCount ?? 0) > 0,
      title: `${payouts.awaitingHodCount} ${payouts.awaitingHodCount === 1 ? 'payout is' : 'payouts are'} waiting for HOD approval`,
      amount: payouts.awaitingHod ?? 0,
      why: "Approved by the office. They cannot be paid until the HOD gives the final approval.",
      cta: 'See them',
      go: () => onGo('pay', { stage: 'AWAITING_HOD' }),
      tone: 'var(--text-muted)',
    },
    {
      key: 'to-pay',
      show: payouts.approvedCount - (payouts.awaitingHodCount ?? 0) > 0,
      title: `${payouts.approvedCount - (payouts.awaitingHodCount ?? 0)} ${payouts.approvedCount - (payouts.awaitingHodCount ?? 0) === 1 ? 'payout is' : 'payouts are'} ready to pay`,
      amount: payouts.approved - (payouts.awaitingHod ?? 0),
      why: 'Approved by the office and the HOD. Download the bank file, pay it, then come back and record the payment.',
      cta: 'Pay assayers',
      go: () => onGo('pay', { stage: 'TO_PAY' }),
      tone: 'var(--accent)',
    },
    {
      key: 'to-invoice',
      show: !loadFailed(invoiceable) && receivables.unbilled > 0,
      failed: loadFailed(invoiceable),
      failLabel: 'the work waiting to be invoiced',
      failQuery: invoiceable,
      title: invoiceable.data
        ? `${invoiceable.data.clients.length} ${invoiceable.data.clients.length === 1 ? 'client has' : 'clients have'} work to invoice`
        : 'Completed work to invoice',
      amount: receivables.unbilled,
      why: 'Delivered but not on any invoice, so no client has been asked to pay for it yet.',
      cta: 'Create invoices',
      go: () => onGo('invoices'),
      tone: 'var(--accent)',
    },
    {
      key: 'drafts',
      show: !loadFailed(drafts) && (drafts.data?.total ?? 0) > 0,
      failed: loadFailed(drafts),
      failLabel: 'the draft invoices',
      failQuery: drafts,
      title: `${drafts.data?.total} ${drafts.data?.total === 1 ? 'invoice is' : 'invoices are'} drafted but not sent`,
      why: "A draft is not owed by anybody. Send it for the HOD's final approval; once approved it can go to the client.",
      cta: 'Send invoices',
      go: () => onGo('invoices', { invoices: InvoiceStatus.DRAFT }),
      tone: 'var(--warning)',
    },
    {
      // Approved by the HOD but not yet marked sent. Until it is sent it is not owed by anybody,
      // and nothing else on this list would mention it.
      key: 'readyToSend',
      show: !loadFailed(readyToSend) && (readyToSend.data?.total ?? 0) > 0,
      failed: loadFailed(readyToSend),
      failLabel: 'the invoices ready to send',
      failQuery: readyToSend,
      title: `${readyToSend.data?.total} ${readyToSend.data?.total === 1 ? 'invoice is' : 'invoices are'} approved by the HOD and ready to send`,
      why: 'The HOD has given the final approval. Send each to the client and mark it sent — only then is it owed.',
      cta: 'Send to clients',
      go: () => onGo('invoices', { invoices: InvoiceStatus.HOD_APPROVED }),
      tone: 'var(--accent)',
    },
    {
      key: 'overdue',
      show: overdue > 0,
      title: 'Overdue from clients',
      amount: overdue,
      why: 'Past the due date their payment terms set. Chase collection.',
      cta: 'See invoices',
      go: () => onGo('invoices', { invoices: InvoiceStatus.ISSUED }),
      tone: 'var(--danger)',
    },
    {
      key: 'held',
      show: payouts.held > 0 || receivables.held > 0,
      title: `${payouts.heldCount} ${payouts.heldCount === 1 ? 'payout' : 'payouts'} on hold`,
      amount: payouts.held + receivables.held,
      why: 'Stopped on purpose, and stuck until somebody releases the hold or fixes what caused it.',
      cta: 'See held',
      go: () => onGo('pay', { stage: 'HELD' }),
      tone: 'var(--danger)',
    },
  ];

  const live = steps.filter((s) => s.show || s.failed);
  const waitingOnAssayers = splitKnown && (payouts.inClaimReviewCount ?? 0) > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={14} /> What to do, in order</span>}>
        {live.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', background: 'var(--status-active-bg)', border: '1px solid var(--success)', borderRadius: 'var(--radius-md)', color: 'var(--success)', fontSize: 'var(--text-xs)' }}>
            <CheckCircle2 size={16} /> Nothing is waiting on you. Everything completed is billed, approved, paid and invoiced.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {live.map((s, i) => <StepRow key={s.key} step={s} n={i + 1} />)}
          </div>
        )}

        {/*
          Work that is genuinely somebody else's move.

          It used to be counted into the desk's own "payouts to approve" total, which is how a
          card offering 39 approvals included 20 the server refuses to approve — they are on a
          bill an assayer has not confirmed, and `approveOne` throws for exactly that. Saying so
          is more useful than hiding it: the desk's move is to chase the assayer, not to press
          Approve and read a refusal.
        */}
        {waitingOnAssayers && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--border-color)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              <Hourglass size={14} style={{ color: 'var(--text-muted)' }} />
              <span>
                <strong style={{ color: 'var(--text-primary)' }}>{payouts.inClaimReviewCount} {payouts.inClaimReviewCount === 1 ? 'payout' : 'payouts'}</strong>
                {' '}({money(payouts.inClaimReview ?? 0)})
                {withAssayer.data?.total ? ` on ${withAssayer.data.total} ${withAssayer.data.total === 1 ? 'bill' : 'bills'}` : ''}
                {' '}are with assayers, waiting to be confirmed. Nothing for you to do until they come back.
              </span>
              <button
                onClick={() => onGo('pay', { stage: 'WITH_ASSAYER' })}
                style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 'var(--text-2xs)', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                See them →
              </button>
            </div>
          </div>
        )}
      </Card>

      {data.attention.length > 0 && (
        <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={14} style={{ color: 'var(--warning)' }} /> Needs a decision ({data.attention.length})</span>}>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginBottom: 8 }}>
            Not a queue — these are worked out one at a time, and each disappears from here when its cause is fixed.
          </div>
          <AttentionList items={data.attention} />
        </Card>
      )}

      <MoneyPosition data={data} />
    </div>
  );
};

interface Step {
  key: string;
  show: boolean;
  /** A count that could not be read. The row states that instead of pretending it is zero. */
  failed?: boolean;
  failLabel?: string;
  failQuery?: MonitoredLoad['query'];
  title: string;
  amount?: number;
  why: string;
  cta: string;
  go: () => void;
  tone: string;
}

const StepRow: React.FC<{ step: Step; n: number }> = ({ step, n }) => {
  if (step.failed) {
    return (
      <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
        <LoadFailure loads={[{ label: step.failLabel ?? 'this count', query: step.failQuery! }]} />
      </div>
    );
  }
  return (
    <div style={{ background: 'var(--bg-primary)', border: `1px solid color-mix(in srgb, ${step.tone} 25%, transparent)`, borderLeft: `3px solid ${step.tone}`, borderRadius: 'var(--radius-sm)', padding: '10px 12px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <span style={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', background: `color-mix(in srgb, ${step.tone} 15%, transparent)`, color: step.tone, fontSize: 'var(--text-2xs)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>{n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <span style={{ color: 'var(--text-primary)', fontSize: 'var(--text-sm)', fontWeight: 700 }}>{step.title}</span>
          {step.amount !== undefined && (
            <span style={{ fontSize: 'var(--text-base)', fontWeight: 700, fontFamily: 'var(--font-display)', whiteSpace: 'nowrap' }}>{money(step.amount)}</span>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 3 }}>
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', lineHeight: 1.45 }}>{step.why}</span>
          <button onClick={step.go} className="btn btn-secondary" title={`Proceed to ${step.title.toLowerCase()}`} style={{ whiteSpace: 'nowrap', fontSize: 'var(--text-2xs)', padding: '4px 10px' }}>{step.cta} →</button>
        </div>
      </div>
    </div>
  );
};
