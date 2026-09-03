import React, { useEffect, useState } from 'react';
import { Modal, View, TextInput, TextStyle, KeyboardAvoidingView, Platform } from 'react-native';
import { travelModeLabel, parseRupeeInput, formatRupees } from '@fapoms/shared';
import { useTheme } from '../theme/ThemeProvider';
import { MobileApiService } from '../services/api.service';
import { AppText, Button, Card, Tappable } from './ui/primitives';
import { useT, type TranslationKey } from '../i18n';

export type ExpenseCategory = 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER';

/**
 * Catalogue keys rather than finished labels, so the four categories read the same wherever
 * they surface — this picker, the claim-filed toast, and the Earnings list — in whichever
 * language is active. A `Record` of plain strings could not do that: it is built once, at
 * module load, before the assayer has chosen a language.
 */
export const CAT_LABEL_KEYS = {
  TRAVEL_KM: 'expense.categories.travelKm',
  TOLL: 'expense.categories.toll',
  FOOD: 'expense.categories.food',
  OTHER: 'expense.categories.other',
} as const satisfies Record<ExpenseCategory, TranslationKey>;

export interface ExpenseModalProps {
  visible: boolean;
  expenseCategory?: ExpenseCategory;
  expenseAmount?: string;
  expenseDescription?: string;
  /**
   * The travel money already inside the assignment's agreed fee, as the desk's calculator
   * priced it. Shown as context on a TRAVEL_KM claim so the assayer knows what the fee was
   * already meant to cover before claiming on top of it. Never pre-filled into the amount —
   * a claim is the assayer's own statement, not a suggestion accepted by inertia.
   */
  quotedTravelFee?: number | null;
  quotedTransportMode?: string | null;
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
  quotedTravelFee,
  quotedTransportMode,
  onSelectCategory,
  onChangeAmount,
  onChangeDescription,
  onSubmit,
  onCancel,
  onClose,
  onAddExpense,
}) => {
  const t = useTheme();
  const tr = useT();

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

  // The same parse the submit uses. These were two different readings of one string — `parseFloat`
  // here, `Number` at the call site — and they disagreed on exactly the input an Indian user is
  // most likely to type: "1,000" validated as 1 and submitted as NaN. See `parseRupeeInput`.
  const amountValue = parseRupeeInput(amt);

  /**
   * The platform's own ceiling on a single claim, checked here rather than only at the server.
   *
   * `getPlatformLimits` already fetched `maxSingleExpenseClaim` and nothing read it, so an
   * over-limit claim was typed out in full, submitted, and refused on the round trip — in the
   * field, on a phone, often on a slow connection. The number is configurable per deployment
   * (Administration → Platform Settings), so it is asked for rather than hardcoded, and a failed
   * lookup falls back to the same default the server registry ships.
   *
   * The server still enforces it; this only means the assayer finds out while they are looking
   * at the form.
   */
  const [maxClaim, setMaxClaim] = useState<number | null>(null);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    MobileApiService.getPlatformLimits()
      .then((l) => { if (live) setMaxClaim(l.maxSingleExpenseClaim ?? null); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [visible]);

  const overLimit = amountValue !== null && maxClaim !== null && amountValue > maxClaim;
  const amountValid = amountValue !== null && !overLimit;

  const handleSubmit = async () => {
    // Block empty/zero claims, over-limit claims, and double-taps; the parent only validated the
    // assignment.
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
          <AppText variant="h2">{tr('expense.title')}</AppText>

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">{tr('expense.categoryLabel')}</AppText>
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
                      <AppText variant="caption" tone={active ? 'primary' : 'faint'}>{tr(CAT_LABEL_KEYS[c])}</AppText>
                    </View>
                  </Tappable>
                );
              })}
            </View>
          </View>

          {cat === 'TRAVEL_KM' && quotedTravelFee != null && quotedTravelFee > 0 && (
            <AppText variant="small" tone="muted">
              {quotedTransportMode
                ? tr('expense.quotedIncludedByMode', {
                    amount: formatRupees(Number(quotedTravelFee)),
                    mode: travelModeLabel(quotedTransportMode).toLowerCase(),
                  })
                : tr('expense.quotedIncluded', { amount: formatRupees(Number(quotedTravelFee)) })}
            </AppText>
          )}

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">{tr('expense.amountLabel')}</AppText>
            <TextInput
              style={inputStyle}
              keyboardType="number-pad"
              value={amt}
              onChangeText={handleAmtChange}
              placeholder={tr('expense.amountPlaceholder')}
              placeholderTextColor={t.colors.textFaint}
            />
            {/*
              Said before it is needed, and again when it is exceeded. A ceiling the assayer only
              discovers by having a filled-in claim rejected is a ceiling they meet at the worst
              possible moment.
            */}
            {overLimit ? (
              <AppText variant="small" tone="danger">
                {tr('expense.overLimit', { limit: formatRupees(Number(maxClaim)) })}
              </AppText>
            ) : maxClaim !== null ? (
              <AppText variant="small" tone="faint">
                {tr('expense.limitHint', { limit: formatRupees(Number(maxClaim)) })}
              </AppText>
            ) : null}
          </View>

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">{tr('expense.descriptionLabel')}</AppText>
            <TextInput
              style={inputStyle}
              value={desc}
              onChangeText={handleDescChange}
              placeholder={tr('expense.descriptionPlaceholder')}
              placeholderTextColor={t.colors.textFaint}
            />
          </View>

          <View style={{ flexDirection: 'row', gap: t.space.md, marginTop: t.space.sm }}>
            <Button label={tr('expense.submit')} icon="checkmark" onPress={handleSubmit} loading={busy} disabled={!amountValid || busy} style={{ flex: 1 }} />
            <Button label={tr('common.cancel')} variant="neutral" onPress={handleClose} style={{ flex: 1 }} />
          </View>
        </Card>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};
