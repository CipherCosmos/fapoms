import React, { useEffect, useRef, useState } from 'react';
import {
  View, TextInput, ScrollView, KeyboardAvoidingView, Platform, Animated, TextStyle, Pressable,
  Easing, Image,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AmbientGlow, AppText, Button, Card, Icon, Tappable } from '../components/ui/primitives';
import { getApiBaseUrl, setApiBaseUrl, resetApiBaseUrl } from '../services/api.service';
import { probeServerUrl, normaliseServerUrl, isBlockedCleartext, CLEARTEXT_REFUSED } from '../services/server-config';
import { getPreference } from '../services/preferences';
import { versionLine } from '../utils/appVersion';

interface LoginScreenProps {
  loginUsername?: string;
  loginPassword?: string;
  authenticating?: boolean;
  onChangeUsername?: (val: string) => void;
  onChangePassword?: (val: string) => void;
  onLogin?: (u?: string, p?: string) => void | Promise<any>;
  onVerifyIdentity?: (id: string) => Promise<any>;
  onBiometricLogin?: () => void | Promise<any>;
}

/**
 * The Orbit mark — a living logo, not a static drawing.
 *
 * Two satellites revolve around a core at different speeds and opposite directions, and the
 * core breathes with a pulsing halo. All of it runs on the native driver (transform + opacity
 * only), so it animates off the JS thread and stays smooth. This is the "dynamic" the flat
 * ringed version was missing.
 */
const OrbitMark: React.FC<{ size?: number }> = ({ size = 120 }) => {
  const t = useTheme();
  const spin = useRef(new Animated.Value(0)).current;
  const spinRev = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loops = [
      Animated.loop(Animated.timing(spin, { toValue: 1, duration: 9000, easing: Easing.linear, useNativeDriver: true })),
      Animated.loop(Animated.timing(spinRev, { toValue: 1, duration: 6000, easing: Easing.linear, useNativeDriver: true })),
      Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])),
    ];
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [spin, spinRev, pulse]);

  const rot = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const rotRev = spinRev.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] });
  const glowScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.4] });
  const glowOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0.06] });

  const outer = size;
  const inner = size * 0.62;
  const core = size * 0.32;
  const sat = size * 0.115;
  const satInner = size * 0.08;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* ambient halo */}
      <View style={{
        position: 'absolute', width: size * 1.5, height: size * 1.5, borderRadius: size * 0.75,
        backgroundColor: t.colors.primary, opacity: 0.12,
      }} />

      {/* rings */}
      <View style={{ position: 'absolute', width: outer, height: outer, borderRadius: outer / 2, borderWidth: 1.5, borderColor: t.colors.primary + '55' }} />
      <View style={{ position: 'absolute', width: inner, height: inner, borderRadius: inner / 2, borderWidth: 1.5, borderColor: t.colors.accent + '4D' }} />

      {/* outer satellite, revolving clockwise on the outer ring */}
      <Animated.View style={{ position: 'absolute', width: outer, height: outer, transform: [{ rotate: rot }] }}>
        <View style={{
          position: 'absolute', top: -sat / 2 + 0.75, left: outer / 2 - sat / 2,
          width: sat, height: sat, borderRadius: sat / 2,
          backgroundColor: t.colors.accent, borderWidth: 2, borderColor: t.colors.bg,
        }} />
      </Animated.View>

      {/* inner satellite, revolving anticlockwise on the inner ring */}
      <Animated.View style={{ position: 'absolute', width: inner, height: inner, transform: [{ rotate: rotRev }] }}>
        <View style={{
          position: 'absolute', top: -satInner / 2 + 0.75, left: inner / 2 - satInner / 2,
          width: satInner, height: satInner, borderRadius: satInner / 2, backgroundColor: t.colors.primary,
        }} />
      </Animated.View>

      {/* breathing core glow */}
      <Animated.View style={{
        position: 'absolute', width: core * 1.9, height: core * 1.9, borderRadius: core * 0.95,
        backgroundColor: t.colors.primary, opacity: glowOpacity, transform: [{ scale: glowScale }],
      }} />

      {/*
        The company's own mark at the core. The de-identified drawn planet was replaced at the
        user's request: the identity is theirs, the orbit motion around it stays. 13:10 keeps
        the asset's 208x160 ratio; it sits inside the inner ring rather than filling it so the
        revolving satellite never crosses the artwork.
      */}
      <Image
        source={require('../../assets/sumeru-logo.png')}
        style={{ width: core * 1.56, height: core * 1.2, resizeMode: 'contain' }}
        accessibilityLabel="Sumeru Global"
      />
    </View>
  );
};

/**
 * Sign-in.
 *
 * Rebuilt on the theme: no hardcoded colours, real keyboard avoidance (the old
 * screen had none, so on a short screen the keyboard covered the sign-in
 * button), and inputs that visibly respond to focus.
 *
 * The old "4-Digit PIN" toggle is gone — it switched a local flag and changed
 * the input's maxLength, but submitted through the same password field to the
 * same endpoint, so it was a mode that did not exist on the backend.
 */
export const LoginScreen: React.FC<LoginScreenProps> = ({
  loginUsername: controlledUsername,
  loginPassword: controlledPassword,
  authenticating: controlledAuthenticating,
  onChangeUsername: controlledOnChangeUsername,
  onChangePassword: controlledOnChangePassword,
  onLogin,
  onBiometricLogin,
}) => {
  const t = useTheme();
  const [internalUsername, setInternalUsername] = useState('');
  const [internalPassword, setInternalPassword] = useState('');
  const [internalLoading, setInternalLoading] = useState(false);

  const username = controlledUsername || internalUsername;
  const password = controlledPassword || internalPassword;
  const authenticating = controlledAuthenticating !== undefined ? controlledAuthenticating : internalLoading;

  const setUsername = (val: string) => {
    setInternalUsername(val);
    controlledOnChangeUsername?.(val);
  };

  const setPassword = (val: string) => {
    setInternalPassword(val);
    controlledOnChangePassword?.(val);
  };

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** So the code field's "Next" key can hand focus on, rather than being decorative. */
  const passwordRef = useRef<TextInput>(null);

  const handleLoginPress = async () => {
    // A second tap while the first is in flight would issue a second sign-in, and on a slow
    // field connection that is the normal reaction to a button that has not visibly responded.
    if (authenticating) return;

    setErrorMsg(null);
    /**
     * Trimmed, because the code is never surrounded by spaces but frequently arrives that way:
     * pasted from a roster message, or with the trailing space Android's keyboard adds after an
     * autocorrect suggestion. Untrimmed it reaches the server as a code that does not exist and
     * comes back "Invalid credentials", which sends the assayer hunting for a typo they cannot
     * see. The password is deliberately NOT trimmed — leading or trailing spaces may be part of it.
     */
    const code = username.trim();
    if (!code || !password) {
      setErrorMsg('Please enter both Assayer Code and Password.');
      return;
    }
    setInternalLoading(true);
    try {
      if (onLogin) {
        const res: any = await onLogin(code, password);
        if (res === false || (typeof res === 'object' && res?.success === false)) {
          setErrorMsg(res?.error || 'Invalid credentials. Please try again.');
        }
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Connection failed. Please check backend server.');
    } finally {
      setInternalLoading(false);
    }
  };

  const handleBiometricPress = async () => {
    setErrorMsg(null);
    if (onBiometricLogin) {
      setInternalLoading(true);
      try {
        const res: any = await onBiometricLogin();
        if (res === false || (typeof res === 'object' && res?.success === false)) {
          setErrorMsg(res?.error || 'Biometric authentication failed.');
        }
      } catch (err: any) {
        setErrorMsg(err?.message || 'Biometric login failed.');
      } finally {
        setInternalLoading(false);
      }
    }
  };

  const [showPassword, setShowPassword] = useState(false);
  const [focused, setFocused] = useState<'user' | 'pass' | 'server' | null>(null);


  // ── Server address ──────────────────────────────────────────────────────────
  const biometricsEnabled = getPreference('biometrics');
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [testingServer, setTestingServer] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    // Shown as the plain host the operator typed, not the internal `/api/v1` form.
    setServerUrl(getApiBaseUrl().replace(/\/api\/v1$/, ''));
  }, []);

  const handleTestServer = async () => {
    setProbeResult(null);
    setTestingServer(true);
    try {
      const result = await probeServerUrl(normaliseServerUrl(serverUrl));
      setProbeResult(
        result.ok
          ? { ok: true, message: 'Server reachable.' }
          : { ok: false, message: result.error || 'Could not reach that address.' },
      );
    } finally {
      setTestingServer(false);
    }
  };

  const handleSaveServer = async () => {
    // Refused here as well as in Test, so an address this build will never be allowed to reach
    // cannot be stored and then quietly fail at every sign-in afterwards.
    if (isBlockedCleartext(serverUrl)) {
      setProbeResult({ ok: false, message: CLEARTEXT_REFUSED });
      return;
    }

    try {
      const saved = await setApiBaseUrl(serverUrl);
      setServerUrl(saved.replace(/\/api\/v1$/, ''));
      setProbeResult({ ok: true, message: 'Saved. Sign in to continue.' });
      setErrorMsg(null);
    } catch {
      setProbeResult({ ok: false, message: 'Could not save that address.' });
    }
  };

  const handleResetServer = async () => {
    const restored = await resetApiBaseUrl();
    setServerUrl(restored.replace(/\/api\/v1$/, ''));
    setProbeResult({ ok: true, message: 'Reset to the built-in default.' });
  };

  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 420, useNativeDriver: true }).start();
  }, [enter]);

  /**
   * Focus is signalled by the border colour ONLY — never by adding shadow/elevation.
   *
   * A focus glow (`elevation` + `shadow*` applied when `isFocused`) made every input on this
   * screen untypeable on Android: under the New Architecture (Fabric — always on in Expo Go),
   * mutating elevation on the wrapper at the moment its TextInput gains focus recreates the
   * native view, which drops the freshly-granted IME focus. Verified on the emulator —
   * `dumpsys input_method` showed `mServedView=null` after every tap with the glow present,
   * and a ReactEditText holding focus the moment it was removed. Border colour is a plain
   * prop update on the same view and is safe.
   */
  const inputWrap = (isFocused: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: t.space.md,
    backgroundColor: t.colors.surfaceAlt,
    borderRadius: t.radius.lg,
    borderWidth: 1.5,
    borderColor: isFocused ? t.colors.primary : t.colors.border,
    paddingHorizontal: t.space.lg,
    height: 56,
  });

  const inputStyle: TextStyle = {
    flex: 1,
    color: t.colors.text,
    fontSize: 15,
    fontWeight: '600',
    // Android adds its own vertical padding that misaligns the row.
    paddingVertical: 0,
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <AmbientGlow />

      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: t.space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View style={{
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
          gap: t.space['2xl'],
        }}>
          <View style={{ alignItems: 'center', gap: t.space.lg }} accessibilityLabel="Orbit">
            <OrbitMark size={150} />
            <View style={{ alignItems: 'center', gap: 6 }}>
              <AppText variant="largeTitle">Orbit</AppText>
              <AppText variant="overline" tone="muted" style={{ letterSpacing: 2.5, fontWeight: '700' }}>FIELD AUDIT OPERATIONS</AppText>
            </View>
          </View>

          <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl, borderRadius: t.radius['2xl'] }}>
            <View style={{ gap: t.space.sm }}>
              <AppText variant="overline" tone="faint">ASSAYER CODE OR PHONE</AppText>
              <View style={inputWrap(focused === 'user')}>
                <Icon name="person-outline" size={18} color={focused === 'user' ? t.colors.primary : t.colors.textFaint} />
                <TextInput
                  value={username}
                  onChangeText={setUsername}
                  onFocus={() => setFocused('user')}
                  onBlur={() => setFocused(null)}
                  placeholder="AS0001"
                  placeholderTextColor={t.colors.textFaint}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={inputStyle}
                  returnKeyType="next"
                  /**
                   * The keyboard has always shown a "Next" key here and nothing was wired to it,
                   * so pressing it did nothing at all — the assayer had to dismiss the keyboard
                   * and aim at the password field. `blurOnSubmit={false}` keeps the keyboard up
                   * across the handover; without it the keyboard closes and reopens, which on
                   * Android drops the focus this is trying to move.
                   */
                  blurOnSubmit={false}
                  onSubmitEditing={() => passwordRef.current?.focus()}
                />
              </View>
            </View>

            <View style={{ gap: t.space.sm }}>
              <AppText variant="overline" tone="faint">PASSWORD</AppText>
              <View style={inputWrap(focused === 'pass')}>
                <Icon name="lock-closed-outline" size={18} color={focused === 'pass' ? t.colors.primary : t.colors.textFaint} />
                <TextInput
                  ref={passwordRef}
                  value={password}
                  onChangeText={setPassword}
                  onFocus={() => setFocused('pass')}
                  onBlur={() => setFocused(null)}
                  placeholder="••••••••"
                  placeholderTextColor={t.colors.textFaint}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={inputStyle}
                  returnKeyType="go"
                  onSubmitEditing={handleLoginPress}
                />
                <Pressable
                  onPress={() => setShowPassword((v) => !v)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                >
                  <Icon name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color={t.colors.textFaint} />
                </Pressable>
              </View>
            </View>

            {errorMsg ? (
              <View style={{ backgroundColor: t.colors.dangerSoft, padding: t.space.md, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.danger }}>
                <AppText variant="caption" style={{ color: t.colors.danger, textAlign: 'center' }}>
                  {errorMsg}
                </AppText>
              </View>
            ) : null}

            <Button
              label={authenticating ? 'Signing in…' : 'Sign in'}
              onPress={handleLoginPress}
              loading={authenticating}
              size="lg"
              glow
              full
            />

            {/* Offered only when the assayer has biometric sign-in switched on in their
                profile. That switch previously set a state field nothing consulted, so the
                option appeared regardless of the preference. */}
            {biometricsEnabled && (
            <Tappable onPress={handleBiometricPress}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm, paddingVertical: t.space.sm }}>
                <Icon name="finger-print" size={18} color={t.colors.textMuted} />
                <AppText variant="small" tone="muted">Use biometric sign-in</AppText>
              </View>
            </Tappable>
            )}
          </Card>

          {/* Server address.
              Reachable from the sign-in screen deliberately: if the app is pointed at the wrong
              backend, this is the only screen the user can get to, so anywhere else would be
              unreachable exactly when it is needed. The address used to be fixed at build time,
              defaulting to an Android-emulator-only alias that no real handset can resolve. */}
          <View style={{ alignItems: 'center', gap: t.space.sm }}>
            {/* The address itself, not just a way in to it.
                Pointing at the wrong backend produces "Invalid credentials" — the same message a
                mistyped password gives — so the one fact that distinguishes the two was hidden
                behind a tap nobody takes until they are already stuck. Shown as the bare host so
                a wrong port is visible at a glance, which is exactly how this was mis-set. */}
            <Tappable onPress={() => { setShowServerSettings((v) => !v); setProbeResult(null); }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: t.space.xs }}>
                <Icon name="server-outline" size={14} color={t.colors.textFaint} />
                <AppText variant="caption" tone="faint">
                  {showServerSettings
                    ? 'Hide server settings'
                    : serverUrl.replace(/^https?:\/\//, '') || 'Server settings'}
                </AppText>
              </View>
            </Tappable>

            {showServerSettings && (
              <Card level={1} style={{ gap: t.space.md, padding: t.space.lg, width: '100%' }}>
                <AppText variant="overline" tone="faint">BACKEND ADDRESS</AppText>
                <View style={inputWrap(focused === 'server')}>
                  <Icon name="globe-outline" size={16} color={focused === 'server' ? t.colors.primary : t.colors.textFaint} />
                  <TextInput
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    onFocus={() => setFocused('server')}
                    onBlur={() => setFocused(null)}
                    placeholder="http://192.168.1.10:3000"
                    placeholderTextColor={t.colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={inputStyle}
                  />
                </View>

                {probeResult && (
                  <AppText
                    variant="caption"
                    style={{ color: probeResult.ok ? (t.colors.success || t.colors.primary) : t.colors.danger }}>
                    {probeResult.message}
                  </AppText>
                )}

                <View style={{ flexDirection: 'row', gap: t.space.sm }}>
                  <Button label="Test" variant="neutral" onPress={handleTestServer} loading={testingServer} style={{ flex: 1 }} />
                  <Button label="Save" onPress={handleSaveServer} style={{ flex: 1 }} />
                </View>

                <Tappable onPress={handleResetServer}>
                  <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
                    Reset to default
                  </AppText>
                </Tappable>
              </Card>
            )}
          </View>

          <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
            Authorised field personnel only
          </AppText>
          {/*
            Shown BEFORE sign-in on purpose. The most common support question — "which version
            are you on?" — is asked most often by someone who cannot get past this screen, and
            a version that only lives on the Profile tab is unreachable to exactly them.
          */}
          <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
            {versionLine()}
          </AppText>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};
