import React, { useState } from 'react';
import { Modal, View, TextInput, TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card, Tappable } from './ui/primitives';

type ExpenseCategory = 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER';

export interface ExpenseModalProps {
  visible: boolean;
  expenseCategory?: ExpenseCategory;
  expenseAmount?: string;
  expenseDescription?: string;
  onSelectCategory?: (cat: ExpenseCategory) => void;
  onChangeAmount?: (val: string) => void;
  onChangeDescription?: (val: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  onClose?: () => void;
  onAddExpense?: (category: ExpenseCategory, amount: string, description: string) => void;
}

export const ExpenseModal: React.FC<ExpenseModalProps> = ({
  visible,
  expenseCategory: controlledCat,
  expenseAmount: controlledAmt,
  expenseDescription: controlledDesc,
  onSelectCategory,
  onChangeAmount,
  onChangeDescription,
  onSubmit,
  onCancel,
  onClose,
  onAddExpense,
}) => {
  const t = useTheme();

  if (!visible) return null;

  const [internalCat, setInternalCat] = useState<ExpenseCategory>('TRAVEL_KM');
  const [internalAmt, setInternalAmt] = useState('');
  const [internalDesc, setInternalDesc] = useState('');

  const cat = controlledCat !== undefined ? controlledCat : internalCat;
  const amt = controlledAmt !== undefined ? controlledAmt : internalAmt;
  const desc = controlledDesc !== undefined ? controlledDesc : internalDesc;

  const handleCatSelect = (c: ExpenseCategory) => {
    setInternalCat(c);
    onSelectCategory?.(c);
  };

  const handleAmtChange = (val: string) => {
    setInternalAmt(val);
    onChangeAmount?.(val);
  };

  const handleDescChange = (val: string) => {
    setInternalDesc(val);
    onChangeDescription?.(val);
  };

  const handleSubmit = () => {
    if (onAddExpense) {
      onAddExpense(cat, amt, desc);
    } else {
      onSubmit?.();
    }
  };

  const handleClose = () => {
    if (onClose) {
      onClose();
    } else {
      onCancel?.();
    }
  };

  const inputStyle: TextStyle = {
    backgroundColor: t.colors.bg,
    borderRadius: t.radius.md,
    borderWidth: 1.5,
    borderColor: t.colors.border,
    paddingHorizontal: t.space.lg,
    height: 50,
    color: t.colors.text,
    fontSize: 15,
    fontWeight: '600',
    paddingVertical: 0,
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={{
        flex: 1,
        backgroundColor: t.colors.scrim,
        justifyContent: 'center',
        padding: t.space.xl,
      }}>
        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl }}>
          <AppText variant="h2">Add Travel Expense</AppText>

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">EXPENSE CATEGORY</AppText>
            <View style={{ flexDirection: 'row', gap: t.space.xs, flexWrap: 'wrap' }}>
              {(['TRAVEL_KM', 'TOLL', 'FOOD', 'OTHER'] as const).map((c) => {
                const active = cat === c;
                return (
                  <Tappable key={c} onPress={() => handleCatSelect(c)} style={{ flex: 1, minWidth: 70 }}>
                    <View style={{
                      alignItems: 'center',
                      justifyContent: 'center',
                      paddingVertical: t.space.md,
                      paddingHorizontal: t.space.sm,
                      borderRadius: t.radius.md,
                      backgroundColor: active ? t.colors.primarySoft : t.colors.bg,
                      borderWidth: 1.5,
                      borderColor: active ? t.colors.primary : t.colors.border,
                    }}>
                      <AppText variant="caption" tone={active ? 'primary' : 'faint'}>{c}</AppText>
                    </View>
                  </Tappable>
                );
              })}
            </View>
          </View>

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">AMOUNT (₹)</AppText>
            <TextInput
              style={inputStyle}
              keyboardType="number-pad"
              value={amt}
              onChangeText={handleAmtChange}
              placeholder="e.g. 250"
              placeholderTextColor={t.colors.textFaint}
            />
          </View>

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">DESCRIPTION</AppText>
            <TextInput
              style={inputStyle}
              value={desc}
              onChangeText={handleDescChange}
              placeholder="Reason / notes"
              placeholderTextColor={t.colors.textFaint}
            />
          </View>

          <View style={{ flexDirection: 'row', gap: t.space.md, marginTop: t.space.sm }}>
            <Button label="Submit Expense" icon="checkmark" onPress={handleSubmit} style={{ flex: 1 }} />
            <Button label="Cancel" variant="danger" onPress={handleClose} style={{ flex: 1 }} />
          </View>
        </Card>
      </View>
    </Modal>
  );
};
