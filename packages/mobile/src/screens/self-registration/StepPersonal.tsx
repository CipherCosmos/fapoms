import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { REGISTRATION_FIELD_LIMITS, REGISTRATION_GENDERS, normalisePhone } from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Badge, Button, Card, ChipSelector, FieldLabel, Icon, Input, Tappable } from '../../components/ui/primitives';
import { useT, serverErrorText, type TranslationKey } from '../../i18n';
import { SelfRegistrationApi } from '../../services/self-registration.service';
import { FieldNote, GroupHeader, StepFooter } from './parts';
import {
  OTP_BEFORE_SEND, formatCountdown, otpSentWords, resendCooldownSeconds, waitSecondsFromRefusal,
} from './otp-delivery';
import { DateOfBirthPicker } from './DateOfBirthPicker';
import type { StepProps } from './types';

const GENDER_LABELS: Record<typeof REGISTRATION_GENDERS[number], TranslationKey> = {
  Male: 'selfRegistration.form.genderMale',
  Female: 'selfRegistration.form.genderFemale',
  Other: 'selfRegistration.form.genderOther',
  'Prefer not to say': 'selfRegistration.form.genderPreferNot',
};

export interface StepPersonalProps extends StepProps {
  /** The invite's address — where the code is emailed when the server cannot text it. */
  email: string | null;
  phone: string;
  setPhone: (phone: string) => void;
  otpVerified: boolean;
  onVerified: (phone: string) => void;
  /** Set when a save came back saying the verification has lapsed. */
  verificationNote: string | null;
  onContinue: () => void;
}

export const StepPersonal: React.FC<StepPersonalProps> = (props) => {
  const t = useTheme();
  const tr = useT();
  const { form, errors, setField, commitField, pickField } = props;

  return (
    <View style={{ gap: t.space.lg }}>
      <PhoneVerification {...props} />

      <Card level={1} style={{ gap: t.space.lg }}>
        <GroupHeader
          icon="person-outline"
          title={tr('selfRegistration.form.identityTitle')}
          note={tr('selfRegistration.form.identityNote')}
        />
        <Input
          label={tr('selfRegistration.form.fullName')}
          value={form.fullName}
          onChangeText={(v) => setField('fullName', v)}
          onBlur={() => commitField('fullName')}
          placeholder={tr('selfRegistration.form.fullNamePlaceholder')}
          autoCapitalize="words"
          maxLength={REGISTRATION_FIELD_LIMITS.fullName}
          error={errors.fullName}
        />
        <DateOfBirthPicker
          value={form.dateOfBirth}
          error={errors.dateOfBirth}
          onComplete={(iso) => pickField('dateOfBirth', iso)}
          onIncomplete={() => setField('dateOfBirth', '')}
        />
        <Input
          label={tr('selfRegistration.form.email')}
          value={form.email}
          onChangeText={(v) => setField('email', v)}
          onBlur={() => commitField('email')}
          placeholder={tr('selfRegistration.form.emailPlaceholder')}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={REGISTRATION_FIELD_LIMITS.email}
          error={errors.email}
        />
        <View style={{ gap: t.space.sm }}>
          <FieldLabel>{tr('selfRegistration.form.gender')}</FieldLabel>
          <ChipSelector
            options={REGISTRATION_GENDERS.map((g) => ({ key: g, label: tr(GENDER_LABELS[g]) }))}
            value={form.gender || null}
            onChange={(g) => pickField('gender', g)}
          />
        </View>
      </Card>

      <StepFooter onContinue={props.onContinue} />
    </View>
  );
};

/**
 * Confirming the number. The code is texted to the number typed here when the server has SMS set up,
 * and emailed to the invite's address otherwise — the server says which. The number is the one that
 * goes on the record, so it is checked against the roster before any code is sent.
 */
const PhoneVerification: React.FC<StepPersonalProps> = ({
  token, email, phone, setPhone, otpVerified, onVerified, verificationNote, save,
}) => {
  const t = useTheme();
  const tr = useT();
  const [codeSent, setCodeSent] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<TextInput>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  useEffect(() => {
    if (verificationNote) {
      setCodeSent(false);
      setSentTo(null);
      setError(verificationNote);
    }
  }, [verificationNote]);

  useEffect(() => {
    if (codeSent && !otpVerified) codeRef.current?.focus();
  }, [codeSent, otpVerified]);

  const typed = normalisePhone(phone) ?? phone.trim();
  const looksWrong = phone.replace(/\D/g, '').length >= 10 && normalisePhone(phone) === null;

  /** The server's own sentence when the number is taken, or null when it is free (or unchecked). */
  const checkConflict = useCallback(async (number: string): Promise<string | null> => {
    setChecking(true);
    const res = await SelfRegistrationApi.checkPhone(token, number);
    setChecking(false);
    const message = res.success && res.data?.conflict
      ? (res.data.message ?? tr('selfRegistration.otp.conflictFallback'))
      : null;
    setConflict(message);
    return message;
  }, [token, tr]);

  const handleBlur = async () => {
    if (typed !== phone) setPhone(typed);
    const number = normalisePhone(typed);
    if (!number) return;
    if (await checkConflict(number)) return;
    save({ mobile: number });
  };

  const handleSend = async () => {
    setError(null);
    setInfo(null);
    const number = normalisePhone(typed);
    if (!number) {
      setError(tr('selfRegistration.otp.missingPhone'));
      return;
    }
    if (number !== phone) setPhone(number);
    setBusy(true);
    try {
      if (await checkConflict(number)) return;
      const res = await SelfRegistrationApi.requestOtp(token, number);
      if (!res.success) {
        setError(serverErrorText(res.error, 'selfRegistration.otp.sendFailedTitle', res.code));
        // "Please wait 42 seconds…" — count down from the server's own number.
        const wait = waitSecondsFromRefusal(res.error);
        if (wait) setCooldown(wait);
        return;
      }
      setCodeSent(true);
      setSentTo(number);
      setCode('');
      setCooldown(resendCooldownSeconds(res.data));
      const words = otpSentWords(res.data, email, tr('selfRegistration.otp.yourEmail'));
      setInfo(tr(words.key, words.vars));
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (entered: string) => {
    setError(null);
    if (entered.length !== 6) {
      setError(tr('selfRegistration.otp.missingCode'));
      return;
    }
    const number = sentTo ?? normalisePhone(typed) ?? typed;
    if (normalisePhone(typed) !== number) {
      setError(tr('selfRegistration.otp.codeForOtherNumber', { sent: number, now: typed }));
      return;
    }
    setBusy(true);
    const res = await SelfRegistrationApi.verifyOtp(token, number, entered);
    setBusy(false);
    if (!res.success) {
      setError(serverErrorText(res.error, 'selfRegistration.otp.verifyFailedTitle', res.code));
      return;
    }
    setInfo(null);
    onVerified(number);
  };

  return (
    <Card level={2} style={{ gap: t.space.md, padding: t.space.xl, borderRadius: t.radius['2xl'] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Icon name="call-outline" size={18} color={t.colors.primary} />
        <AppText variant="h3" style={{ flex: 1 }}>{tr('selfRegistration.otp.title')}</AppText>
        {otpVerified && <Badge label={tr('selfRegistration.otp.verified')} tone="success" icon="checkmark" />}
      </View>

      {otpVerified ? (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
          backgroundColor: t.colors.successSoft, borderRadius: t.radius.lg, padding: t.space.md,
        }}>
          <Icon name="checkmark-circle" size={20} color={t.colors.success} />
          <AppText variant="bodyStrong" tone="success" style={{ flex: 1 }}>
            {tr('selfRegistration.otp.verifiedBody', { phone })}
          </AppText>
        </View>
      ) : (
        <>
          <AppText variant="small" tone="muted">
            {tr(OTP_BEFORE_SEND.key, OTP_BEFORE_SEND.vars)}
          </AppText>
          <Input
            label={tr('selfRegistration.otp.phoneLabel')}
            value={phone}
            onChangeText={(v) => {
              setPhone(v);
              if (conflict) setConflict(null);
              if (error) setError(null);
            }}
            onBlur={() => { void handleBlur(); }}
            placeholder={tr('selfRegistration.otp.phonePlaceholder')}
            prefix="+91"
            keyboardType="phone-pad"
            autoCapitalize="none"
            maxLength={16}
            hint={checking ? tr('selfRegistration.otp.checking') : undefined}
            error={looksWrong ? tr('selfRegistration.errors.phoneInvalid') : (conflict ?? undefined)}
          />

          {!codeSent ? (
            <Button
              label={tr('selfRegistration.otp.sendCode')}
              icon="mail-outline"
              onPress={() => { void handleSend(); }}
              loading={busy || checking}
              disabled={Boolean(conflict) || looksWrong}
              full
            />
          ) : (
            <>
              {sentTo && (
                <AppText variant="caption" tone="muted">
                  {tr('selfRegistration.otp.sentFor', { phone: sentTo })}
                  {normalisePhone(typed) !== sentTo ? ` — ${tr('selfRegistration.otp.numberChanged')}` : ''}
                </AppText>
              )}
              <Input
                inputRef={codeRef}
                label={tr('selfRegistration.otp.codeLabel')}
                value={code}
                onChangeText={(v) => {
                  const next = v.replace(/\D/g, '').slice(0, 6);
                  setCode(next);
                  if (error) setError(null);
                  // Six digits is the whole answer, so a pasted or typed code verifies itself.
                  if (next.length === 6 && !busy) void handleVerify(next);
                }}
                placeholder={tr('selfRegistration.otp.codePlaceholder')}
                keyboardType="number-pad"
                autoCapitalize="none"
                maxLength={6}
                size="lg"
              />
              <Button
                label={tr('selfRegistration.otp.verify')}
                onPress={() => { void handleVerify(code); }}
                loading={busy}
                full
              />
              <Tappable
                onPress={() => { void handleSend(); }}
                disabled={cooldown > 0 || busy || checking || Boolean(conflict)}
                accessibilityRole="link"
                accessibilityLabel={tr('selfRegistration.otp.resendCode')}
                hitSlop={12}
              >
                <AppText
                  variant="small"
                  tone={cooldown > 0 ? 'faint' : 'primary'}
                  style={{ textAlign: 'center', fontWeight: '700', paddingVertical: t.space.xs, textDecorationLine: cooldown > 0 ? 'none' : 'underline' }}
                >
                  {cooldown > 0
                    ? tr('selfRegistration.otp.resendIn', { time: formatCountdown(cooldown) })
                    : tr('selfRegistration.otp.resendCode')}
                </AppText>
              </Tappable>
            </>
          )}

          {info && <FieldNote text={info} />}
          {error && <FieldNote text={error} tone="danger" />}
        </>
      )}
    </Card>
  );
};
