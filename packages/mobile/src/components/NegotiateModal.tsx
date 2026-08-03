import React, { useState } from 'react';
import { Modal, View, TextInput, TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card } from './ui/primitives';

interface NegotiateModalProps {
  visible: boolean;
  currentFee: number;
  onSubmit: (counterFee: number, remarks: string) => void | Promise<void>;
  onCancel: () => void;
}

export const NegotiateModal: React.FC<NegotiateModalProps> = ({
  visible,
  currentFee,
  onSubmit,
  onCancel,
}) => {
  const t = useTheme();

  if (!visible) return null;

  const [feeText, setFeeText] = useState(String(currentFee || 1800));
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async () => {
    setErrorMsg(null);
    const parsedFee = parseFloat(feeText);
    if (isNaN(parsedFee) || parsedFee <= 0) {
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
      <View style={{
        flex: 1,
        backgroundColor: t.colors.scrim,
        justifyContent: 'center',
        padding: t.space.xl,
      }}>
        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl }}>
          <AppText variant="h2">Negotiate Audit Fee</AppText>
          <AppText variant="caption" tone="muted">
            Current Offered Fee: ₹{(currentFee || 0).toLocaleString('en-IN')}
          </AppText>

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
    </Modal>
  );
};
