import React, { useState } from 'react';
import { View, TextInput, ScrollView, KeyboardAvoidingView, Platform, TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card, Icon } from '../components/ui/primitives';
import { MobileApiService } from '../services/api.service';

/**
 * Forced password change.
 *
 * Shown instead of the app when the signed-in account still holds a password somebody else
 * chose — a seeded credential or an HR reset. It is deliberately not skippable: this
 * deployment shipped with 24 assayers sharing one password, and an optional prompt would
 * simply be dismissed by everyone, leaving the shared credential in place indefinitely.
 *
 * Sign-out remains available so nobody is trapped if they cannot complete the change.
 */

interface Props {
  /** Cleared on success so the app can proceed. */
  onChanged: () => void;
  onLogout: () => void;
}

const MIN_LENGTH = 8;

export const ChangePasswordScreen: React.FC<Props> = ({ onChanged, onLogout }) => {
  const t = useTheme();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const inputWrap = (isFocused: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: t.space.md,
    backgroundColor: t.colors.bg,
    borderRadius: t.radius.md,
    borderWidth: 1.5,
    borderColor: isFocused ? t.colors.primary : t.colors.border,
    paddingHorizontal: t.space.lg,
    height: 54,
  });

  const inputStyle: TextStyle = {
    flex: 1,
    color: t.colors.text,
    fontSize: 15,
    fontWeight: '600',
    paddingVertical: 0,
  };

  const submit = async () => {
    setError(null);

    // Checked here as well as on the server so the person gets the answer immediately rather
    // than after a round trip on a weak field connection.
    if (!currentPassword || !newPassword) {
      setError('Enter your current password and choose a new one.');
      return;
    }
    if (newPassword.length < MIN_LENGTH) {
      setError(`Your new password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Your new password must be different from the current one.');
      return;
    }

    setBusy(true);
    try {
      const res = await MobileApiService.changeOwnPassword(currentPassword, newPassword);
      if (!res.success) {
        setError(res.error || 'Could not change your password. Please try again.');
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: t.space.xl, gap: t.space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: 'center', gap: t.space.sm }}>
          <Icon name="lock-closed" size={34} color={t.colors.primary} />
          <AppText variant="h2" style={{ textAlign: 'center' }}>Choose your own password</AppText>
          <AppText variant="small" tone="muted" style={{ textAlign: 'center' }}>
            Your account is still using a password that was issued to you. Set one only you
            know before continuing.
          </AppText>
        </View>

        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl }}>
          <View style={{ gap: t.space.sm }}>
            <AppText variant="overline" tone="faint">CURRENT PASSWORD</AppText>
            <View style={inputWrap(focused === 'cur')}>
              <Icon name="key-outline" size={18} color={focused === 'cur' ? t.colors.primary : t.colors.textFaint} />
              <TextInput
                value={currentPassword}
                onChangeText={setCurrentPassword}
                onFocus={() => setFocused('cur')}
                onBlur={() => setFocused(null)}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={inputStyle}
              />
            </View>
          </View>

          <View style={{ gap: t.space.sm }}>
            <AppText variant="overline" tone="faint">NEW PASSWORD</AppText>
            <View style={inputWrap(focused === 'new')}>
              <Icon name="lock-closed-outline" size={18} color={focused === 'new' ? t.colors.primary : t.colors.textFaint} />
              <TextInput
                value={newPassword}
                onChangeText={setNewPassword}
                onFocus={() => setFocused('new')}
                onBlur={() => setFocused(null)}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={inputStyle}
              />
            </View>
            <AppText variant="caption" tone="faint">At least {MIN_LENGTH} characters.</AppText>
          </View>

          <View style={{ gap: t.space.sm }}>
            <AppText variant="overline" tone="faint">CONFIRM NEW PASSWORD</AppText>
            <View style={inputWrap(focused === 'conf')}>
              <Icon name="checkmark-circle-outline" size={18} color={focused === 'conf' ? t.colors.primary : t.colors.textFaint} />
              <TextInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                onFocus={() => setFocused('conf')}
                onBlur={() => setFocused(null)}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={inputStyle}
                onSubmitEditing={submit}
              />
            </View>
          </View>

          {error ? (
            <View style={{ backgroundColor: t.colors.dangerSoft, padding: t.space.md, borderRadius: t.radius.md }}>
              <AppText variant="caption" style={{ color: t.colors.danger, textAlign: 'center' }}>{error}</AppText>
            </View>
          ) : null}

          <Button label={busy ? 'Saving…' : 'Set password'} onPress={submit} loading={busy} size="lg" full />
        </Card>

        <Button label="Sign out" variant="ghost" onPress={onLogout} full />
      </ScrollView>
    </KeyboardAvoidingView>
  );
};
