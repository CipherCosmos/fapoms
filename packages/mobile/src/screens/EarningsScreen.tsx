import React from 'react';
import { View } from 'react-native';
import { AssayerPayableStatus, formatRupees as money, formatDateOnly } from '@fapoms/shared';
import { AssayerAssignment, AssayerExpense, ExpenseSummary, AssayerStatement } from '../types/mobile-app';

import { calendarDayDiff } from '../utils/dates';
import { CAT_LABEL_KEYS } from '../components/ExpenseModal';
import { useTheme } from '../theme/ThemeProvider';
import { useT, t as translate, type TranslationKey } from '../i18n';
import {
  AppText, Badge, Button, Card, CollapsibleSection, Divider, EmptyState, FadeIn, GlowBlob, Icon, StatStrip, StatTile,
} from '../components/ui/primitives';

interface EarningsScreenProps {
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
   * The assayer's statement — the ONE source for every figure on this screen.
   *
   * There used to be fallbacks: a profile snapshot, and a total this app summed from whatever
   * assignments happened to be loaded. Both could disagree with what finance will actually pay,
   * and a wrong number about someone's own pay is worse than no number. When the statement
   * cannot be read the screen says so and shows nothing.
   */
  statement?: AssayerStatement | null;
  /** True when the last statement read failed. */
  statementError?: boolean;
}

type Tone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * The three states a payout can hold, keyed off the shared enum so the app cannot drift from the
 * backend: due for approval, approved, paid. A hold is a flag on top of any of them, not a
 * fourth state — see the badge below.
 */
const PAYABLE_STATE: Record<AssayerPayableStatus, { labelKey: TranslationKey; tone: Tone }> = {
  [AssayerPayableStatus.PENDING]: { labelKey: 'earnings.payableStatus.pending', tone: 'warning' },
  [AssayerPayableStatus.APPROVED]: { labelKey: 'earnings.payableStatus.approved', tone: 'info' },
  [AssayerPayableStatus.PAID]: { labelKey: 'earnings.payableStatus.paid', tone: 'success' },
};

/** A rejected claim read as "pending" before — the same neutral grey as awaiting approval. */
const CLAIM_TONE: Record<string, Tone> = {
  APPROVED: 'success',
  PENDING: 'warning',
  REJECTED: 'danger',
};

const CLAIM_LABEL: Record<string, TranslationKey> = {
  APPROVED: 'earnings.claimStatus.approved',
  PENDING: 'earnings.claimStatus.pending',
  REJECTED: 'earnings.claimStatus.rejected',
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
  if (diff === 0) return translate('dates.today');
  if (diff === -1) return translate('dates.yesterday');
  if (diff < 0 && diff >= -13) return translate('dates.daysAgo', { count: Math.abs(diff) });
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
  assignments,
  statement,
  statementError,
  onOpenExpenseModal,
  claims,
  claimSummary,
}) => {
  const t = useTheme();
  const tr = useT();

  const expenses = claims?.length ? claims : assignments.flatMap((a) => a.expenses ?? []);
  const totalExpenses =
    claimSummary?.totalClaimed ?? expenses.reduce((s, e) => s + (e?.amount ?? 0), 0);
  // Every figure below comes from the statement. No fallbacks — see the prop's doc comment.
  const t0 = statement?.totals;
  const owed = t0?.outstanding ?? 0;
  const paid = t0?.paid ?? 0;
  const awaiting = t0?.awaitingApproval ?? 0;
  const lifetime = t0?.earned ?? 0;
  const onHold = t0?.onHoldOrDisputed ?? 0;
  /** What each completed audit was actually booked at, by assignment. */
  const bookedByAssignment = new Map<string, number>(
    (statement?.payables ?? [])
      .filter((p) => !p.expenseId && p.assignmentId)
      .map((p) => [p.assignmentId as string, p.totalAmount]),
  );

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

        <AppText variant="overline" tone="faint">{tr('earnings.balanceLabel')}</AppText>
        {statement ? (
          <>
            <AppText variant="display" tone={owed > 0 ? 'accent' : 'muted'}>{money(owed)}</AppText>
            <AppText variant="caption" tone="muted">
              {owed > 0 ? tr('earnings.balanceOwed') : tr('earnings.balanceSettled')}
            </AppText>

            <Divider spacing={2} />

            {/* Paid vs pending at a glance, in the app's chip pattern. */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
              <MoneyChip icon="trending-up" label={tr('earnings.chipEarned')} value={money(lifetime)} />
              <MoneyChip icon="checkmark-circle-outline" label={tr('earnings.chipPaid')} value={money(paid)} iconColor={t.colors.success} />
              <MoneyChip icon="hourglass-outline" label={tr('earnings.chipPending')} value={money(awaiting)} iconColor={t.colors.warning} />
              {onHold > 0 && (
                <MoneyChip icon="pause-circle-outline" label={tr('earnings.payableStatus.onHold')} value={money(onHold)} iconColor={t.colors.danger} />
              )}
            </View>
          </>
        ) : (
          /* No number at all rather than a guess. See the `statement` prop's doc comment. */
          <>
            <AppText variant="display" tone="muted">—</AppText>
            <AppText variant="caption" tone={statementError ? 'danger' : 'muted'}>
              {statementError ? tr('earnings.statementFailed') : tr('earnings.statementLoading')}
            </AppText>
          </>
        )}
      </Card>

      <StatStrip>
        <StatTile label={tr('earnings.statExpenses')} value={money(totalExpenses)} icon="receipt-outline" />
        <StatTile label={tr('earnings.statAudits')} value={completed.length} icon="checkmark-done" tone="success" />
        {claimSummary != null && claimSummary.pending > 0 && (
          <StatTile
            label={tr('earnings.statClaimsPending')}
            value={money(claimSummary.pending)}
            icon="hourglass-outline"
            tone="warning"
            hint={tr('earnings.statClaimsPendingHint')}
          />
        )}
      </StatStrip>

      {/* Secondary action — the hero owns the screen's attention, so no glow here. */}
      <Button label={tr('expense.title')} icon="add-circle-outline" variant="neutral" onPress={onOpenExpenseModal} full />

      {!hasAnyHistory && (
        <EmptyState
          icon="wallet-outline"
          title={tr('earnings.emptyTitle')}
          body={tr('earnings.emptyBody')}
        />
      )}

      {statement && (
        <CollapsibleSection title={tr('earnings.payoutsTitle')} defaultOpen>
          {payables.length === 0 ? (
            <EmptyState
              icon="document-text-outline"
              title={tr('earnings.payoutsEmptyTitle')}
              body={tr('earnings.payoutsEmptyBody')}
            />
          ) : (
            payables.slice(0, 8).map((p, i) => {
              const known = PAYABLE_STATE[p.status as AssayerPayableStatus];
              // A status this build has never heard of keeps the server's own word rather than
              // being given copy that might describe somebody's money wrongly.
              const state = p.onHold
                ? { label: tr('earnings.payableStatus.onHold'), tone: 'danger' as Tone }
                : known
                  ? { label: tr(known.labelKey), tone: known.tone }
                  : { label: String(p.status), tone: 'neutral' as Tone };
              return (
                <FadeIn key={p.id} delay={Math.min(i, 6) * 40}>
                  <Card level={1} style={{ gap: t.space.sm }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                      {/* Amount leads — it is what the row is about. Colour lives on the
                          Badge alone now: a payable's status was previously repeated as the
                          amount's own colour (green/amber/red), which meant every figure on
                          the screen fought for attention instead of only the ones that
                          actually needed it — the same restraint Apple's Wallet keeps
                          between a transaction's amount and its status pill. */}
                      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                        <AppText variant="h3">{money(p.totalAmount)}</AppText>
                        <AppText variant="caption" tone="faint" numberOfLines={1}>
                          {p.expenseId ? tr('earnings.expenseReimbursement') : p.payableNumber} · {pastDay(p.createdAt)}
                        </AppText>
                        {p.onHold && p.holdReason ? (
                          <AppText variant="caption" tone="muted" numberOfLines={2}>{p.holdReason}</AppText>
                        ) : null}
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <Badge label={state.label} tone={state.tone} dot />
                        {p.outstanding > 0 && p.outstanding !== p.totalAmount && (
                          <AppText variant="caption" tone="muted">{tr('earnings.outstanding', { amount: money(p.outstanding) })}</AppText>
                        )}
                      </View>
                    </View>
                    {/* The breakdown finance works from. Deriving a single fee off the
                        assignment could never show TDS or a part payment. */}
                    <Divider />
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <AppText variant="caption" tone="faint">{tr('earnings.base', { amount: money(p.baseAmount) })}</AppText>
                      <AppText variant="caption" tone="faint">{tr('earnings.travel', { amount: money(p.travelAmount) })}</AppText>
                      {p.tdsAmount > 0 && (
                        <AppText variant="caption" tone="faint">{tr('earnings.tds', { amount: money(p.tdsAmount) })}</AppText>
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
        <CollapsibleSection title={tr('earnings.paymentsTitle')} summary={tr('earnings.paymentsSummary')}>
          {payments.slice(0, 8).map((pm, i) => (
            <FadeIn key={pm.id} delay={Math.min(i, 6) * 40}>
              <Card level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  {/* "Paid" is already said once, by the badge — colouring the amount too
                      just repeats it in a louder voice. */}
                  <AppText variant="bodyStrong">{money(pm.amount)}</AppText>
                  <AppText variant="caption" tone="faint" numberOfLines={1}>
                    {pm.paymentReference} · {pm.method}
                  </AppText>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Badge label={tr('earnings.payableStatus.paid')} tone="success" dot />
                  <AppText variant="caption" tone="muted">{pastDay(pm.paidDate)}</AppText>
                </View>
              </Card>
            </FadeIn>
          ))}
        </CollapsibleSection>
      )}

      <CollapsibleSection title={tr('earnings.claimsTitle')} defaultOpen>
        {expenses.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title={tr('earnings.claimsEmptyTitle')}
            body={tr('earnings.claimsEmptyBody')}
            action={<Button label={tr('expense.title')} icon="add-circle-outline" variant="neutral" size="sm" onPress={onOpenExpenseModal} />}
          />
        ) : (
          expenses.slice(0, 10).map((exp, i) => (
            <FadeIn key={exp.id ?? i} delay={Math.min(i, 6) * 40}>
              <Card level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  {/* The status Badge on the right already carries approved/pending/rejected —
                      painting the amount the same colour a second time was the noisy part of
                      this row; a claim's rupee figure is a fact, not a verdict. */}
                  <AppText variant="bodyStrong">
                    {money(exp.amount)}
                  </AppText>
                  <AppText variant="caption" tone="faint" numberOfLines={1}>
                    {CAT_LABEL_KEYS[exp.category as keyof typeof CAT_LABEL_KEYS]
                      ? tr(CAT_LABEL_KEYS[exp.category as keyof typeof CAT_LABEL_KEYS])
                      : exp.category}
                    {exp.branchName ? ` · ${exp.branchName}` : ''}
                    {exp.createdAt ? ` · ${pastDay(exp.createdAt)}` : ''}
                  </AppText>
                </View>
                <Badge
                  label={CLAIM_LABEL[exp.status] ? tr(CLAIM_LABEL[exp.status]) : String(exp.status)}
                  tone={CLAIM_TONE[exp.status] ?? 'neutral'}
                />
              </Card>
            </FadeIn>
          ))
        )}
      </CollapsibleSection>

      <CollapsibleSection title={tr('earnings.completedTitle')} summary={tr('earnings.completedSummary')}>
        {completed.length === 0 ? (
          <EmptyState
            icon="wallet-outline"
            title={tr('earnings.completedEmptyTitle')}
            body={tr('earnings.completedEmptyBody')}
          />
        ) : (
          completed.slice(0, 15).map((a, i) => (
            <FadeIn key={a.id} delay={Math.min(i, 6) * 40}>
              <Card level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  {/* What the payout was actually booked at — not a figure worked out here.
                      An audit with no payout yet says so rather than showing an offer amount
                      that may not be what is paid. */}
                  {bookedByAssignment.has(a.id)
                    ? <AppText variant="bodyStrong">{money(bookedByAssignment.get(a.id) as number)}</AppText>
                    : <AppText variant="small" tone="muted">{tr('earnings.notBooked')}</AppText>}
                  <AppText variant="caption" tone="faint" numberOfLines={1}>
                    {a.branchName} · {a.scheduledDate ? pastDay(a.scheduledDate) : '—'}
                  </AppText>
                </View>
                <Badge label={tr('earnings.completedBadge')} tone="success" dot />
              </Card>
            </FadeIn>
          ))
        )}
      </CollapsibleSection>
    </View>
  );
};
