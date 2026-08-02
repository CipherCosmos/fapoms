import React from 'react';
import { View } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { getAssignmentTotalFee } from '../utils/fees';
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
  qualityScore?: number | null;
  queryResolutionRate?: number;
  avgAuditHours?: number | null;
  billingEntries?: any[];
}

type Tone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const BILLING_STATE: Record<string, { label: string; tone: Tone }> = {
  PENDING_BILLING: { label: 'Pending', tone: 'neutral' },
  READY_FOR_BILLING: { label: 'Ready for billing', tone: 'info' },
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUBMITTED: { label: 'Submitted', tone: 'info' },
  UNDER_REVIEW: { label: 'Under review', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'info' },
  INVOICED: { label: 'Invoiced', tone: 'info' },
  PARTIALLY_PAID: { label: 'Partially paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
  ON_HOLD: { label: 'On hold', tone: 'warning' },
  DISPUTED: { label: 'Disputed', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  ADJUSTED: { label: 'Adjusted', tone: 'neutral' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
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
  billingEntries,
  onOpenExpenseModal,
}) => {
  const t = useTheme();

  const expenses = assignments.flatMap((a) => a.expenses ?? []);
  const totalExpenses = expenses.reduce((s, e) => s + (e?.amount ?? 0), 0);
  const owed = runningBalance ?? pendingEarnings ?? 0;
  const paid = earningsPaid ?? 0;
  const awaiting = earningsAwaitingApproval ?? 0;

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
        <StatTile label="Lifetime earned" value={money(totalEarnings)} icon="trending-up" tone="primary" />
        <StatTile label="Expenses claimed" value={money(totalExpenses)} icon="receipt-outline" />
        <StatTile label="Audits completed" value={completed.length} icon="checkmark-done" tone="success" />
      </StatStrip>

      <Button label="Log an expense" icon="add-circle-outline" variant="neutral" onPress={onOpenExpenseModal} full />

      {billingEntries && billingEntries.length > 0 && (
        <Section title="Billing status">
          {billingEntries.slice(0, 8).map((e: any, i: number) => {
            const state = BILLING_STATE[e.state] ?? { label: String(e.state ?? 'Unknown'), tone: 'neutral' as Tone };
            return (
              <FadeIn key={e.id ?? i} delay={Math.min(i, 6) * 40}>
                <Card level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <AppText variant="bodyStrong" numberOfLines={1}>
                      {e.branchName ?? e.description ?? 'Audit fee'}
                    </AppText>
                    <View style={{ flexDirection: 'row' }}>
                      <Badge label={state.label} tone={state.tone} dot />
                    </View>
                  </View>
                  <AppText variant="h3" tone={state.tone === 'success' ? 'success' : 'default'}>
                    {money(e.totalAmount ?? e.baseAmount ?? 0)}
                  </AppText>
                </Card>
              </FadeIn>
            );
          })}
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
                  <Badge label={String(exp.status)} tone={exp.status === 'APPROVED' ? 'success' : 'neutral'} />
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
                <AppText variant="h3" tone="success">{money(getAssignmentTotalFee(a))}</AppText>
              </Card>
            </FadeIn>
          ))
        )}
      </Section>
    </View>
  );
};
