import React from 'react';
import { View, Text, TouchableOpacity, Platform, Linking } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { styles } from '../theme/styles';
import { MobileApiService } from '../services/api.service';
import { getAssignmentTotalFee } from '../utils/fees';
import { Ionicons } from '@expo/vector-icons';

interface ScheduleScreenProps {
  assignments: AssayerAssignment[];
  onAcceptAssignment: (id: string) => void;
  onOpenRejectModal: (id: string) => void;
  onCheckIn: (assignment: AssayerAssignment) => void;
  onOpenPdfDocs: (assignment: AssayerAssignment) => void;
  onOpenScanner?: (assignment: AssayerAssignment) => void;
  onCounterOffer?: (assignment: AssayerAssignment) => void;
  onOpenQueryChat?: (assignment: AssayerAssignment) => void;
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
  onOpenScanner,
  onCounterOffer,
  onOpenQueryChat,
}) => {
  const [filterTab, setFilterTab] = React.useState<'ACTIVE' | 'COMPLETED'>('ACTIVE');

  const activeAssignments = assignments.filter(a => a.status !== 'COMPLETED' && a.status !== 'REJECTED');
  const completedAssignments = assignments.filter(a => a.status === 'COMPLETED' || a.status === 'REJECTED');
  const displayedAssignments = filterTab === 'ACTIVE' ? activeAssignments : completedAssignments;

  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <View style={{ flexDirection: 'row', gap: 6, backgroundColor: '#1e293b', padding: 4, borderRadius: 8, borderWidth: 1, borderColor: '#334155' }}>
          <TouchableOpacity
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: filterTab === 'ACTIVE' ? '#3b82f6' : 'transparent' }}
            onPress={() => setFilterTab('ACTIVE')}
          >
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Active Dispatches ({activeAssignments.length})</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: filterTab === 'COMPLETED' ? '#10b981' : 'transparent' }}
            onPress={() => setFilterTab('COMPLETED')}
          >
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Audit Archive ({completedAssignments.length})</Text>
          </TouchableOpacity>
        </View>
      </View>

      {displayedAssignments.length === 0 ? (
        <View style={styles.emptyBox}>
          <Ionicons
            name={filterTab === 'ACTIVE' ? 'clipboard' : 'document-text'}
            size={44}
            color="#94a3b8"
            style={{ marginBottom: 12 }}
          />
          <Text style={styles.emptyText}>No {filterTab.toLowerCase()} audit assignments found</Text>
        </View>
      ) : (
        displayedAssignments.map((assignment, index) => (
          <View key={assignment.id} style={styles.card}>
            {/* Card Header: Stop Sequence & Status Pill */}
            <View style={styles.cardHeader}>
              <View style={styles.seqBadge}>
                <Text style={styles.seqText}>STOP #{index + 1}</Text>
              </View>
              <Text style={[styles.statusBadge, styles[`status_${assignment.status}` as keyof typeof styles] as any]}>
                ● {assignment.status.replace('_', ' ')}
              </Text>
            </View>

            {/* Branch Title & Address */}
            <Text style={styles.branchName}>{assignment.branchName}</Text>
            <Text style={styles.address}>{assignment.branchAddress}</Text>

            {/* Audit Date & Bank Info Banner */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, marginBottom: 10, backgroundColor: 'rgba(99,102,241,0.1)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(99,102,241,0.25)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="calendar" size={12} color="#a5b4fc" />
                  <Text style={{ fontSize: 12, color: '#a5b4fc', fontWeight: '800' }}>
                    Scheduled: {assignment.scheduledDate ? new Date(assignment.scheduledDate).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : 'Today'}
                  </Text>
                </View>
              {assignment.bankName ? (
                <View style={{ backgroundColor: 'rgba(15,23,42,0.6)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}>
                  <Text style={{ fontSize: 11, color: '#38bdf8', fontWeight: '700' }}>{assignment.bankName}</Text>
                </View>
              ) : null}
            </View>

            {/* Scannable Metrics Grid */}
            <View style={styles.metricsRow}>
              <View style={styles.metricBox}>
                <Text style={styles.metricLabel}>Distance</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                    <Ionicons name="location" size={12} color="#f8fafc" />
                    <Text style={styles.metricVal}>
                      {assignment.distanceKm != null ? `${assignment.distanceKm} km` : 'Nearby'}
                    </Text>
                  </View>
              </View>
              <View style={styles.metricBox}>
                <Text style={styles.metricLabel}>Gold Packets</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                    <Ionicons name="cube" size={12} color="#f8fafc" />
                    <Text style={styles.metricVal}>{assignment.estimatedCustomerCount || 15} Pkts</Text>
                  </View>
              </View>
              <View style={styles.metricBox}>
                <Text style={styles.metricLabel}>Audit Fee</Text>
                {/* Same fallback-applied total shown in Earnings, so the price shown here
                    at accept-time matches what's actually paid out later. */}
                <Text style={[styles.metricVal, { color: assignment.agreedBaseFee > 0 ? '#34d399' : '#fbbf24' }]}>
                  ₹{getAssignmentTotalFee(assignment)}
                </Text>
              </View>
            </View>

            {/* Status: PENDING (Accept / Reject / Negotiate) */}
            {assignment.status === 'PENDING' && (
              <View style={{ gap: 10, marginTop: 12 }}>
                {assignment.negotiationCount && assignment.negotiationCount > 0 ? (
                  <View style={{ padding: 10, backgroundColor: 'rgba(245,158,11,0.12)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)', gap: 4 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons name="chatbubble" size={12} color="#fbbf24" />
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#fbbf24' }}>
                          Counter Offer Round #{assignment.negotiationCount}/3
                        </Text>
                      </View>
                      <Text style={{ fontSize: 11, color: '#fcd34d', fontWeight: '700' }}>
                        Proposed: ₹{assignment.proposedFee}
                      </Text>
                    </View>
                    {assignment.remarks ? (
                      <Text style={{ fontSize: 11, color: '#cbd5e1' }}>{assignment.remarks}</Text>
                    ) : null}
                  </View>
                ) : null}

                <View style={styles.actionGrid}>
                  <TouchableOpacity style={styles.acceptBtn} onPress={() => onAcceptAssignment(assignment.id)}>
                    <Text style={styles.btnTextWhite}>Accept Audit ₹{getAssignmentTotalFee(assignment)}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.rejectBtn} onPress={() => onOpenRejectModal(assignment.id)}>
                    <Text style={styles.btnTextWhite}>Decline</Text>
                  </TouchableOpacity>
                </View>

                {onCounterOffer && (
                  <TouchableOpacity
                    style={[
                      styles.mapBtn,
                      {
                        backgroundColor: (assignment.negotiationCount || 0) >= 3 ? 'rgba(71,85,105,0.4)' : 'rgba(139,92,246,0.2)',
                        borderColor: (assignment.negotiationCount || 0) >= 3 ? '#475569' : '#8b5cf6',
                        marginTop: 4,
                      },
                    ]}
                    disabled={(assignment.negotiationCount || 0) >= 3}
                    onPress={() => onCounterOffer(assignment)}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Ionicons
                        name={(assignment.negotiationCount || 0) >= 3 ? 'lock-closed' : 'chatbubble'}
                        size={12}
                        color={(assignment.negotiationCount || 0) >= 3 ? '#94a3b8' : '#c084fc'}
                      />
                      <Text style={{ color: (assignment.negotiationCount || 0) >= 3 ? '#94a3b8' : '#c084fc', fontSize: 12, fontWeight: '800' }}>
                        {(assignment.negotiationCount || 0) >= 3
                          ? 'Max Negotiation Limit Reached (3/3)'
                          : `Propose Counter Fee Rate (${assignment.negotiationCount || 0}/3 Rounds)`}
                      </Text>
                    </View>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Status: ACCEPTED (Navigation & Check-In) */}
            {assignment.status === 'ACCEPTED' && (
              <View style={[styles.btnRow, { marginTop: 12 }]}>
                <TouchableOpacity
                  style={[styles.mapBtn, { flex: 1, backgroundColor: 'rgba(234,88,12,0.2)', borderColor: '#ea580c' }]}
                  onPress={() => openGoogleMaps(assignment.latitude, assignment.longitude)}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name="map" size={14} color="#ff8c00" />
                    <Text style={{ color: '#ff8c00', fontSize: 13, fontWeight: '800' }}>
                      {Platform.OS === 'ios' ? 'Apple Maps' : 'Google Maps'}
                    </Text>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity style={[styles.checkInBtn, { flex: 1 }]} onPress={() => onCheckIn(assignment)}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="location" size={14} color="#fff" />
                    <Text style={styles.btnTextWhite}>Check-In at Branch</Text>
                  </View>
                </TouchableOpacity>
              </View>
            )}

            {/* Status: CHECKED IN / IN PROGRESS (Camera Scanner & Docs) */}
            {(assignment.status === 'CHECKED_IN' || assignment.status === 'IN_PROGRESS') && (
              <View style={{ marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', gap: 10 }}>
                <View style={{ gap: 8 }}>
                  <TouchableOpacity
                    style={[styles.primaryBtn, { backgroundColor: '#6366f1' }]}
                    onPress={() => onOpenScanner ? onOpenScanner(assignment) : onOpenPdfDocs(assignment)}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="camera" size={14} color="#fff" />
                    <Text style={styles.primaryBtnText}>Document Scanner</Text>
                  </View>
                  </TouchableOpacity>

                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      style={[styles.secondaryBtn, { flex: 1 }]}
                      onPress={() => Linking.openURL(`${MobileApiService.getBaseUrl()}/documents/project-branch/${assignment.projectBranchId}/download-pdf`)}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="download" size={14} color="#f8fafc" />
                        <Text style={styles.secondaryBtnText}>Download PDF</Text>
                      </View>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.primaryBtn, { flex: 1, backgroundColor: '#10b981' }]}
                      onPress={() => onOpenPdfDocs(assignment)}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="folder" size={14} color="#fff" />
                        <Text style={styles.primaryBtnText}>Upload Docs</Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            )}

            {/* Status: COMPLETED */}
            {assignment.status === 'COMPLETED' && (
              <View style={{ marginTop: 12, padding: 12, backgroundColor: 'rgba(16,185,129,0.12)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)', gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="checkmark-circle" size={14} color="#34d399" />
                  <Text style={{ fontSize: 13, fontWeight: '800', color: '#34d399' }}>
                    Audit Completed
                  </Text>
                </View>

                {assignment.queries && assignment.queries.length > 0 ? (
                  <TouchableOpacity
                    style={{ paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#00a884', borderRadius: 10, alignItems: 'center', marginTop: 4 }}
                    onPress={() => onOpenQueryChat ? onOpenQueryChat(assignment) : onOpenPdfDocs(assignment)}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Ionicons name="chatbubble" size={14} color="#fff" />
                      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>
                        Open Query Chat
                      </Text>
                    </View>
                  </TouchableOpacity>
                ) : null}
              </View>
            )}
          </View>
        ))
      )}
    </View>
  );
};
