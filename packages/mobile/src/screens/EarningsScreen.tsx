import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { styles } from '../theme/styles';
import { Ionicons } from '@expo/vector-icons';
import { getAssignmentBaseFee, getAssignmentTotalFee } from '../utils/fees';

interface EarningsScreenProps {
  totalEarnings: number;
  pendingEarnings: number;
  runningBalance?: number;
  /** Actually disbursed by finance, from the billing engine. */
  earningsPaid?: number;
  /** Booked but not yet approved for payout. */
  earningsAwaitingApproval?: number;
  assignments: AssayerAssignment[];
  onOpenExpenseModal: () => void;
  /** Real assayer quality/performance rating expressed as a %, or null if no rating data exists yet. */
  qualityScore?: number | null;
  /** Real % of raised validation queries that have been resolved (0 when there are no queries yet). */
  queryResolutionRate?: number;
  /** Real average estimated audit duration across assignments, or null if no duration data exists. */
  avgAuditHours?: number | null;
  /** Billing-engine entries for this assayer, driving the live "Billing Status" section. */
  billingEntries?: any[];
}

const BILLING_STATE_LABEL: Record<string, string> = {
  PENDING_BILLING: 'Pending',
  READY_FOR_BILLING: 'Ready for billing',
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  INVOICED: 'Invoiced',
  PARTIALLY_PAID: 'Partially paid',
  PAID: 'Paid',
  ON_HOLD: 'On hold',
  DISPUTED: 'Disputed',
  CANCELLED: 'Cancelled',
  ADJUSTED: 'Adjusted',
  REJECTED: 'Rejected',
};

const BILLING_STATE_COLOR: Record<string, string> = {
  PAID: '#10b981',
  PARTIALLY_PAID: '#fbbf24',
  APPROVED: '#38bdf8',
  READY_FOR_BILLING: '#a78bfa',
  INVOICED: '#38bdf8',
  ON_HOLD: '#f97316',
  DISPUTED: '#f43f5e',
  CANCELLED: '#64748b',
  REJECTED: '#64748b',
};

export const EarningsScreen: React.FC<EarningsScreenProps> = ({
  totalEarnings,
  pendingEarnings,
  runningBalance,
  earningsPaid,
  earningsAwaitingApproval,
  assignments,
  billingEntries,
  onOpenExpenseModal,
  qualityScore,
  queryResolutionRate,
  avgAuditHours,
}) => {
  const totalExpenses = assignments
    .flatMap((a) => a.expenses)
    .reduce((sum, e) => sum + e.amount, 0);

  return (
    <View>
      <Text style={styles.sectionHeading}>Financial Summary</Text>

      <View style={styles.earningsSummaryGrid}>
        <View style={styles.earningsCard}>
          <Text style={styles.earningsLabel}>Earned</Text>
          <Text style={styles.earningsVal}>₹{(totalEarnings || 0).toLocaleString()}</Text>
          <Text style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>Completed audits</Text>
        </View>
        <View style={styles.earningsCard}>
          <Text style={styles.earningsLabel}>Pending</Text>
          <Text style={[styles.earningsVal, { color: '#fbbf24' }]}>₹{(pendingEarnings || 0).toLocaleString()}</Text>
          <Text style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>Awaiting payout</Text>
        </View>
      </View>

      {/* Settlement position, straight from the billing engine — the same figures
          finance pays against, so this can never disagree with what lands in the bank.
          Previously this card showed a `running_balance` column nothing ever wrote,
          so it read zero and never appeared. */}
      {(Number(runningBalance) > 0 || Number(earningsPaid) > 0 || Number(earningsAwaitingApproval) > 0) && (
        <View style={[styles.card, { marginBottom: 14 }]}>
          <Text style={{ fontSize: 12, color: '#94a3b8', fontWeight: '700', marginBottom: 10 }}>Settlement</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <View>
              <Text style={{ fontSize: 12, color: '#e2e8f0', fontWeight: '600' }}>Owed to you</Text>
              <Text style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>Approved, awaiting payout</Text>
            </View>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#818cf8' }}>₹{Number(runningBalance || 0).toLocaleString()}</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1, borderTopColor: '#1e293b' }}>
            <View>
              <Text style={{ fontSize: 11, color: '#64748b' }}>Paid to date</Text>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#34d399' }}>₹{Number(earningsPaid || 0).toLocaleString()}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ fontSize: 11, color: '#64748b' }}>Awaiting approval</Text>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#fbbf24' }}>₹{Number(earningsAwaitingApproval || 0).toLocaleString()}</Text>
            </View>
          </View>
        </View>
      )}

      {/* Billing Status — live from the billing engine (assignment-level entries) */}
      <Text style={styles.subHeading}>Billing Status</Text>
      {(!billingEntries || billingEntries.length === 0) ? (
        <View style={styles.emptyBox}>
          <Ionicons name="receipt-outline" size={32} color="#94a3b8" style={{ marginBottom: 8 }} />
          <Text style={styles.emptyText}>No billing records yet</Text>
        </View>
      ) : (
        <View style={{ gap: 8, marginBottom: 16 }}>
          {billingEntries.map((e) => {
            const label = BILLING_STATE_LABEL[e.state] || e.state;
            const color = BILLING_STATE_COLOR[e.state] || '#94a3b8';
            return (
              <View key={e.id} style={[styles.card, { marginBottom: 0, padding: 12 }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{e.assignmentNumber || e.id.slice(0, 8)}</Text>
                  <Text style={{ fontSize: 13, fontWeight: '800', color }}>{label}</Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 11, color: '#94a3b8' }}>{e.description || 'Billing entry'}</Text>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: '#10b981' }}>₹{Number(e.totalAmount || 0).toLocaleString()}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* Embedded Audit Performance Metrics */}
      <Text style={styles.subHeading}>Audit Performance & Quality Metrics</Text>
      <View style={styles.perfGrid}>
        <View style={styles.perfBox}>
          <Text style={styles.perfVal}>{qualityScore != null ? `${qualityScore}%` : '—'}</Text>
          <Text style={styles.perfLabel}>Quality Score</Text>
        </View>
        <View style={styles.perfBox}>
          <Text style={[styles.perfVal, { color: '#34d399' }]}>{assignments.filter(a => a.status === 'COMPLETED').length}</Text>
          <Text style={styles.perfLabel}>Completed</Text>
        </View>
        <View style={styles.perfBox}>
          <Text style={[styles.perfVal, { color: '#fbbf24' }]}>{queryResolutionRate != null ? `${queryResolutionRate}%` : '—'}</Text>
          <Text style={styles.perfLabel}>Query Resolved</Text>
        </View>
        <View style={styles.perfBox}>
          <Text style={[styles.perfVal, { color: '#38bdf8' }]}>{avgAuditHours != null ? `${avgAuditHours.toFixed(1)}h` : '—'}</Text>
          <Text style={styles.perfLabel}>Avg Hours</Text>
        </View>
      </View>

      <Text style={styles.subHeading}>Fee Breakdown by Assignment</Text>
      <View style={{ gap: 8, marginBottom: 16 }}>
        {(() => {
          // A rejected assignment (also covers backend CANCELLED — see
          // BACKEND_TO_MOBILE_STATUS in api.service.ts) never has a billable fee,
          // so it has nothing to break down here.
          const billableAssignments = assignments.filter((a) => a.status !== 'REJECTED');
          if (billableAssignments.length === 0) {
            return <Text style={{ color: '#64748b', fontSize: 12 }}>No assignment financial records</Text>;
          }
          return billableAssignments.map((a) => {
            // Same precedence-based fee resolution used everywhere else (App.tsx summary
            // cards, ScheduleScreen) — a negotiated-down agreed fee must never be inflated
            // back up to the standard rate here.
            const baseFee = a.standardBaseFee || 1200;
            const agreedFee = getAssignmentBaseFee(a);
            const travelFee = a.agreedTravelFee || 0;
            const total = getAssignmentTotalFee(a);

            return (
              <View key={a.id} style={[styles.card, { marginBottom: 0, padding: 12 }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{a.branchName}</Text>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: '#10b981' }}>₹{total.toLocaleString()}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <Text style={{ fontSize: 11, color: '#94a3b8' }}>Standard Base: <Text style={{ color: '#cbd5e1', fontWeight: '600' }}>₹{baseFee}</Text></Text>
                  <Text style={{ fontSize: 11, color: '#94a3b8' }}>Audit Fee: <Text style={{ color: '#fbbf24', fontWeight: '600' }}>₹{agreedFee}</Text></Text>
                  {travelFee > 0 && <Text style={{ fontSize: 11, color: '#94a3b8' }}>Travel: <Text style={{ color: '#818cf8', fontWeight: '600' }}>+₹{travelFee}</Text></Text>}
                </View>
              </View>
            );
          });
        })()}
      </View>

      <Text style={styles.subHeading}>Travel Expenses</Text>

      {assignments.flatMap((a) => a.expenses).length === 0 ? (
        <View style={styles.emptyBox}>
          <Ionicons name="receipt" size={32} color="#94a3b8" style={{ marginBottom: 8 }} />
          <Text style={styles.emptyText}>No travel expenses yet</Text>
        </View>
      ) : (
        assignments
          .flatMap((a) => a.expenses)
          .map((exp) => (
            <View key={exp.id} style={styles.expenseRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.expDesc}>{exp.description}</Text>
                <Text style={styles.expBranch}>{exp.category} • {exp.branchName}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.expAmount}>₹{exp.amount}</Text>
                <Text style={styles.expStatus}>{exp.status}</Text>
              </View>
            </View>
          ))
      )}

      {totalExpenses > 0 && (
        <View style={[styles.card, { backgroundColor: 'rgba(16, 185, 129, 0.08)', borderColor: 'rgba(16, 185, 129, 0.3)' }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: '#94a3b8', fontWeight: '600', fontSize: 13 }}>Total Expenses Claimed</Text>
            <Text style={{ color: '#34d399', fontWeight: '800', fontSize: 16 }}>₹{totalExpenses.toLocaleString()}</Text>
          </View>
        </View>
      )}

      <TouchableOpacity style={styles.saveBtn} onPress={onOpenExpenseModal}>
        <Text style={styles.btnTextWhite}>New Expense</Text>
      </TouchableOpacity>
    </View>
  );
};
