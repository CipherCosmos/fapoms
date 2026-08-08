import React from 'react';
import { View } from 'react-native';
import { AssayerPayableStatus } from '@fapoms/shared';
import { AssayerAssignment, AssayerExpense, ExpenseSummary, AssayerStatement } from '../types/mobile-app';
import { getAssignmentTotalFee, hasResolvedFee } from '../utils/fees';
import { useTheme } from '../theme/ThemeProvider';
import {
  AppText, Badge, Button, Card, Divider, EmptyState, FadeIn, Section, StatStrip, StatTile,
} from '../components/ui/primitives';

interface EarningsScreenProps {
  totalEarnings: number;
  pendingEarnings: number;
  runningBalance?: number;
  earningsPaid?: number;
  earningsAwaitingApproval?: number;
  assignments: AssayerAssignment[];
  onOpenExpenseModal: () => void;
  /**
   * The assayer's full claim history from `/expenses/mine`.
   *
   * Falls back to the claims embedded in the loaded assignments when the request has not
   * resolved. Those only ever covered claims against currently-loaded assignments, so a
   * claim on an older audit was invisible — which is why the server-side list is preferred.
   */
  claims?: AssayerExpense[];
  claimSummary?: ExpenseSummary;
  /**
   * The billing engine's own statement. Replaces `billingEntries?: any[]`, which was never
   * passed, and the `qualityScore` / `queryResolutionRate` / `avgAuditHours` props, which had
   * no backing field on the assayer record or anywhere in the API.
   */
  statement?: AssayerStatement | null;
}

type Tone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * The five statuses a payable can actually hold, keyed off the shared enum so the app cannot
 * drift from the backend.
 *
 * The previous map invented fourteen: PENDING_BILLING, READY_FOR_BILLING, DRAFT, SUBMITTED,
 * UNDER_REVIEW, INVOICED, PARTIALLY_PAID, CANCELLED, ADJUSTED and REJECTED do not exist in
 * `AssayerPayableStatus`. Worse, the one status every seeded payable actually carries —
 * PENDING — was missing, so real rows fell through to a raw uppercase string with no tone.
 */
const PAYABLE_STATE: Record<AssayerPayableStatus, { label: string; tone: Tone }> = {
  [AssayerPayableStatus.PENDING]: { label: 'Awaiting approval', tone: 'warning' },
  [AssayerPayableStatus.APPROVED]: { label: 'Approved', tone: 'info' },
  [AssayerPayableStatus.PAID]: { label: 'Paid', tone: 'success' },
  [AssayerPayableStatus.ON_HOLD]: { label: 'On hold', tone: 'warning' },
  [AssayerPayableStatus.DISPUTED]: { label: 'Disputed', tone: 'danger' },
};

/** A rejected claim read as "pending" before — the same neutral grey as awaiting approval. */
const CLAIM_TONE: Record<string, Tone> = {
  APPROVED: 'success',
  PENDING: 'warning',
  REJECTED: 'danger',
};

const CLAIM_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  PENDING: 'Awaiting approval',
  REJECTED: 'Rejected',
};

const money = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/**
 * Money: what has been paid, what is still owed, and what each audit earned.
 *
 * The headline figure is now the balance actually owed rather than a lifetime
 * gross total, because that is the number a field assayer opens this screen to
 * check. Amounts come from the billing engine, so they match what finance sees.
 */
export const EarningsScreen: React.FC<EarningsScreenProps> = ({
  totalEarnings,
  pendingEarnings,
  runningBalance,
  earningsPaid,
  earningsAwaitingApproval,
  assignments,
  statement,
  onOpenExpenseModal,
  claims,
  claimSummary,
}) => {
  const t = useTheme();

  const expenses = claims?.length ? claims : assignments.flatMap((a) => a.expenses ?? []);
  const totalExpenses =
    claimSummary?.totalClaimed ?? expenses.reduce((s, e) => s + (e?.amount ?? 0), 0);
  /**
   * The billing engine's figures win when the statement has loaded.
   *
   * The profile fields kept as the fallback are a denormalised snapshot refreshed when the
   * profile is read; the statement is computed from the payables themselves, so it is the one
   * that agrees with what finance sees. Falling back rather than blanking keeps the screen
   * useful when the statement request fails.
   */
  const owed = statement?.totals.outstanding ?? runningBalance ?? pendingEarnings ?? 0;
  const paid = statement?.totals.paid ?? earningsPaid ?? 0;
  const awaiting = statement?.totals.awaitingApproval ?? earningsAwaitingApproval ?? 0;
  const lifetime = statement?.totals.earned ?? totalEarnings;
  const onHold = statement?.totals.onHoldOrDisputed ?? 0;

  const completed = assignments
    .filter((a) => a.status === 'COMPLETED')
    .slice()
    .sort((a, b) => new Date(b.scheduledDate ?? 0).getTime() - new Date(a.scheduledDate ?? 0).getTime());

  return (
    <View style={{ gap: t.space.xl }}>
      {/* The number this screen exists to answer */}
      <Card level={2} style={{ gap: t.space.md }}>
        <AppText variant="overline" tone="faint">BALANCE OWED TO YOU</AppText>
        <AppText variant="display" tone={owed > 0 ? 'accent' : 'muted'}>{money(owed)}</AppText>
        <Divider spacing={2} />
        <View style={{ flexDirection: 'row', gap: t.space.lg }}>
          <View style={{ flex: 1, gap: 3 }}>
            <AppText variant="overline" tone="faint">PAID</AppText>
            <AppText variant="h3" tone="success">{money(paid)}</AppText>
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <AppText variant="overline" tone="faint">AWAITING APPROVAL</AppText>
            <AppText variant="h3" tone={awaiting > 0 ? 'warning' : 'muted'}>{money(awaiting)}</AppText>
          </View>
        </View>
      </Card>

      <StatStrip>
        <StatTile label="Lifetime earned" value={money(lifetime)} icon="trending-up" tone="primary" />
        {onHold > 0 && (
          <StatTile
            label="On hold"
            value={money(onHold)}
            icon="pause-circle-outline"
            tone="warning"
            hint="disputed or held"
          />
        )}
        <StatTile label="Expenses claimed" value={money(totalExpenses)} icon="receipt-outline" />
        <StatTile label="Audits completed" value={completed.length} icon="checkmark-done" tone="success" />
      </StatStrip>

      <Button label="Log an expense" icon="add-circle-outline" variant="neutral" onPress={onOpenExpenseModal} full />

      {statement && statement.payables.length > 0 && (
        <Section title="Payables">
          {statement.payables.slice(0, 8).map((p, i) => {
            const state = PAYABLE_STATE[p.status as AssayerPayableStatus]
              ?? { label: String(p.status), tone: 'neutral' as Tone };
            return (
              <FadeIn key={p.id} delay={Math.min(i, 6) * 40}>
                <Card level={1} style={{ gap: t.space.sm }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                      <AppText variant="bodyStrong" numberOfLines={1}>{p.payableNumber}</AppText>
                      <View style={{ flexDirection: 'row' }}>
                        <Badge label={state.label} tone={state.tone} dot />
                      </View>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <AppText variant="h3">{money(p.totalAmount)}</AppText>
                      {p.outstanding > 0 && p.outstanding !== p.totalAmount && (
                        <AppText variant="caption" tone="muted">{money(p.outstanding)} outstanding</AppText>
                      )}
                    </View>
                  </View>
                  {/* The breakdown finance works from. Deriving a single fee off the
                      assignment could never show TDS or a part payment. */}
                  <Divider />
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <AppText variant="caption" tone="faint">Base {money(p.baseAmount)}</AppText>
                    <AppText variant="caption" tone="faint">Travel {money(p.travelAmount)}</AppText>
                    {p.tdsAmount > 0 && (
                      <AppText variant="caption" tone="faint">TDS -{money(p.tdsAmount)}</AppText>
                    )}
                  </View>
                </Card>
              </FadeIn>
            );
          })}
        </Section>
      )}

      {statement && statement.payments.length > 0 && (
        <Section title="Payments received">
          {statement.payments.slice(0, 8).map((pm, i) => (
            <FadeIn key={pm.id} delay={Math.min(i, 6) * 40}>
              <Card level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <AppText variant="bodyStrong" numberOfLines={1}>{pm.paymentReference}</AppText>
                  <AppText variant="caption" tone="faint">
                    {pm.method}
                    {pm.paidDate ? ` \u00b7 ${new Date(pm.paidDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                  </AppText>
                </View>
                <AppText variant="h3" tone="success">{money(pm.amount)}</AppText>
              </Card>
            </FadeIn>
          ))}
        </Section>
      )}

      {expenses.length > 0 && (
        <Section title="Expenses">
          {expenses.slice(0, 10).map((exp, i) => (
            <FadeIn key={exp.id ?? i} delay={Math.min(i, 6) * 40}>
              <Card level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <AppText variant="bodyStrong" numberOfLines={1}>{exp.description}</AppText>
                  <AppText variant="caption" tone="faint" numberOfLines={1}>
                    {exp.category}{exp.branchName ? ` · ${exp.branchName}` : ''}
                  </AppText>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <AppText variant="bodyStrong">{money(exp.amount)}</AppText>
                  <Badge
                    label={CLAIM_LABEL[exp.status] ?? String(exp.status)}
                    tone={CLAIM_TONE[exp.status] ?? 'neutral'}
                  />
                </View>
              </Card>
            </FadeIn>
          ))}
        </Section>
      )}

      <Section title="Completed audits">
        {completed.length === 0 ? (
          <EmptyState
            icon="wallet-outline"
            title="No earnings yet"
            body="Fees appear here once you complete your first audit and the desk validates it."
          />
        ) : (
          completed.slice(0, 15).map((a, i) => (
            <FadeIn key={a.id} delay={Math.min(i, 6) * 40}>
              <Card level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <AppText variant="bodyStrong" numberOfLines={1}>{a.branchName}</AppText>
                  <AppText variant="caption" tone="faint">
                    {a.scheduledDate
                      ? new Date(a.scheduledDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                      : '—'}
                  </AppText>
                </View>
                {/* An assignment with no fee on it is unpriced, not free — say so rather than
                    rendering a zero or fabricated amount against someone's pay. */}
                {hasResolvedFee(a)
                  ? <AppText variant="h3" tone="success">{money(getAssignmentTotalFee(a))}</AppText>
                  : <AppText variant="small" tone="muted">Fee not set</AppText>}
              </Card>
            </FadeIn>
          ))
        )}
      </Section>
    </View>
  );
};
