import React from 'react';
import { Modal, View, TextInput, TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card } from './ui/primitives';

interface RejectionModalProps {
  visible: boolean;
  rejectReason: string;
  onChangeReason: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export const RejectionModal: React.FC<RejectionModalProps> = ({
  visible,
  rejectReason,
  onChangeReason,
  onConfirm,
  onCancel,
}) => {
  const t = useTheme();

  if (!visible) return null;

  const inputStyle: TextStyle = {
    backgroundColor: t.colors.bg,
    borderRadius: t.radius.md,
    borderWidth: 1.5,
    borderColor: t.colors.border,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
    minHeight: 90,
    color: t.colors.text,
    fontSize: 15,
    fontWeight: '500',
    textAlignVertical: 'top',
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={{
        flex: 1,
        backgroundColor: t.colors.scrim,
        justifyContent: 'center',
        padding: t.space.xl,
      }}>
        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl }}>
          <AppText variant="h2">Decline Assignment</AppText>

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">REASON FOR DECLINING</AppText>
            <TextInput
              style={inputStyle}
              placeholder="Provide context for operations..."
              placeholderTextColor={t.colors.textFaint}
              multiline
              value={rejectReason}
              onChangeText={onChangeReason}
            />
          </View>

          <View style={{ flexDirection: 'row', gap: t.space.md, marginTop: t.space.sm }}>
            <Button label="Decline Assignment" variant="danger" icon="close" onPress={onConfirm} style={{ flex: 1 }} />
            <Button label="Cancel" variant="neutral" onPress={onCancel} style={{ flex: 1 }} />
          </View>
        </Card>
      </View>
    </Modal>
  );
};
