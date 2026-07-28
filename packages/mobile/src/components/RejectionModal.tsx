import React from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity } from 'react-native';
import { styles } from '../theme/styles';

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
  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Reject Assignment</Text>
          <Text style={[styles.inputLabel, { marginBottom: 8 }]}>Reason for rejection:</Text>
          <TextInput
            style={[styles.textInput, { minHeight: 80 }]}
            placeholder="Enter reason..."
            placeholderTextColor="#475569"
            multiline
            value={rejectReason}
            onChangeText={onChangeReason}
          />
          <View style={[styles.actionGrid, { marginTop: 18 }]}>
            <TouchableOpacity style={[styles.rejectBtn, { flex: 1, borderRadius: 12, paddingVertical: 14 }]} onPress={onConfirm}>
              <Text style={styles.btnTextWhite}>Confirm Rejection</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.mapBtn, { flex: 1, borderRadius: 12, paddingVertical: 14 }]} onPress={onCancel}>
              <Text style={styles.btnTextWhite}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};
