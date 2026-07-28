import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { styles } from '../theme/styles';

interface EarningsScreenProps {
  totalEarnings: number;
  pendingEarnings: number;
  runningBalance?: number;
  assignments: AssayerAssignment[];
  onOpenExpenseModal: () => void;
}

export const EarningsScreen: React.FC<EarningsScreenProps> = ({
  totalEarnings,
  pendingEarnings,
  runningBalance,
  assignments,
  onOpenExpenseModal,
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

      {runningBalance != null && runningBalance > 0 && (
        <View style={[styles.card, { marginBottom: 14 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text style={{ fontSize: 12, color: '#94a3b8', fontWeight: '600' }}>Running Balance</Text>
              <Text style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>Total available for withdrawal</Text>
            </View>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#818cf8' }}>₹{Number(runningBalance).toLocaleString()}</Text>
          </View>
        </View>
      )}

      <Text style={styles.subHeading}>Travel Expenses</Text>

      {assignments.flatMap((a) => a.expenses).length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={{ fontSize: 32, marginBottom: 8 }}>🧾</Text>
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
