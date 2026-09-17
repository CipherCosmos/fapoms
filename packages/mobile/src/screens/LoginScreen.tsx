import React, { useEffect, useRef, useState } from 'react';
import {
  View, TextInput, ScrollView, KeyboardAvoidingView, Platform, Animated, useWindowDimensions,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card, Icon, Input, Tappable } from '../components/ui/primitives';
import { OrbitMark } from '../components/ui/BrandMark';
import { getApiBaseUrl, setApiBaseUrl, resetApiBaseUrl } from '../services/api.service';
import { probeServerUrl, normaliseServerUrl, isBlockedCleartext, CLEARTEXT_REFUSED } from '../services/server-config';
import { getPreference } from '../services/preferences';
import { useT, serverErrorText } from '../i18n';
import { versionLine } from '../utils/appVersion';
import * as haptics from '../lib/haptics';

interface LoginScreenProps {
  loginUsername?: string;
  loginPassword?: string;
  authenticating?: boolean;
  onChangeUsername?: (val: string) => void;
  onChangePassword?: (val: string) => void;
  onLogin?: (u?: string, p?: string) => void | Promise<any>;
  onVerifyIdentity?: (id: string) => Promise<any>;
  onBiometricLogin?: () => void | Promise<any>;
  /**
   * Opens `SelfRegistrationScreen` — the one way a candidate who has never signed in (and never
   * will sign in through this form; self-registration issues no credentials) can reach the
   * Appraiser Recruitment flow. Optional so this component still compiles wherever it might be
   * rendered without that flow wired up; `App.tsx` always supplies it.
   */
  onRegister?: () => void;
}

/**
 * Sign-in.
 *
 * Structurally different from a centred-card auth form on purpose: a fixed-width brand pane
 * (mark, name, tagline) beside an unboxed form pane, split by a single hairline rather than a
 * card the form sits inside. `useWindowDimensions` switches it to a stacked layout — brand
 * block on top, form below — under `WIDE_BREAKPOINT`, which covers every phone in portrait and
 * most in landscape; the side-by-side pane is for tablet and the web build this app also ships.
 * No decorative background wash on either build: the split, the type scale, and the brand colour
 * on the one primary action are what carry it, not an ambient glow — a color experiment (a
 * multi-hue frosted-glass version) was tried and reverted here for reading as decoration rather
 * than brand.
 *
 * Real keyboard avoidance (the old screen had none, so on a short screen the keyboard covered
 * the sign-in button) and inputs that visibly respond to focus carry over unchanged.
 *
 * The old "4-Digit PIN" toggle is gone — it switched a local flag and changed the input's
 * maxLength, but submitted through the same password field to the same endpoint, so it was a
 * mode that did not exist on the backend.
 */
const WIDE_BREAKPOINT = 820;
export const LoginScreen: React.FC<LoginScreenProps> = ({
  loginUsername: controlledUsername,
  loginPassword: controlledPassword,
  authenticating: controlledAuthenticating,
  onChangeUsername: controlledOnChangeUsername,
  onChangePassword: controlledOnChangePassword,
  onLogin,
  onVerifyIdentity,
  onBiometricLogin,
  onRegister,
  }) => {
  const t = useTheme();
  const tr = useT();
  const { width } = useWindowDimensions();
  const isWide = width >= WIDE_BREAKPOINT;
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

  /**
   * Why the sign-in failed, in words the person can act on.
   *
   * The server cannot tell a wrong password from an account that has never had one: both come
   * back as "Invalid credentials", because saying which would let anybody enumerate who has app
   * access. For the 540 roster-imported assayers with no password at all, that message is not
   * just unhelpful, it is a dead end — they are told to fix something that does not exist, and
   * nothing on this screen tells them who can help.
   *
   * The pre-login identity check *can* tell the difference (`needsAppAccess`), so it is asked —
   * but only after a failure, and only for the generic credential rejection. On the happy path
   * this costs nothing, a specific refusal (locked, suspended, closed) is left alone because the
   * server already said something true, and a failure of this call falls back to the original
   * message rather than replacing one unhelpful sentence with a worse one.
   */
  const explainFailedSignIn = async (identifier: string, rawError: unknown, code?: unknown): Promise<string> => {
    const shown = serverErrorText(rawError, 'login.badCredentials', code);
    if (!onVerifyIdentity || shown !== tr('errors.invalidCredentials')) return shown;
    try {
      const check: any = await onVerifyIdentity(identifier);
      if (check?.needsAppAccess) return tr('login.needsAppAccess');
    } catch {
      // No signal, or the check is unavailable. The credential message stands.
    }
    return shown;
  };

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
      haptics.error();
      setErrorMsg(tr('login.missingFields'));
      return;
    }
    setInternalLoading(true);
    try {
      if (onLogin) {
        const res: any = await onLogin(code, password);
        if (res === false || (typeof res === 'object' && res?.success === false)) {
          haptics.error();
          setErrorMsg(await explainFailedSignIn(code, res?.error, res?.code));
        }
      }
    } catch (err: any) {
      // Distinguished from a bad credential on purpose — a dropped field connection and a typo'd
      // password read identically as "it didn't work" unless the message names the network, so an
      // assayer under a weak signal knows to retry rather than re-key a password that was fine.
      haptics.error();
      setErrorMsg(serverErrorText(err?.message, 'login.unreachable'));
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
          haptics.error();
          setErrorMsg(serverErrorText(res?.error, 'login.biometricFailed', res?.code));
        }
      } catch (err: any) {
        haptics.error();
        setErrorMsg(serverErrorText(err?.message, 'login.biometricError'));
      } finally {
        setInternalLoading(false);
      }
    }
  };

  const [showPassword, setShowPassword] = useState(false);


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
          ? { ok: true, message: tr('login.server.reachable') }
          : { ok: false, message: serverErrorText(result.error, 'login.server.unreachable') },
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
      setProbeResult({ ok: true, message: tr('login.server.saved') });
      setErrorMsg(null);
    } catch {
      setProbeResult({ ok: false, message: tr('login.server.saveFailed') });
    }
  };

  const handleResetServer = async () => {
    const restored = await resetApiBaseUrl();
    setServerUrl(restored.replace(/\/api\/v1$/, ''));
    setProbeResult({ ok: true, message: tr('login.server.resetDone') });
  };

  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // t.motion.slow, not a bespoke 420ms — this was the one entrance timing in the app that
    // didn't come from the shared motion scale.
    Animated.timing(enter, { toValue: 1, duration: t.motion.slow, useNativeDriver: true }).start();
  }, [enter, t.motion.slow]);

  const hairline = t.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(20,18,40,0.10)';

  const brandPane = (
    <View
      style={
        isWide
          ? {
              width: 340, paddingHorizontal: t.space['2xl'], paddingVertical: t.space['4xl'],
              borderRightWidth: 1, borderRightColor: hairline, justifyContent: 'space-between',
            }
          : { alignItems: 'center', paddingTop: t.space['3xl'], paddingBottom: t.space.xl, paddingHorizontal: t.space.xl }
      }
    >
      <View style={{ alignItems: isWide ? 'flex-start' : 'center', gap: t.space.lg }} accessibilityLabel={tr('login.appName')}>
        <OrbitMark size={isWide ? 60 : 92} />
        <View style={{ gap: 4, alignItems: isWide ? 'flex-start' : 'center' }}>
          <AppText variant={isWide ? 'display' : 'largeTitle'}>{tr('login.appName')}</AppText>
          <AppText variant="overline" tone="muted" style={{ letterSpacing: 2.5, fontWeight: '700' }}>
            {tr('login.tagline')}
          </AppText>
        </View>
      </View>
      {/* Tucked into the brand pane rather than repeated at the page foot — there is room for it
          here on a wide screen, and it answers the most common support question ("which version
          are you on?") without needing its own line in the (unboxed, deliberately spare) form. */}
      {isWide && (
        <View style={{ gap: 2 }}>
          <AppText variant="caption" tone="faint">{tr('login.authorisedOnly')}</AppText>
          <AppText variant="caption" tone="faint">{versionLine()}</AppText>
        </View>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <Animated.View
            style={{
              flex: 1,
              flexDirection: isWide ? 'row' : 'column',
              opacity: enter,
              transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
            }}
          >
            {brandPane}

            {/* The form: fields sit directly on the page, not inside a bordered card — the split
                itself (and the one hairline dividing it from the brand pane) is what gives the
                screen structure now, not a box drawn around the inputs. */}
            <View style={{
              flex: 1,
              // Centred on a wide screen, where the form pane is a tall column with room to
              // spare either way. Stacked (phone) the brand block already fills the top of the
              // screen, so centring the form in what's LEFT put a dead gap between the tagline
              // and the first field — this keeps it flowing straight on from the brand block.
              justifyContent: isWide ? 'center' : 'flex-start',
              paddingHorizontal: t.space.xl,
              paddingTop: isWide ? t.space['2xl'] : t.space.md,
              paddingBottom: t.space['2xl'],
            }}>
              <View style={{ width: '100%', maxWidth: 400, alignSelf: 'center', gap: t.space.lg }}>
                <Input
                  label={tr('login.codeLabel')}
                  icon="person-outline"
                  value={username}
                  onChangeText={setUsername}
                  placeholder={tr('login.codePlaceholder')}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  accessibilityLabel={tr('login.codeAccessibility')}
                  returnKeyType="next"
                  /**
                   * The keyboard has always shown a "Next" key here and nothing was wired to it, so
                   * pressing it did nothing at all — the assayer had to dismiss the keyboard and aim
                   * at the password field. `blurOnSubmit={false}` keeps the keyboard up across the
                   * handover; without it the keyboard closes and reopens, which on Android drops the
                   * focus this is trying to move.
                   */
                  blurOnSubmit={false}
                  onSubmitEditing={() => passwordRef.current?.focus()}
                  size="lg"
                />

                <Input
                  label={tr('login.passwordLabel')}
                  icon="lock-closed-outline"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel={tr('login.passwordAccessibility')}
                  returnKeyType="go"
                  onSubmitEditing={handleLoginPress}
                  size="lg"
                  inputRef={passwordRef}
                  rightAccessory={
                    // Tappable for the same press feedback every other control in the app gives —
                    // this toggle used a bare Pressable and was the one dead-feeling tap on the
                    // login screen.
                    <Tappable
                      onPress={() => setShowPassword((v) => !v)}
                      hitSlop={14}
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? tr('login.hidePassword') : tr('login.showPassword')}
                    >
                      <Icon name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color={t.colors.textFaint} />
                    </Tappable>
                  }
                />

                {errorMsg ? (
                  // No border — a tinted fill alone is enough signal, and matches the restrained
                  // (borderless) error treatment ChangePasswordScreen uses for the same alert role.
                  // A hard danger-coloured outline around a form field's own error box read as a
                  // second, competing warning stacked on the red icon and text already inside it.
                  <View
                    accessibilityRole="alert"
                    accessibilityLiveRegion="assertive"
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
                      backgroundColor: t.colors.dangerSoft, padding: t.space.md, borderRadius: t.radius.md,
                    }}
                  >
                    <Icon name="alert-circle" size={16} color={t.colors.danger} />
                    <AppText variant="caption" style={{ color: t.colors.danger, flex: 1 }}>
                      {errorMsg}
                    </AppText>
                  </View>
                ) : null}

                <Button
                  label={authenticating ? tr('login.signingIn') : tr('login.signIn')}
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
                    <AppText variant="small" tone="muted">{tr('login.useBiometric')}</AppText>
                  </View>
                </Tappable>
                )}

                {/*
                  The one way in for a candidate who has never signed in and never will through this
                  form — self-registration issues no password. Placed with sign-in rather than buried
                  under the server-address disclosure below, since this is the option a first-time
                  candidate is actually looking for on this screen.
                */}
                {onRegister && (
                  <Tappable onPress={onRegister} accessibilityRole="button" accessibilityLabel={tr('login.registerLinkAccessibility')}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm, paddingVertical: t.space.sm }}>
                      <Icon name="person-add-outline" size={16} color={t.colors.primary} />
                      <AppText variant="small" style={{ color: t.colors.primary, fontWeight: '700' }}>
                        {tr('login.registerLink')}
                      </AppText>
                    </View>
                  </Tappable>
                )}

                {/* Server address.
                    Reachable from the sign-in screen deliberately: if the app is pointed at the
                    wrong backend, this is the only screen the user can get to, so anywhere else
                    would be unreachable exactly when it is needed. The address used to be fixed at
                    build time, defaulting to an Android-emulator-only alias that no real handset
                    can resolve. */}
                <View style={{ alignItems: 'center', gap: t.space.sm, marginTop: t.space.sm }}>
                  {/* The address itself, not just a way in to it.
                      Pointing at the wrong backend produces "Invalid credentials" — the same message
                      a mistyped password gives — so the one fact that distinguishes the two was
                      hidden behind a tap nobody takes until they are already stuck. Shown as the bare
                      host so a wrong port is visible at a glance, which is exactly how this was mis-set. */}
                  <Tappable onPress={() => { setShowServerSettings((v) => !v); setProbeResult(null); }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: t.space.xs }}>
                      <Icon name="server-outline" size={14} color={t.colors.textFaint} />
                      <AppText variant="caption" tone="faint">
                        {showServerSettings
                          ? tr('login.server.hideSettings')
                          : serverUrl.replace(/^https?:\/\//, '') || tr('login.server.openSettings')}
                      </AppText>
                    </View>
                  </Tappable>

                  {showServerSettings && (
                    <Card level={1} style={{ gap: t.space.md, padding: t.space.lg, width: '100%' }}>
                      <Input
                        label={tr('login.server.addressLabel')}
                        icon="globe-outline"
                        value={serverUrl}
                        onChangeText={setServerUrl}
                        placeholder={tr('login.server.addressPlaceholder')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        accessibilityLabel={tr('login.server.addressAccessibility')}
                      />

                      {probeResult && (
                        <AppText
                          variant="caption"
                          style={{ color: probeResult.ok ? (t.colors.success || t.colors.primary) : t.colors.danger }}>
                          {probeResult.message}
                        </AppText>
                      )}

                      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
                        <Button label={tr('login.server.test')} variant="neutral" onPress={handleTestServer} loading={testingServer} style={{ flex: 1 }} />
                        <Button label={tr('common.save')} onPress={handleSaveServer} style={{ flex: 1 }} />
                      </View>

                      <Tappable onPress={handleResetServer}>
                        <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
                          {tr('login.server.reset')}
                        </AppText>
                      </Tappable>
                    </Card>
                  )}
                </View>

                {/* On a wide screen the version already sits in the brand pane; here it would be a
                    third small-print line under a form deliberately kept to one thing at a time. */}
                {!isWide && (
                  <View style={{ alignItems: 'center', gap: 2 }}>
                    <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
                      {tr('login.authorisedOnly')}
                    </AppText>
                    {/*
                      Shown BEFORE sign-in on purpose. The most common support question — "which
                      version are you on?" — is asked most often by someone who cannot get past this
                      screen, and a version that only lives on the Profile tab is unreachable to
                      exactly them.
                    */}
                    <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
                      {versionLine()}
                    </AppText>
                  </View>
                )}
              </View>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
};
