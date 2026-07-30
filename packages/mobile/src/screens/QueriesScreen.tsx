import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { styles } from '../theme/styles';
import { Ionicons } from '@expo/vector-icons';

interface QueriesScreenProps {
  assignments: AssayerAssignment[];
  onOpenQueryChat: (assignment: AssayerAssignment) => void;
}

export const QueriesScreen: React.FC<QueriesScreenProps> = ({
  assignments,
  onOpenQueryChat,
}) => {
  // Extract only assignments that have actual query history initiated by Data Entry
  const activeQueryAssignments = assignments.filter((a) => a.queries && a.queries.length > 0);

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="chatbubble" size={16} color="#f8fafc" />
        <Text style={styles.sectionHeading}>Data Entry Validation Queries</Text>
      </View>
      
      {activeQueryAssignments.length === 0 ? (
        <View style={styles.emptyBox}>
          <Ionicons name="happy" size={44} color="#94a3b8" style={{ marginBottom: 12 }} />
          <Text style={styles.emptyText}>No clarification queries raised by Data Entry team yet.</Text>
        </View>
      ) : (
        activeQueryAssignments.map((assignment) => {
          const hasOpenQueries = (assignment.queries || []).some((q) => q.status === 'OPEN');
          const hasRespondedQueries = (assignment.queries || []).some((q) => q.status === 'RESPONDED');
          const isFullyResolved = (assignment.queries || []).length > 0 && (assignment.queries || []).every((q) => q.status === 'RESOLVED');
          
          return (
            <View key={assignment.id} style={[styles.card, (hasOpenQueries || hasRespondedQueries) && { borderColor: '#6366f1', borderWidth: 1.5 }]}>
              <View style={styles.cardHeader}>
                <Text style={styles.queryValidator}>{assignment.bankName}</Text>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                  {hasOpenQueries ? (
                    <View style={{ backgroundColor: 'rgba(239,68,68,0.15)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
                      <Text style={{ color: '#f87171', fontSize: 10, fontWeight: '800' }}>● OPEN QUERY</Text>
                    </View>
                  ) : hasRespondedQueries ? (
                    <View style={{ backgroundColor: 'rgba(245,158,11,0.15)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                        <Ionicons name="chatbubble" size={10} color="#fbbf24" />
                        <Text style={{ color: '#fbbf24', fontSize: 10, fontWeight: '800' }}>RESPONDED</Text>
                      </View>
                    </View>
                  ) : isFullyResolved ? (
                    <View style={{ backgroundColor: 'rgba(16,185,129,0.15)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                        <Ionicons name="lock-closed" size={10} color="#34d399" />
                        <Text style={{ color: '#34d399', fontSize: 10, fontWeight: '800' }}>CLOSED / RESOLVED</Text>
                      </View>
                    </View>
                  ) : null}
                </View>
              </View>

              <Text style={styles.queryCust}>Branch: {assignment.branchName} ({assignment.branchCode})</Text>
              <Text style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>Assessment #{assignment.assignmentCode} • Audit Date: {assignment.scheduledDate}</Text>

              <TouchableOpacity
                style={{
                  marginTop: 14,
                  paddingVertical: 12,
                  paddingHorizontal: 16,
                  backgroundColor: isFullyResolved ? 'rgba(51,65,85,0.8)' : '#00a884',
                  borderRadius: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
                onPress={() => onOpenQueryChat(assignment)}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons
                    name={isFullyResolved ? 'eye' : 'chatbubble'}
                    size={14}
                    color="#fff"
                  />
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>
                    {isFullyResolved ? 'View Closed Chat History (Read Only)' : 'Open Live Query Room'}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          );
        })
      )}
    </View>
  );
};
