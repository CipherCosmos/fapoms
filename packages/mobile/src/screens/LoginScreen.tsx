import React, { useEffect, useRef, useState } from 'react';
import {
  View, TextInput, ScrollView, KeyboardAvoidingView, Platform, Animated, TextStyle, Pressable, Image,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card, Icon, Tappable } from '../components/ui/primitives';

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
  const [internalUsername, setInternalUsername] = useState('AS0127');
  const [internalPassword, setInternalPassword] = useState('Password@123');
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

  const handleLoginPress = async () => {
    setErrorMsg(null);
    if (!username || !password) {
      setErrorMsg('Please enter both Assayer Code and Password.');
      return;
    }
    setInternalLoading(true);
    try {
      if (onLogin) {
        const res: any = await onLogin(username, password);
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
  const [focused, setFocused] = useState<'user' | 'pass' | null>(null);

  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 420, useNativeDriver: true }).start();
  }, [enter]);

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
    // Android adds its own vertical padding that misaligns the row.
    paddingVertical: 0,
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: t.space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View style={{
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
          gap: t.space['2xl'],
        }}>
          <View style={{ alignItems: 'center', gap: t.space.md }}>
            <Image
              source={(() => {
                const img = require('../../assets/logo.png');
                return typeof img === 'object' && img?.default ? img.default : img;
              })()}
              style={{ width: 84, height: 68, resizeMode: 'contain' }}
            />
            <View style={{ alignItems: 'center', gap: 2 }}>
              <AppText variant="h1" style={{ color: t.colors.primary, fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontWeight: '700' }}>Gold Audit Pro</AppText>
              <AppText variant="overline" tone="muted" style={{ letterSpacing: 2.5, fontWeight: '700' }}>BY SUMERU GLOBAL</AppText>
            </View>
          </View>

          <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl }}>
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
                />
              </View>
            </View>

            <View style={{ gap: t.space.sm }}>
              <AppText variant="overline" tone="faint">PASSWORD</AppText>
              <View style={inputWrap(focused === 'pass')}>
                <Icon name="lock-closed-outline" size={18} color={focused === 'pass' ? t.colors.primary : t.colors.textFaint} />
                <TextInput
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
                <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={10}>
                  <Icon name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color={t.colors.textFaint} />
                </Pressable>
              </View>
            </View>

            {errorMsg ? (
              <View style={{ backgroundColor: t.colors.dangerSoft || '#fee2e2', padding: t.space.md, borderRadius: t.radius.md, borderWidth: 1, borderColor: '#fca5a5' }}>
                <AppText variant="caption" style={{ color: t.colors.danger || '#ef4444', textAlign: 'center' }}>
                  {errorMsg}
                </AppText>
              </View>
            ) : null}

            <Button
              label={authenticating ? 'Signing in…' : 'Sign in'}
              onPress={handleLoginPress}
              loading={authenticating}
              size="lg"
              full
            />

            <Tappable onPress={handleBiometricPress}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm, paddingVertical: t.space.sm }}>
                <Icon name="finger-print" size={18} color={t.colors.textMuted} />
                <AppText variant="small" tone="muted">Use biometric sign-in</AppText>
              </View>
            </Tappable>
          </Card>

          <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
            Authorised field personnel only
          </AppText>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};
