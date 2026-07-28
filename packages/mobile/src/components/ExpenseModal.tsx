import React from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity } from 'react-native';
import { styles } from '../theme/styles';

interface ExpenseModalProps {
  visible: boolean;
  expenseCategory: 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER';
  expenseAmount: string;
  expenseDescription: string;
  onSelectCategory: (cat: 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER') => void;
  onChangeAmount: (val: string) => void;
  onChangeDescription: (val: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export const ExpenseModal: React.FC<ExpenseModalProps> = ({
  visible,
  expenseCategory,
  expenseAmount,
  expenseDescription,
  onSelectCategory,
  onChangeAmount,
  onChangeDescription,
  onSubmit,
  onCancel,
}) => {
  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Add Travel Expense</Text>

          <Text style={styles.inputLabel}>Expense Category:</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
            {(['TRAVEL_KM', 'TOLL', 'FOOD', 'OTHER'] as const).map((cat) => (
              <TouchableOpacity
                key={cat}
                style={[styles.catBtn, expenseCategory === cat && styles.catBtnActive]}
                onPress={() => onSelectCategory(cat)}
              >
                <Text style={expenseCategory === cat ? styles.btnTextWhite : styles.btnTextDark}>{cat}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.inputLabel}>Amount (₹):</Text>
          <TextInput style={styles.textInput} keyboardType="number-pad" value={expenseAmount} onChangeText={onChangeAmount} />

          <Text style={styles.inputLabel}>Description:</Text>
          <TextInput style={styles.textInput} value={expenseDescription} onChangeText={onChangeDescription} />

          <View style={styles.actionGrid}>
            <TouchableOpacity style={styles.saveBtn} onPress={onSubmit}>
              <Text style={styles.btnTextWhite}>Submit Expense</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.rejectBtn} onPress={onCancel}>
              <Text style={styles.btnTextWhite}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};
