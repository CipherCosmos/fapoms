import React, { useRef, useState } from 'react';
import { View, TextInput, ScrollView, KeyboardAvoidingView, Platform, TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card, Icon, Tappable } from '../components/ui/primitives';
import { MobileApiService } from '../services/api.service';
import * as haptics from '../lib/haptics';

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
  /**
   * Dismiss without changing anything.
   *
   * Supplied only by the voluntary route (Profile → Security → Change password). The forced
   * route omits it, because there the whole point is that the session cannot continue on an
   * issued password — and "Sign out" is then the honest way out.
   *
   * Without this, opening the screen to look and thinking better of it would sign the assayer
   * out, since that was the only exit on the screen.
   */
  onCancel?: () => void;
}

const MIN_LENGTH = 8;

/** One live-checked rule. Faint and unchecked until met, so the list doesn't read as a wall of errors before typing starts. */
const RuleRow: React.FC<{ ok: boolean; label: string }> = ({ ok, label }) => {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Icon name={ok ? 'checkmark-circle' : 'ellipse-outline'} size={13} color={ok ? t.colors.success : t.colors.textFaint} />
      <AppText variant="caption" tone={ok ? 'success' : 'faint'}>{label}</AppText>
    </View>
  );
};

export const ChangePasswordScreen: React.FC<Props> = ({ onChanged, onLogout, onCancel }) => {
  const t = useTheme();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  /** So "Next" on the keyboard hands focus along the form instead of just showing a key nobody wired. */
  const newRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const lengthOk = newPassword.length >= MIN_LENGTH;
  const differsFromCurrent = newPassword.length > 0 && newPassword !== currentPassword;
  const matches = confirmPassword.length > 0 && newPassword === confirmPassword;

  // Radius matches LoginScreen's field treatment (radius.lg) rather than the tighter radius.md
  // used for the dense profile-editor inputs — this screen is a one-task auth form, not a list
  // of settings fields, so it gets the more spacious, "premium" rounding of the sign-in screen.
  const inputWrap = (isFocused: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: t.space.md,
    backgroundColor: t.colors.bg,
    borderRadius: t.radius.lg,
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
      haptics.error();
      setError('Enter your current password and choose a new one.');
      return;
    }
    if (newPassword.length < MIN_LENGTH) {
      haptics.error();
      setError(`Your new password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      haptics.error();
      setError('The two new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      haptics.error();
      setError('Your new password must be different from the current one.');
      return;
    }

    setBusy(true);
    try {
      const res = await MobileApiService.changeOwnPassword(currentPassword, newPassword);
      if (!res.success) {
        haptics.error();
        setError(res.error || 'Could not change your password. Please try again.');
        return;
      }
      haptics.success();
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
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: t.space.xl, gap: t.space['2xl'] }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: 'center', gap: t.space.md }}>
          {/* Soft-tinted circle rather than a bare glyph — the same auth-gate affordance
              LockScreen uses for its fingerprint icon, so the two screens that guard entry
              to the app read as one family instead of each inventing its own header. */}
          <View style={{
            width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center',
            backgroundColor: t.colors.primarySoft,
          }}>
            <Icon name="lock-closed" size={30} color={t.colors.primary} />
          </View>
          {/* Large-title weight — the same scale ProfileScreen gives its own name header —
              rather than h2, so a one-task form gets the same hero treatment a full screen does. */}
          <AppText variant="largeTitle" style={{ textAlign: 'center', letterSpacing: -0.5 }}>
            {onCancel ? 'Change your password' : 'Choose your own password'}
          </AppText>
          <AppText variant="small" tone="muted" style={{ textAlign: 'center' }}>
            {onCancel
              ? 'Enter your current password, then the new one you want to use.'
              : 'Your account is still using a password that was issued to you. Set one only you know before continuing.'}
          </AppText>
        </View>

        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl, borderRadius: t.radius['2xl'] }}>
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
                accessibilityLabel="Current password"
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => newRef.current?.focus()}
              />
            </View>
          </View>

          <View style={{ gap: t.space.sm }}>
            <AppText variant="overline" tone="faint">NEW PASSWORD</AppText>
            <View style={inputWrap(focused === 'new')}>
              <Icon name="lock-closed-outline" size={18} color={focused === 'new' ? t.colors.primary : t.colors.textFaint} />
              <TextInput
                ref={newRef}
                value={newPassword}
                onChangeText={setNewPassword}
                onFocus={() => setFocused('new')}
                onBlur={() => setFocused(null)}
                secureTextEntry={!showNew}
                autoCapitalize="none"
                autoCorrect={false}
                style={inputStyle}
                accessibilityLabel="New password"
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => confirmRef.current?.focus()}
              />
              {/* Tappable, not a bare Pressable — this row's show/hide toggle previously gave no
                  press feedback at all, the one control on the screen that felt unresponsive next
                  to every button and switch elsewhere in the app using the same scale-down cue. */}
              <Tappable
                onPress={() => setShowNew((v) => !v)}
                hitSlop={14}
                accessibilityRole="button"
                accessibilityLabel={showNew ? 'Hide new password' : 'Show new password'}
              >
                <Icon name={showNew ? 'eye-off-outline' : 'eye-outline'} size={18} color={t.colors.textFaint} />
              </Tappable>
            </View>
            {/* Rules update live rather than only surfacing on a rejected submit — on a field
                connection every round trip costs time, so a typo is worth catching before "Set
                password" is even tapped. */}
            <View style={{ gap: 4 }}>
              <RuleRow ok={lengthOk} label={`At least ${MIN_LENGTH} characters`} />
              <RuleRow ok={differsFromCurrent} label="Different from your current password" />
            </View>
          </View>

          <View style={{ gap: t.space.sm }}>
            <AppText variant="overline" tone="faint">CONFIRM NEW PASSWORD</AppText>
            <View style={inputWrap(focused === 'conf')}>
              <Icon name="checkmark-circle-outline" size={18} color={focused === 'conf' ? t.colors.primary : t.colors.textFaint} />
              <TextInput
                ref={confirmRef}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                onFocus={() => setFocused('conf')}
                onBlur={() => setFocused(null)}
                secureTextEntry={!showConfirm}
                autoCapitalize="none"
                autoCorrect={false}
                style={inputStyle}
                accessibilityLabel="Confirm new password"
                returnKeyType="go"
                onSubmitEditing={submit}
              />
              <Tappable
                onPress={() => setShowConfirm((v) => !v)}
                hitSlop={14}
                accessibilityRole="button"
                accessibilityLabel={showConfirm ? 'Hide confirmed password' : 'Show confirmed password'}
              >
                <Icon name={showConfirm ? 'eye-off-outline' : 'eye-outline'} size={18} color={t.colors.textFaint} />
              </Tappable>
            </View>
            <RuleRow ok={matches} label="Matches the new password" />
          </View>

          {error ? (
            <View
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={{
                flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
                backgroundColor: t.colors.dangerSoft, padding: t.space.md, borderRadius: t.radius.md,
              }}
            >
              <Icon name="alert-circle" size={16} color={t.colors.danger} />
              <AppText variant="caption" style={{ color: t.colors.danger, flex: 1 }}>{error}</AppText>
            </View>
          ) : null}

          <Button label={busy ? 'Saving…' : 'Set password'} onPress={submit} loading={busy} size="lg" full />
        </Card>

        {/* The secondary exit stays a plain ghost button — quiet relative to the primary
            "Set password" action above, never competing with it for the eye. */}
        {onCancel ? (
          <Button label="Cancel" variant="ghost" onPress={onCancel} full />
        ) : (
          <Button label="Sign out" variant="ghost" onPress={onLogout} full />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
};
