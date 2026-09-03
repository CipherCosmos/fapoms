import React, { useEffect, useState } from 'react';
import { Modal, View, TextInput, TextStyle, KeyboardAvoidingView, Platform } from 'react-native';
import { travelModeLabel, formatRupees, describeAssignmentFee, previewFeeChange } from '@fapoms/shared';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card } from './ui/primitives';
import { useT } from '../i18n';

interface NegotiateModalProps {
  visible: boolean;
  currentFee: number;
  /**
   * The travel component inside the offered fee, as the desk's calculator priced it. Shown so
   * the assayer knows what part of the number is meant to cover their journey — travel used to
   * be argued blind, in free-text remarks. Display-only; `currentFee` already contains it.
   */
  quotedTravelFee?: number | null;
  /**
   * The travel currently on the table, once the desk has countered.
   *
   * Without it this sheet re-seeded from the rate card's ORIGINAL quote after a counter, so the
   * assayer was shown — and re-countered against — a number nobody was offering any more.
   */
  counterTravelFee?: number | null;
  quotedTransportMode?: string | null;
  quotedDistanceKm?: number | null;
  onSubmit: (counterTravelFee: number, remarks: string) => void | Promise<void>;
  onCancel: () => void;
}

export const NegotiateModal: React.FC<NegotiateModalProps> = ({
  visible,
  currentFee,
  quotedTravelFee,
  counterTravelFee,
  quotedTransportMode,
  quotedDistanceKm,
  onSubmit,
  onCancel,
}) => {
  const t = useTheme();
  const tr = useT();

  /**
   * Seeded from the TRAVEL component, because travel is what this box asks for.
   *
   * It was seeded from `currentFee`, the whole offered fee — and the value is submitted as
   * `counterTravelFee`, which the server adds to the base fee to compute the new proposal
   * (`assignment.service.ts` proposeCounterFee). So an assayer who opened the sheet and tapped
   * Submit without editing was not repeating the current offer, as the pre-filled number
   * implied: they were asking for base + the entire previous fee again. It also spent a
   * negotiation round to do it, and running out of rounds auto-declines the assignment.
   *
   * Two earlier fixes to this same line went the other way — it once defaulted to a hardcoded
   * ₹1800 — so the rule is worth stating plainly: this input is travel only, and it may only
   * ever be seeded from a travel figure. An empty box asks the question instead of answering it
   * wrongly, which is what happens when the desk quoted no travel at all.
   */
  // Whatever travel is on the table: a counter if one was made, else the rate card's quote.
  const travelOnTable = counterTravelFee ?? quotedTravelFee;
  const [feeText, setFeeText] = useState(
    travelOnTable != null && travelOnTable > 0 ? String(travelOnTable) : '',
  );
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Re-seed each time the sheet opens, so opening it for a second assignment does not carry
  // over the previous one's figure — `useState` only reads its initial value on first mount.
  useEffect(() => {
    if (!visible) return;
    setFeeText(travelOnTable != null && travelOnTable > 0 ? String(travelOnTable) : '');
    setRemarks('');
    setErrorMsg(null);
  }, [visible, travelOnTable]);

  /**
   * Placed after the hooks, not before them.
   *
   * The early return used to sit above every `useState` in this component, so React saw a
   * different number of hooks depending on `visible` — the rules-of-hooks violation that
   * throws "rendered fewer hooks than expected" as soon as the sheet is dismissed.
   */
  if (!visible) return null;

  const handleSubmit = async () => {
    setErrorMsg(null);
    /**
     * `parseRupeeInput`, not `parseFloat`.
     *
     * `parseFloat('1,000')` is 1 — it reads up to the comma and stops. So an assayer countering
     * at one thousand rupees submitted a counter-offer of ₹1, silently and with no error, and the
     * number went straight into the fee that billing later pays against. The expense form had the
     * same flaw with a different ending (it filed ₹0 and reported success); both now share one
     * reading of an amount field.
     */
    /**
     * Zero is a legitimate answer — a branch inside the free commute allowance — and the desk's
     * own form has always accepted it. `parseRupeeInput` returns null for 0 by contract, so
     * leaning on it here made ₹0 un-enterable on the phone: an assayer countering a local branch
     * was told to "enter the travel amount" they had just entered. Parsed through the shared fee
     * model instead, which is the same code the desk uses.
     */
    const preview = previewFeeChange(
      describeAssignmentFee({ proposedFee: currentFee, quotedTravelFee, counterTravelFee }),
      feeText,
    );
    if (preview.travel === null) {
      setErrorMsg(preview.error ?? tr('negotiate.amountRequired'));
      return;
    }
    const parsedFee = preview.travel;
    setLoading(true);
    try {
      await onSubmit(parsedFee, remarks);
    } catch (e: any) {
      setErrorMsg(e?.message || tr('negotiate.submitFailed'));
    } finally {
      setLoading(false);
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
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={{
          flex: 1,
          backgroundColor: t.colors.scrim,
          justifyContent: 'center',
          padding: t.space.xl,
        }}>
        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl }}>
          <AppText variant="h2">{tr('negotiate.title')}</AppText>
          <AppText variant="caption" tone="muted">
            {tr('negotiate.currentFee', { amount: formatRupees(currentFee || 0) })}
          </AppText>
          {quotedTravelFee != null && quotedTravelFee > 0 && (
            <AppText variant="caption" tone="muted">
              {quotedTransportMode
                ? tr('negotiate.includesTravelByMode', {
                    amount: formatRupees(quotedTravelFee),
                    mode: travelModeLabel(quotedTransportMode).toLowerCase(),
                  })
                : tr('negotiate.includesTravel', { amount: formatRupees(quotedTravelFee) })}
              {quotedDistanceKm
                ? ` ${tr('negotiate.aboutDistance', { km: Math.round(Number(quotedDistanceKm)) })}`
                : ''}
            </AppText>
          )}

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">{tr('negotiate.amountLabel')}</AppText>
            <TextInput
              style={inputStyle}
              keyboardType="number-pad"
              value={feeText}
              onChangeText={setFeeText}
              placeholder={tr('negotiate.amountPlaceholder')}
              placeholderTextColor={t.colors.textFaint}
            />
          </View>

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">{tr('negotiate.remarksLabel')}</AppText>
            <TextInput
              style={[inputStyle, { height: 80, paddingVertical: t.space.md, textAlignVertical: 'top' }]}
              value={remarks}
              onChangeText={setRemarks}
              placeholder={tr('negotiate.remarksPlaceholder')}
              placeholderTextColor={t.colors.textFaint}
              multiline
            />
          </View>

          {errorMsg ? (
            <AppText variant="caption" tone="danger">{errorMsg}</AppText>
          ) : null}

          <View style={{ flexDirection: 'row', gap: t.space.md, marginTop: t.space.sm }}>
            <Button label={loading ? tr('negotiate.submitting') : tr('negotiate.submit')} icon="cash-outline" onPress={handleSubmit} loading={loading} style={{ flex: 1 }} />
            <Button label={tr('common.cancel')} variant="neutral" onPress={onCancel} style={{ flex: 1 }} />
          </View>
        </Card>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};
