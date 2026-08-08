import React, { useEffect, useRef, useState } from 'react';
import { View, Animated } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Icon, Tappable } from '../components/ui/primitives';

export interface LockScreenProps {
  /** Shown so the assayer can tell whose session this handset is holding before unlocking. */
  name: string;
  onUnlock: () => Promise<{ success: boolean; error?: string }>;
  /** Signs out entirely — the way back in for a phone whose sensor stops recognising its owner. */
  onSignOut: () => void;
}

/**
 * The gate over a restored session.
 *
 * Biometric sign-in existed only as a button on the login screen, which an assayer with a
 * valid saved session never reaches — so the feature could not be used at all in normal
 * operation. The session is what needs the check, not the password entry.
 *
 * Nothing behind this renders: the schedule carries branch addresses, customer counts and
 * gold-packet detail, and a phone left on a bank counter should not show any of it.
 */
export const LockScreen: React.FC<LockScreenProps> = ({ name, onUnlock, onSignOut }) => {
  const t = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;
  // StrictMode and re-renders must not fire a second system prompt over the first.
  const prompted = useRef(false);

  const attempt = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await onUnlock();
    // A cancel is a deliberate choice, not a failure — the button below is the retry.
    if (!result.success && result.error) setError(result.error);
    setBusy(false);
  };

  // Prompt straight away: on a cold start the assayer opened the app to do something, and
  // making them tap a button before the sensor is offered is a step with no purpose.
  useEffect(() => {
    if (prompted.current) return;
    prompted.current = true;
    void attempt();
  }, []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1400, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
        padding: t.space.xl,
        gap: t.space['2xl'],
      }}
    >
      <Animated.View
        style={{
          width: 96,
          height: 96,
          borderRadius: 48,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.colors.surface,
          borderWidth: 1,
          borderColor: t.colors.border,
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }),
        }}
      >
        <Icon name="finger-print" size={44} color={t.colors.primary} />
      </Animated.View>

      <View style={{ alignItems: 'center', gap: t.space.xs }}>
        <AppText variant="h2">Locked</AppText>
        <AppText variant="small" tone="muted" style={{ textAlign: 'center' }}>
          Signed in as {name}
        </AppText>
      </View>

      {error && (
        <AppText variant="small" tone="danger" style={{ textAlign: 'center' }}>
          {error}
        </AppText>
      )}

      <View style={{ width: '100%', gap: t.space.md }}>
        <Button
          label={busy ? 'Waiting…' : 'Unlock'}
          icon="finger-print"
          onPress={attempt}
          loading={busy}
          size="lg"
          full
        />
        <Tappable onPress={onSignOut}>
          <View style={{ alignItems: 'center', paddingVertical: t.space.sm }}>
            <AppText variant="small" tone="muted">
              Sign in as someone else
            </AppText>
          </View>
        </Tappable>
      </View>
    </View>
  );
};
