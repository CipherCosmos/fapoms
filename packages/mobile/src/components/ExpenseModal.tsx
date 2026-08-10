import React, { useEffect, useState } from 'react';
import { Modal, View, TextInput, TextStyle, KeyboardAvoidingView, Platform } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card, Tappable } from './ui/primitives';

type ExpenseCategory = 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER';

/** Human-readable labels — the raw enum values were being shown to field users. */
export const CAT_LABELS: Record<ExpenseCategory, string> = {
  TRAVEL_KM: 'Travel (km)',
  TOLL: 'Toll',
  FOOD: 'Food',
  OTHER: 'Other',
};

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
  onAddExpense?: (category: ExpenseCategory, amount: string, description: string) => void | Promise<void>;
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

  const [internalCat, setInternalCat] = useState<ExpenseCategory>('TRAVEL_KM');
  const [internalAmt, setInternalAmt] = useState('');
  const [internalDesc, setInternalDesc] = useState('');
  const [busy, setBusy] = useState(false);

  // Clear the form each time the sheet opens, so a claim is never pre-filled with the
  // previous one's amount and silently filed against a different assignment.
  useEffect(() => {
    if (!visible) return;
    setInternalCat('TRAVEL_KM');
    setInternalAmt('');
    setInternalDesc('');
    setBusy(false);
  }, [visible]);

  /**
   * After the hooks, not before.
   *
   * The early return sat above these `useState` calls, so React saw a different hook count
   * depending on `visible` — "rendered fewer hooks than expected" the moment the sheet closed.
   */
  if (!visible) return null;

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

  const amountValue = parseFloat(amt);
  const amountValid = !Number.isNaN(amountValue) && amountValue > 0;

  const handleSubmit = async () => {
    // Block empty/zero claims and double-taps; the parent only validated the assignment.
    if (!amountValid || busy) return;
    setBusy(true);
    try {
      if (onAddExpense) {
        // Awaited so the button un-freezes on failure. On success the parent closes the sheet
        // and this is a no-op; but a rejected claim or a "no assignment selected" early-return
        // left the sheet open with `busy` stuck true forever — a permanently spinning, unusable
        // Submit that the previous fire-and-forget call could not recover from.
        await onAddExpense(cat, amt, desc);
      } else {
        onSubmit?.();
      }
    } finally {
      setBusy(false);
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
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={{
          flex: 1,
          backgroundColor: t.colors.scrim,
          justifyContent: 'center',
          padding: t.space.xl,
        }}>
        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl }}>
          <AppText variant="h2">Log an expense</AppText>

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
                      <AppText variant="caption" tone={active ? 'primary' : 'faint'}>{CAT_LABELS[c]}</AppText>
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
            <Button label="Submit Expense" icon="checkmark" onPress={handleSubmit} loading={busy} disabled={!amountValid || busy} style={{ flex: 1 }} />
            <Button label="Cancel" variant="neutral" onPress={handleClose} style={{ flex: 1 }} />
          </View>
        </Card>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};
