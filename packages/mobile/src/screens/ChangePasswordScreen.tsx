import React, { useRef, useState } from 'react';
import { View, TextInput, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AmbientGlow, AppText, Button, Card, Icon, Input, Tappable } from '../components/ui/primitives';
import { MobileApiService } from '../services/api.service';
import * as haptics from '../lib/haptics';
import { useT, serverErrorText } from '../i18n';

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
  const tr = useT();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  /** So "Next" on the keyboard hands focus along the form instead of just showing a key nobody wired. */
  const newRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const lengthOk = newPassword.length >= MIN_LENGTH;
  const differsFromCurrent = newPassword.length > 0 && newPassword !== currentPassword;
  const matches = confirmPassword.length > 0 && newPassword === confirmPassword;

  const submit = async () => {
    setError(null);

    // Checked here as well as on the server so the person gets the answer immediately rather
    // than after a round trip on a weak field connection.
    if (!currentPassword || !newPassword) {
      haptics.error();
      setError(tr('password.errMissing'));
      return;
    }
    if (newPassword.length < MIN_LENGTH) {
      haptics.error();
      setError(tr('password.errTooShort', { count: MIN_LENGTH }));
      return;
    }
    if (newPassword !== confirmPassword) {
      haptics.error();
      setError(tr('password.errMismatch'));
      return;
    }
    if (newPassword === currentPassword) {
      haptics.error();
      setError(tr('password.errSameAsCurrent'));
      return;
    }

    setBusy(true);
    try {
      const res = await MobileApiService.changeOwnPassword(currentPassword, newPassword);
      if (!res.success) {
        haptics.error();
        setError(serverErrorText(res.error, 'password.errFailed', res.code));
        return;
      }
      haptics.success();
      /**
       * The change always revokes this session server-side; `changeOwnPassword` normally signs
       * back in behind the scenes so nothing is felt here. When it could not — no stored sign-in
       * identifier, or the re-authentication itself failed — the tokens are already gone, and
       * carrying on would put the app back in the state this flow exists to escape: signed in to
       * look at, dead to the server. Sign out instead, so the assayer is asked for the password
       * they just chose rather than shown an empty schedule.
       */
      if (res.reauthRequired) {
        onLogout();
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
      <AmbientGlow />
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
            {onCancel ? tr('password.titleVoluntary') : tr('password.titleForced')}
          </AppText>
          <AppText variant="small" tone="muted" style={{ textAlign: 'center' }}>
            {onCancel ? tr('password.subtitleVoluntary') : tr('password.subtitleForced')}
          </AppText>
        </View>

        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl, borderRadius: t.radius['2xl'] }}>
          <Input
            label={tr('password.currentLabel')}
            icon="key-outline"
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={tr('password.currentAccessibility')}
            returnKeyType="next"
            blurOnSubmit={false}
            onSubmitEditing={() => newRef.current?.focus()}
            size="lg"
          />

          <View style={{ gap: t.space.sm }}>
            <Input
              label={tr('password.newLabel')}
              icon="lock-closed-outline"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry={!showNew}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={tr('password.newAccessibility')}
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => confirmRef.current?.focus()}
              size="lg"
              inputRef={newRef}
              rightAccessory={
                // Tappable, not a bare Pressable — this row's show/hide toggle previously gave no
                // press feedback at all, the one control on the screen that felt unresponsive next
                // to every button and switch elsewhere in the app using the same scale-down cue.
                <Tappable
                  onPress={() => setShowNew((v) => !v)}
                  hitSlop={14}
                  accessibilityRole="button"
                  accessibilityLabel={showNew ? tr('password.hideNew') : tr('password.showNew')}
                >
                  <Icon name={showNew ? 'eye-off-outline' : 'eye-outline'} size={18} color={t.colors.textFaint} />
                </Tappable>
              }
            />
            {/* Rules update live rather than only surfacing on a rejected submit — on a field
                connection every round trip costs time, so a typo is worth catching before "Set
                password" is even tapped. */}
            <View style={{ gap: 4 }}>
              <RuleRow ok={lengthOk} label={tr('password.ruleLength', { count: MIN_LENGTH })} />
              <RuleRow ok={differsFromCurrent} label={tr('password.ruleDiffers')} />
            </View>
          </View>

          <View style={{ gap: t.space.sm }}>
            <Input
              label={tr('password.confirmLabel')}
              icon="checkmark-circle-outline"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry={!showConfirm}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={tr('password.confirmAccessibility')}
              returnKeyType="go"
              onSubmitEditing={submit}
              size="lg"
              inputRef={confirmRef}
              rightAccessory={
                <Tappable
                  onPress={() => setShowConfirm((v) => !v)}
                  hitSlop={14}
                  accessibilityRole="button"
                  accessibilityLabel={showConfirm ? tr('password.hideConfirm') : tr('password.showConfirm')}
                >
                  <Icon name={showConfirm ? 'eye-off-outline' : 'eye-outline'} size={18} color={t.colors.textFaint} />
                </Tappable>
              }
            />
            <RuleRow ok={matches} label={tr('password.ruleMatches')} />
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

          <Button label={busy ? tr('common.saving') : tr('password.submit')} onPress={submit} loading={busy} size="lg" glow full />
        </Card>

        {/* The secondary exit stays a plain ghost button — quiet relative to the primary
            "Set password" action above, never competing with it for the eye. */}
        {onCancel ? (
          <Button label={tr('common.cancel')} variant="ghost" onPress={onCancel} full />
        ) : (
          <Button label={tr('common.signOut')} variant="ghost" onPress={onLogout} full />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
};
