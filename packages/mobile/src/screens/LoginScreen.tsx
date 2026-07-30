import React, { useState } from 'react';
import { SafeAreaView, ScrollView, View, Text, TextInput, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';

interface LoginScreenProps {
  loginUsername: string;
  loginPassword: string;
  authenticating: boolean;
  onChangeUsername: (val: string) => void;
  onChangePassword: (val: string) => void;
  onLogin: () => void;
  onBiometricLogin: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({
  loginUsername,
  loginPassword,
  authenticating,
  onChangeUsername,
  onChangePassword,
  onLogin,
  onBiometricLogin,
}) => {
  const [showPassword, setShowPassword] = useState(false);
  const [usePinMode, setUsePinMode] = useState(false);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#090d16', minHeight: '100vh' as any }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        {/* Brand Logo */}
        <View style={{ alignItems: 'center', marginBottom: 28 }}>
          <View style={{
            width: 72,
            height: 72,
            borderRadius: 24,
            backgroundColor: '#4f46e5',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.2)',
            shadowColor: '#4f46e5',
            shadowOffset: { width: 0, height: 10 },
            shadowOpacity: 0.5,
            shadowRadius: 20,
            elevation: 12,
          }}>
            <Text style={{ fontSize: 32, fontWeight: '900', color: '#ffffff', fontFamily: Platform.OS === 'web' ? 'Outfit, sans-serif' : undefined }}>
              S
            </Text>
          </View>
          <Text style={{ fontSize: 26, fontWeight: '900', color: '#ffffff', letterSpacing: 0.5, textAlign: 'center', fontFamily: Platform.OS === 'web' ? 'Outfit, sans-serif' : undefined }}>
            SUMERU GLOBAL
          </Text>
          <Text style={{ fontSize: 11, color: '#38bdf8', fontWeight: '800', marginTop: 4, letterSpacing: 2, textTransform: 'uppercase' }}>
            Audit & Support Suite
          </Text>
        </View>

        {/* Glass Login Card */}
        <View style={{
          width: '100%',
          maxWidth: 420,
          backgroundColor: 'rgba(30, 41, 59, 0.7)',
          borderRadius: 28,
          padding: 28,
          borderWidth: 1,
          borderColor: 'rgba(99, 102, 241, 0.2)',
          ...Platform.select({ web: { backdropFilter: 'blur(16px)' } as any }),
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 12 },
          shadowOpacity: 0.5,
          shadowRadius: 30,
          elevation: 12,
        }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: '#ffffff', textAlign: 'center', marginBottom: 4, fontFamily: Platform.OS === 'web' ? 'Outfit, sans-serif' : undefined }}>
            Welcome Back
          </Text>
          <Text style={{ fontSize: 13, color: '#64748b', textAlign: 'center', marginBottom: 28, lineHeight: 19 }}>
            Sign in to access your schedule, download PDFs, and submit audit reports.
          </Text>

          {/* Username Input */}
          <View style={{ marginBottom: 18 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
              Assayer Code / Phone
            </Text>
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: 'rgba(15, 23, 42, 0.6)',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderRadius: 14,
              paddingHorizontal: 14,
            }}>
              <TextInput
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  fontSize: 15,
                  color: '#ffffff',
                  fontWeight: '600',
                }}
                placeholder="e.g. AS-01 or +919876543210"
                placeholderTextColor="#475569"
                value={loginUsername}
                onChangeText={onChangeUsername}
                autoCapitalize="none"
              />
            </View>
          </View>

          {/* Login Mode Selector */}
          <View style={{ flexDirection: 'row', backgroundColor: 'rgba(15, 23, 42, 0.6)', padding: 4, borderRadius: 12, marginBottom: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}>
            <TouchableOpacity
              style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: !usePinMode ? '#4f46e5' : 'transparent', alignItems: 'center' }}
              onPress={() => setUsePinMode(false)}
            >
              <Text style={{ fontSize: 12, fontWeight: '800', color: !usePinMode ? '#ffffff' : '#94a3b8' }}>Password</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: usePinMode ? '#4f46e5' : 'transparent', alignItems: 'center' }}
              onPress={() => setUsePinMode(true)}
            >
              <Text style={{ fontSize: 12, fontWeight: '800', color: usePinMode ? '#ffffff' : '#94a3b8' }}>4-Digit PIN</Text>
            </TouchableOpacity>
          </View>

          {/* Password or PIN Input */}
          <View style={{ marginBottom: 24 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>
                {usePinMode ? '4-Digit Security PIN' : 'Password'}
              </Text>
            </View>
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: 'rgba(15, 23, 42, 0.6)',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderRadius: 14,
              paddingHorizontal: 14,
            }}>
              <TextInput
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  fontSize: usePinMode ? 20 : 15,
                  letterSpacing: usePinMode ? 6 : 0,
                  color: '#ffffff',
                  fontWeight: '600',
                }}
                placeholder={usePinMode ? '• • • •' : 'Enter your password'}
                placeholderTextColor="#475569"
                secureTextEntry={!showPassword}
                keyboardType={usePinMode ? 'numeric' : 'default'}
                maxLength={usePinMode ? 4 : undefined}
                value={loginPassword}
                onChangeText={onChangePassword}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={{ padding: 4 }}>
                <Text style={{ fontSize: 13, color: '#818cf8', fontWeight: '700' }}>
                  {showPassword ? 'Hide' : 'Show'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Login Button */}
          <TouchableOpacity
            style={{
              backgroundColor: '#6366f1',
              paddingVertical: 16,
              borderRadius: 14,
              alignItems: 'center',
              justifyContent: 'center',
              shadowColor: '#6366f1',
              shadowOffset: { width: 0, height: 6 },
              shadowOpacity: 0.4,
              shadowRadius: 14,
              elevation: 6,
            }}
            onPress={onLogin}
            disabled={authenticating}
          >
            {authenticating ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={{ color: '#ffffff', fontWeight: '800', fontSize: 15, letterSpacing: 0.3 }}>
                Sign In
              </Text>
            )}
          </TouchableOpacity>

          {/* Divider */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 22 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: 'rgba(255, 255, 255, 0.08)' }} />
            <Text style={{ color: '#475569', fontSize: 10, paddingHorizontal: 12, fontWeight: '800', letterSpacing: 1 }}>
              OR
            </Text>
            <View style={{ flex: 1, height: 1, backgroundColor: 'rgba(255, 255, 255, 0.08)' }} />
          </View>

          {/* Biometric Button */}
          <TouchableOpacity
            style={{
              backgroundColor: 'rgba(99, 102, 241, 0.1)',
              borderWidth: 1,
              borderColor: 'rgba(99, 102, 241, 0.35)',
              paddingVertical: 14,
              borderRadius: 14,
              alignItems: 'center',
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 10,
            }}
            onPress={onBiometricLogin}
            disabled={authenticating}
          >
            <Text style={{ color: '#a5b4fc', fontSize: 14, fontWeight: '800', letterSpacing: 0.2 }}>
              Use Biometrics
            </Text>
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <View style={{ alignItems: 'center', marginTop: 24 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10b981' }} />
            <Text style={{ fontSize: 12, color: '#64748b', fontWeight: '600' }}>
              Encrypted Connection
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
