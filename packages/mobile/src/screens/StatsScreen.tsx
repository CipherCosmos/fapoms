import React from 'react';
import { View, Text } from 'react-native';
import { styles } from '../theme/styles';

interface StatsScreenProps {
  qualityScore: number;
  totalCompleted: number;
  queryResolutionRate: number;
  avgAuditHours: string;
  totalAssignments?: number;
  averageRating?: number;
  onTimePercentage?: number;
}

export const StatsScreen: React.FC<StatsScreenProps> = ({
  qualityScore,
  totalCompleted,
  queryResolutionRate,
  avgAuditHours,
  totalAssignments,
  averageRating,
  onTimePercentage,
}) => {
  return (
    <View>
      <Text style={styles.sectionHeading}>Performance</Text>

      <View style={styles.perfGrid}>
        <View style={styles.perfBox}>
          <Text style={styles.perfVal}>{qualityScore}%</Text>
          <Text style={styles.perfLabel}>Quality</Text>
        </View>
        <View style={styles.perfBox}>
          <Text style={[styles.perfVal, { color: '#34d399' }]}>{totalCompleted}</Text>
          <Text style={styles.perfLabel}>Completed</Text>
        </View>
        <View style={styles.perfBox}>
          <Text style={[styles.perfVal, { color: '#fbbf24' }]}>{queryResolutionRate}%</Text>
          <Text style={styles.perfLabel}>Resolved</Text>
        </View>
        <View style={styles.perfBox}>
          <Text style={[styles.perfVal, { color: '#38bdf8' }]}>{avgAuditHours}</Text>
          <Text style={styles.perfLabel}>Avg Hours</Text>
        </View>
      </View>

      {averageRating != null && averageRating > 0 && (
        <View style={[styles.card, { marginTop: 16 }]}>
          <Text style={styles.cardTitle}>Summary</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginTop: 12 }}>
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={{ fontSize: 24, fontWeight: '800', color: '#fbbf24' }}>{averageRating}</Text>
              <Text style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Rating</Text>
            </View>
            <View style={{ width: 1, backgroundColor: 'rgba(255,255,255,0.08)' }} />
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={{ fontSize: 24, fontWeight: '800', color: '#ffffff' }}>{totalAssignments || 0}</Text>
              <Text style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Total</Text>
            </View>
            <View style={{ width: 1, backgroundColor: 'rgba(255,255,255,0.08)' }} />
            <View style={{ alignItems: 'center', flex: 1 }}>
              <Text style={{ fontSize: 24, fontWeight: '800', color: '#34d399' }}>{onTimePercentage || 0}%</Text>
              <Text style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>On-Time</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
};
