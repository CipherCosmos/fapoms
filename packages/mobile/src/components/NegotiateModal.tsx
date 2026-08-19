import React, { useEffect, useState } from 'react';
import { Modal, View, TextInput, TextStyle, KeyboardAvoidingView, Platform } from 'react-native';
import { travelModeLabel, parseRupeeInput, formatRupees } from '@fapoms/shared';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card } from './ui/primitives';

interface NegotiateModalProps {
  visible: boolean;
  currentFee: number;
  /**
   * The travel component inside the offered fee, as the desk's calculator priced it. Shown so
   * the assayer knows what part of the number is meant to cover their journey — travel used to
   * be argued blind, in free-text remarks. Display-only; `currentFee` already contains it.
   */
  quotedTravelFee?: number | null;
  quotedTransportMode?: string | null;
  quotedDistanceKm?: number | null;
  onSubmit: (counterFee: number, remarks: string) => void | Promise<void>;
  onCancel: () => void;
}

export const NegotiateModal: React.FC<NegotiateModalProps> = ({
  visible,
  currentFee,
  quotedTravelFee,
  quotedTransportMode,
  quotedDistanceKm,
  onSubmit,
  onCancel,
}) => {
  const t = useTheme();

  /**
   * Seeded from the assignment's own fee, never from an invented figure.
   *
   * This defaulted to `currentFee || 1800`. An assignment whose fee had not been resolved yet
   * pre-filled the counter-offer box with ₹1800 — a number that appears nowhere in the fee
   * policy — and an assayer who tapped submit without editing sent that to Operations as
   * their asking price. An empty box asks the question instead of answering it wrongly.
   */
  const [feeText, setFeeText] = useState(currentFee > 0 ? String(currentFee) : '');
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Re-seed each time the sheet opens, so opening it for a second assignment does not carry
  // over the previous one's figure — `useState` only reads its initial value on first mount.
  useEffect(() => {
    if (!visible) return;
    setFeeText(currentFee > 0 ? String(currentFee) : '');
    setRemarks('');
    setErrorMsg(null);
  }, [visible, currentFee]);

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
    const parsedFee = parseRupeeInput(feeText);
    if (parsedFee === null) {
      setErrorMsg('Please enter a valid counter-offer fee amount.');
      return;
    }
    setLoading(true);
    try {
      await onSubmit(parsedFee, remarks);
    } catch (e: any) {
      setErrorMsg(e?.message || 'Failed to submit counter-offer.');
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
          <AppText variant="h2">Negotiate Audit Fee</AppText>
          <AppText variant="caption" tone="muted">
            Current Offered Fee: {formatRupees(currentFee || 0)}
          </AppText>
          {quotedTravelFee != null && quotedTravelFee > 0 && (
            <AppText variant="caption" tone="muted">
              Includes {formatRupees(quotedTravelFee)} for travel
              {quotedTransportMode ? ` by ${travelModeLabel(quotedTransportMode).toLowerCase()}` : ''}
              {quotedDistanceKm ? ` (~${Math.round(Number(quotedDistanceKm))} km each way)` : ''}
            </AppText>
          )}

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">PROPOSED COUNTER FEE (₹)</AppText>
            <TextInput
              style={inputStyle}
              keyboardType="number-pad"
              value={feeText}
              onChangeText={setFeeText}
              placeholder="e.g. 2200"
              placeholderTextColor={t.colors.textFaint}
            />
          </View>

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">REASON / REMARKS (OPTIONAL)</AppText>
            <TextInput
              style={[inputStyle, { height: 80, paddingVertical: t.space.md, textAlignVertical: 'top' }]}
              value={remarks}
              onChangeText={setRemarks}
              placeholder="e.g. Long-distance travel allowance required"
              placeholderTextColor={t.colors.textFaint}
              multiline
            />
          </View>

          {errorMsg ? (
            <AppText variant="caption" tone="danger">{errorMsg}</AppText>
          ) : null}

          <View style={{ flexDirection: 'row', gap: t.space.md, marginTop: t.space.sm }}>
            <Button label={loading ? 'Submitting…' : 'Submit Counter'} icon="cash-outline" onPress={handleSubmit} loading={loading} style={{ flex: 1 }} />
            <Button label="Cancel" variant="neutral" onPress={onCancel} style={{ flex: 1 }} />
          </View>
        </Card>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};
