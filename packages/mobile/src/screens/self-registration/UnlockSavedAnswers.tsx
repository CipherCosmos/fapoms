import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Button, Card, Icon, Input } from '../../components/ui/primitives';
import { useT, serverErrorText } from '../../i18n';
import { SelfRegistrationApi } from '../../services/self-registration.service';
import { otpSentWords, resendCooldownSeconds } from './otp-delivery';

/**
 * CONFIRM IT IS YOU, THEN SEE WHAT YOU SAVED.
 *
 * Shown instead of the form when the server withheld the saved answers (`sensitiveLocked`): a link
 * on its own shows progress, never the PAN, the account number or the scans. The code goes to the
 * number already on the application — the server refuses any other while answers are on file — and
 * a right code mints the session key the service keeps and sends from then on; `onUnlocked`
 * reloads the form, now with what they had saved. Same flow as the web page's unlock screen.
 */
export const UnlockSavedAnswers: React.FC<{
  token: string;
  mobile: string;
  email: string | null;
  onUnlocked: () => void;
}> = ({ token, mobile, email, onUnlocked }) => {
  const t = useTheme();
  const tr = useT();
  const [sent, setSent] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const last4 = mobile.replace(/\D/g, '').slice(-4);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const send = async () => {
    setError(null);
    setBusy(true);
    const res = await SelfRegistrationApi.requestOtp(token, mobile);
    setBusy(false);
    if (!res.success) {
      setError(serverErrorText(res.error, 'selfRegistration.otp.sendFailedTitle', res.code));
      return;
    }
    const words = otpSentWords(res.data, email, tr('selfRegistration.otp.yourEmail'));
    setInfo(tr(words.key, words.vars));
    setSent(true);
    setCooldown(resendCooldownSeconds(res.data));
  };

  const verify = async () => {
    setError(null);
    const entered = code.trim();
    if (!/^\d{6}$/.test(entered)) {
      setError(tr('selfRegistration.otp.missingCode'));
      return;
    }
    setBusy(true);
    const res = await SelfRegistrationApi.verifyOtp(token, mobile, entered);
    setBusy(false);
    if (!res.success) {
      setError(serverErrorText(res.error, 'selfRegistration.otp.verifyFailedTitle', res.code));
      return;
    }
    setCode('');
    onUnlocked();
  };

  return (
    <Card level={2} style={{ gap: t.space.md, padding: t.space.xl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Icon name="shield-checkmark-outline" size={22} color={t.colors.primary} />
        <AppText variant="h3" style={{ flex: 1 }}>{tr('selfRegistration.unlock.title')}</AppText>
      </View>
      <AppText variant="small" tone="muted">{tr('selfRegistration.unlock.body', { last4: last4 || '—' })}</AppText>
      {info ? <AppText variant="small">{info}</AppText> : null}
      {error ? <AppText variant="small" tone="danger">{error}</AppText> : null}
      {sent ? (
        <>
          <Input
            label={tr('selfRegistration.otp.codeLabel')}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            placeholder={tr('selfRegistration.otp.codePlaceholder')}
            keyboardType="number-pad"
          />
          <Button label={tr('selfRegistration.unlock.continue')} icon="lock-open-outline" onPress={verify} loading={busy} disabled={busy} full />
          <Button
            label={cooldown > 0 ? tr('selfRegistration.otp.resendIn', { time: `${cooldown}s` }) : tr('selfRegistration.otp.resendCode')}
            variant="ghost"
            onPress={send}
            disabled={busy || cooldown > 0}
            full
          />
        </>
      ) : (
        <Button label={tr('selfRegistration.otp.sendCode')} icon="send-outline" onPress={send} loading={busy} disabled={busy || cooldown > 0} full />
      )}
    </Card>
  );
};
