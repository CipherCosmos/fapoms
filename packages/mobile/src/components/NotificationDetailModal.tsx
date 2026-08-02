import React from 'react';
import { View, Modal, ScrollView, Platform } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, Divider, IconButton } from './ui/primitives';

interface NotificationDetailModalProps {
  visible: boolean;
  onClose: () => void;
  assignment: AssayerAssignment | null;
  onAccept?: (assignmentId: string) => void;
  onNavigate?: (assignment: AssayerAssignment) => void;
}

export const NotificationDetailModal: React.FC<NotificationDetailModalProps> = ({
  visible,
  onClose,
  assignment,
  onAccept,
  onNavigate,
}) => {
  const t = useTheme();

  if (!visible || !assignment) return null;

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={{
        flex: 1,
        backgroundColor: t.colors.scrim,
        justifyContent: 'center',
        padding: t.space.xl,
      }}>
        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl, maxHeight: '85%' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Badge label="Assignment Details" tone="primary" dot />
            <IconButton icon="close" onPress={onClose} />
          </View>

          <ScrollView style={{ flexGrow: 0 }}>
            <View style={{ gap: t.space.xs }}>
              <AppText variant="h2">{assignment.branchName}</AppText>
              <AppText variant="caption" tone="muted">Code: {assignment.branchCode || 'BR-0010'}</AppText>
              <AppText variant="small" tone="faint">{assignment.branchAddress}</AppText>
            </View>

            <Divider spacing={t.space.md} />

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.md }}>
              <View style={{ flex: 1, minWidth: 120, gap: 2 }}>
                <AppText variant="overline" tone="faint">DATE</AppText>
                <AppText variant="bodyStrong">{assignment.scheduledDate || 'Today'}</AppText>
              </View>

              <View style={{ flex: 1, minWidth: 120, gap: 2 }}>
                <AppText variant="overline" tone="faint">FEE</AppText>
                <AppText variant="bodyStrong" tone="success">
                  {assignment.agreedBaseFee > 0
                    ? `₹${assignment.agreedBaseFee}`
                    : assignment.proposedFee > 0
                    ? `₹${assignment.proposedFee} (Proposed)`
                    : 'Pending'}
                </AppText>
              </View>

              <View style={{ flex: 1, minWidth: 120, gap: 2 }}>
                <AppText variant="overline" tone="faint">STATUS</AppText>
                <AppText variant="bodyStrong" tone="accent">{assignment.status}</AppText>
              </View>
            </View>
          </ScrollView>

          <View style={{ flexDirection: 'row', gap: t.space.md, marginTop: t.space.sm }}>
            {assignment.status === 'PENDING' && onAccept && (
              <Button
                label="Accept"
                icon="checkmark"
                onPress={() => { onAccept(assignment.id); onClose(); }}
                style={{ flex: 1 }}
              />
            )}
            {onNavigate && (
              <Button
                label="Navigate"
                icon="navigate"
                variant="neutral"
                onPress={() => { onClose(); onNavigate(assignment); }}
                style={{ flex: 1 }}
              />
            )}
            <Button label="Close" variant="neutral" onPress={onClose} style={{ flex: 1 }} />
          </View>
        </Card>
      </View>
    </Modal>
  );
};
