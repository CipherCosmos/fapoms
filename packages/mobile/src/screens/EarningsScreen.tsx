import React from 'react';
import { View } from 'react-native';
import { AssayerPayableStatus, formatRupees as money, formatDateOnly } from '@fapoms/shared';
import { AssayerAssignment, AssayerExpense, ExpenseSummary, AssayerStatement } from '../types/mobile-app';
import { getAssignmentTotalFee, hasResolvedFee } from '../utils/fees';
import { calendarDayDiff } from '../utils/dates';
import { CAT_LABELS } from '../components/ExpenseModal';
import { useTheme } from '../theme/ThemeProvider';
import {
  AppText, Badge, Button, Card, CollapsibleSection, Divider, EmptyState, FadeIn, GlowBlob, Icon, StatStrip, StatTile,
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

/**
 * A past date the way a person recalls it: "Today", "Yesterday", "5 days ago", then a plain
 * date once it is old enough that counting backwards stops helping. `relativeDay` is the
 * wrong tool here — it phrases past dates as "overdue", which reads as an accusation on a
 * payment that already happened.
 */
function pastDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = calendarDayDiff(iso);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff < 0 && diff >= -13) return `${Math.abs(diff)} days ago`;
  return formatDateOnly(iso, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The chip pattern used across the app: soft pill, 13px accent-toned icon, caption text. */
const MoneyChip: React.FC<{ icon: string; label: string; value: string; iconColor?: string }> = ({
  icon, label, value, iconColor,
}) => {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 6,
        backgroundColor: t.colors.surfaceAlt, borderWidth: 1, borderColor: t.colors.border,
        paddingHorizontal: 10, paddingVertical: 6, borderRadius: t.radius.pill,
      }}
    >
      <Icon name={icon} size={13} color={iconColor ?? t.colors.accent} />
      <AppText variant="caption" tone="muted">{label} </AppText>
      <AppText variant="caption">{value}</AppText>
    </View>
  );
};

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

  const payables = statement?.payables ?? [];
  const payments = statement?.payments ?? [];
  const hasAnyHistory = payables.length > 0 || payments.length > 0 || expenses.length > 0 || completed.length > 0;

  return (
    <View style={{ gap: t.space.xl }}>
      {/* ── Balance hero: the number this screen exists to answer ─────────────── */}
      <Card level={2} style={{ gap: t.space.md }}>
        {/* Soft violet/cyan bloom behind the figure. Absolutely positioned inside the
            card (which clips via overflow hidden) so it lights the number without
            touching layout or intercepting touches. */}
        <View pointerEvents="none" style={{ position: 'absolute', top: -90, right: -70 }}>
          <GlowBlob color={t.colors.primary} size={260} opacity={t.mode === 'dark' ? 0.055 : 0.05} />
        </View>
        <View pointerEvents="none" style={{ position: 'absolute', bottom: -110, left: -80 }}>
          <GlowBlob color={t.colors.accent} size={220} opacity={t.mode === 'dark' ? 0.05 : 0.04} />
        </View>

        <AppText variant="overline" tone="faint">BALANCE OWED TO YOU</AppText>
        <AppText variant="display" tone={owed > 0 ? 'accent' : 'muted'}>{money(owed)}</AppText>
        <AppText variant="caption" tone="muted">
          {owed > 0
            ? 'Owed to you across all completed work, after payments and TDS.'
            : 'You are fully settled — nothing outstanding right now.'}
        </AppText>

        <Divider spacing={2} />

        {/* Paid vs pending at a glance, in the app's chip pattern. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
          <MoneyChip icon="trending-up" label="Earned" value={money(lifetime)} />
          <MoneyChip icon="checkmark-circle" label="Paid" value={money(paid)} iconColor={t.colors.success} />
          <MoneyChip icon="hourglass-outline" label="Pending" value={money(awaiting)} iconColor={t.colors.warning} />
          {onHold > 0 && (
            <MoneyChip icon="pause-circle-outline" label="On hold" value={money(onHold)} iconColor={t.colors.danger} />
          )}
        </View>
      </Card>

      <StatStrip>
        <StatTile label="Expenses claimed" value={money(totalExpenses)} icon="receipt-outline" />
        <StatTile label="Audits completed" value={completed.length} icon="checkmark-done" tone="success" />
        {claimSummary != null && claimSummary.pending > 0 && (
          <StatTile
            label="Claims pending"
            value={money(claimSummary.pending)}
            icon="hourglass-outline"
            tone="warning"
            hint="awaiting desk approval"
          />
        )}
      </StatStrip>

      {/* Secondary action — the hero owns the screen's attention, so no glow here. */}
      <Button label="Log an expense" icon="add-circle-outline" variant="neutral" onPress={onOpenExpenseModal} full />

      {!hasAnyHistory && (
        <EmptyState
          icon="wallet-outline"
          title="No earnings activity yet"
          body="Complete your first audit and your fees, payables and payments will build up here."
        />
      )}

      {statement && (
        <CollapsibleSection title="Payables" defaultOpen>
          {payables.length === 0 ? (
            <EmptyState
              icon="document-text-outline"
              title="Nothing raised yet"
              body="A payable is raised for each validated audit — none are on your statement yet."
            />
          ) : (
            payables.slice(0, 8).map((p, i) => {
              const state = PAYABLE_STATE[p.status as AssayerPayableStatus]
                ?? { label: String(p.status), tone: 'neutral' as Tone };
              const amountTone: Tone = state.tone === 'success' ? 'success'
                : state.tone === 'danger' ? 'danger' : 'warning';
              return (
                <FadeIn key={p.id} delay={Math.min(i, 6) * 40}>
                  <Card level={1} style={{ gap: t.space.sm }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                      {/* Amount leads — it is what the row is about. */}
                      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                        <AppText variant="h3" tone={amountTone}>{money(p.totalAmount)}</AppText>
                        <AppText variant="caption" tone="faint" numberOfLines={1}>
                          {p.payableNumber} · {pastDay(p.createdAt)}
                        </AppText>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <Badge label={state.label} tone={state.tone} dot />
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
            })
          )}
        </CollapsibleSection>
      )}

      {payments.length > 0 && (
        <CollapsibleSection title="Payments received" summary="What has already been paid to you">
          {payments.slice(0, 8).map((pm, i) => (
            <FadeIn key={pm.id} delay={Math.min(i, 6) * 40}>
              <Card level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <AppText variant="bodyStrong" tone="success">{money(pm.amount)}</AppText>
                  <AppText variant="caption" tone="faint" numberOfLines={1}>
                    {pm.paymentReference} · {pm.method}
                  </AppText>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Badge label="Paid" tone="success" dot />
                  <AppText variant="caption" tone="muted">{pastDay(pm.paidDate)}</AppText>
                </View>
              </Card>
            </FadeIn>
          ))}
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Expense claims" defaultOpen>
        {expenses.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title="No claims yet"
            body="Log tolls, food and travel as you go — approved claims are reimbursed with your fees."
            action={<Button label="Log an expense" icon="add-circle-outline" variant="neutral" size="sm" onPress={onOpenExpenseModal} />}
          />
        ) : (
          expenses.slice(0, 10).map((exp, i) => (
            <FadeIn key={exp.id ?? i} delay={Math.min(i, 6) * 40}>
              <Card level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <AppText
                    variant="bodyStrong"
                    tone={CLAIM_TONE[exp.status] === 'success' ? 'success' : CLAIM_TONE[exp.status] === 'danger' ? 'danger' : 'default'}
                  >
                    {money(exp.amount)}
                  </AppText>
                  <AppText variant="caption" tone="faint" numberOfLines={1}>
                    {CAT_LABELS[exp.category as keyof typeof CAT_LABELS] ?? exp.category}
                    {exp.branchName ? ` · ${exp.branchName}` : ''}
                    {exp.createdAt ? ` · ${pastDay(exp.createdAt)}` : ''}
                  </AppText>
                </View>
                <Badge
                  label={CLAIM_LABEL[exp.status] ?? String(exp.status)}
                  tone={CLAIM_TONE[exp.status] ?? 'neutral'}
                />
              </Card>
            </FadeIn>
          ))
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Completed audits" summary="Your finished jobs">
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
                  {/* An assignment with no fee on it is unpriced, not free — say so rather
                      than rendering a zero or fabricated amount against someone's pay. */}
                  {hasResolvedFee(a)
                    ? <AppText variant="bodyStrong" tone="success">{money(getAssignmentTotalFee(a))}</AppText>
                    : <AppText variant="small" tone="muted">Fee not set</AppText>}
                  <AppText variant="caption" tone="faint" numberOfLines={1}>
                    {a.branchName} · {a.scheduledDate ? pastDay(a.scheduledDate) : '—'}
                  </AppText>
                </View>
                <Badge label="Completed" tone="success" dot />
              </Card>
            </FadeIn>
          ))
        )}
      </CollapsibleSection>
    </View>
  );
};
