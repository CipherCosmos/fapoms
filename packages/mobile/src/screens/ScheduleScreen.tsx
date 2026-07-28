import React from 'react';
import { View, Text, TouchableOpacity, Platform, Linking } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { styles } from '../theme/styles';

interface ScheduleScreenProps {
  assignments: AssayerAssignment[];
  onAcceptAssignment: (id: string) => void;
  onOpenRejectModal: (id: string) => void;
  onCheckIn: (assignment: AssayerAssignment) => void;
  onOpenPdfDocs: (assignment: AssayerAssignment) => void;
}

const openGoogleMaps = (lat: number, lng: number) => {
  const url =
    Platform.OS === 'ios'
      ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`
      : `https://maps.google.com/maps?daddr=${lat},${lng}`;
  Linking.openURL(url).catch(() => Linking.openURL(`https://maps.google.com/maps?daddr=${lat},${lng}`));
};

export const ScheduleScreen: React.FC<ScheduleScreenProps> = ({
  assignments,
  onAcceptAssignment,
  onOpenRejectModal,
  onCheckIn,
  onOpenPdfDocs,
}) => {
  if (assignments.length === 0) {
    return (
      <View>
        <Text style={styles.sectionHeading}>Today's Schedule</Text>
        <View style={styles.emptyBox}>
          <Text style={{ fontSize: 40, marginBottom: 12 }}>📋</Text>
          <Text style={styles.emptyText}>No assignments for today</Text>
          <Text style={{ color: '#64748b', fontSize: 13, marginTop: 4, textAlign: 'center' }}>
            New assignments will appear here when scheduled
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <Text style={styles.sectionHeading}>Today's Schedule</Text>
        <View style={{ backgroundColor: 'rgba(99, 102, 241, 0.15)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(99, 102, 241, 0.3)' }}>
          <Text style={{ color: '#a5b4fc', fontSize: 11, fontWeight: '800' }}>{assignments.length} stops</Text>
        </View>
      </View>

      {assignments.map((assignment, index) => (
        <View key={assignment.id} style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.seqBadge}>
              <Text style={styles.seqText}>STOP #{index + 1}</Text>
            </View>
            <Text style={[styles.statusBadge, styles[`status_${assignment.status}` as keyof typeof styles] as any]}>
              {assignment.status}
            </Text>
          </View>

          <Text style={styles.branchName}>{assignment.branchName}</Text>
          <Text style={styles.address}>{assignment.branchAddress}</Text>

          {assignment.bankName ? (
            <Text style={{ fontSize: 12, color: '#64748b', marginTop: 4, fontWeight: '600' }}>
              {assignment.bankName}
            </Text>
          ) : null}

          <View style={styles.metricsRow}>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Customers</Text>
              <Text style={styles.metricVal}>{assignment.estimatedCustomerCount || assignment.customers?.length || 0}</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Fee</Text>
              {assignment.agreedBaseFee > 0 ? (
                <Text style={styles.metricVal}>₹{assignment.agreedBaseFee}</Text>
              ) : assignment.proposedFee > 0 ? (
                <Text style={[styles.metricVal, { fontSize: 14 }]}>₹{assignment.proposedFee} (Proposed)</Text>
              ) : (
                <Text style={[styles.metricVal, { fontSize: 14, color: '#94a3b8' }]}>Pending</Text>
              )}
              {assignment.agreedTravelFee > 0 && (
                <Text style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>+₹{assignment.agreedTravelFee} Travel</Text>
              )}
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Date</Text>
              <Text style={[styles.metricVal, { fontSize: 12 }]}>{assignment.scheduledDate ? new Date(assignment.scheduledDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : 'Today'}</Text>
            </View>
          </View>

          {assignment.status === 'PENDING' && (
            <View style={styles.actionGrid}>
              <TouchableOpacity style={styles.acceptBtn} onPress={() => onAcceptAssignment(assignment.id)}>
                <Text style={styles.btnTextWhite}>Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.rejectBtn} onPress={() => onOpenRejectModal(assignment.id)}>
                <Text style={styles.btnTextWhite}>Reject</Text>
              </TouchableOpacity>
            </View>
          )}

          {assignment.status === 'ACCEPTED' && (
            <View style={styles.actionGrid}>
              <TouchableOpacity
                style={[styles.mapBtn, { backgroundColor: '#ea580c' }]}
                onPress={() => openGoogleMaps(assignment.latitude, assignment.longitude)}
              >
                <Text style={styles.btnTextWhite}>
                  {Platform.OS === 'ios' ? '🗺️ Open in Apple Maps' : '🗺️ Navigate via Google Maps'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.checkInBtn} onPress={() => onCheckIn(assignment)}>
                <Text style={styles.btnTextWhite}>Check-In</Text>
              </TouchableOpacity>
            </View>
          )}

          {(assignment.status === 'CHECKED_IN' || assignment.status === 'SCHEDULED' || assignment.status === 'IN_PROGRESS') && (
            <View style={styles.actionGrid}>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => onOpenPdfDocs(assignment)}>
                <Text style={styles.btnTextWhite}>Open PDF Docs</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      ))}
    </View>
  );
};
