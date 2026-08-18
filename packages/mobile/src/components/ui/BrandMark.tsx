import React, { useEffect, useRef } from 'react';
import { View, Animated, Easing, Image } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';

/**
 * The Orbit mark — a living logo, not a static drawing.
 *
 * Two satellites revolve around a core at different speeds and opposite directions, and the
 * core breathes with a pulsing halo. All of it runs on the native driver (transform + opacity
 * only), so it animates off the JS thread and stays smooth.
 *
 * Shared between LoginScreen and the app's boot screen (App.tsx) — the boot screen used to be a
 * bare `ActivityIndicator` on a blank background, which is a jarring first paint (and, on a slow
 * network, a long one) compared to the identity-forward sign-in screen right after it. One mark,
 * used in both places, means "the app is doing something" and "welcome to Orbit" are the same
 * moment instead of a spinner followed by a logo.
 */
export const OrbitMark: React.FC<{ size?: number }> = ({ size = 120 }) => {
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
        The company's own mark at the core. 13:10 keeps the asset's 208x160 ratio; it sits
        inside the inner ring rather than filling it so the revolving satellite never crosses
        the artwork.
      */}
      <Image
        source={require('../../../assets/sumeru-logo.png')}
        style={{ width: core * 1.56, height: core * 1.2, resizeMode: 'contain' }}
        accessibilityLabel="Sumeru Global"
      />
    </View>
  );
};

/**
 * Full-screen boot state: the mark, plus a short line of context.
 *
 * Distinct from `authenticating` staying true for a long time by design — after the AuthContext
 * fix, this should only ever be on screen for the time it takes to read the OS keystore
 * (milliseconds), not to wait on the network. It still needs to look intentional rather than
 * broken for that brief moment, and it is what a very slow first cold-start (e.g. Metro's own
 * bundle load) sits on before anything else can render.
 */
export const BrandLoadingScreen: React.FC<{ label?: string }> = ({ label = 'Starting Orbit…' }) => {
  const t = useTheme();
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, [fade]);

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg, justifyContent: 'center', alignItems: 'center', gap: t.space.lg }}>
      <OrbitMark size={110} />
      <Animated.Text style={{
        opacity: fade, color: t.colors.textMuted, fontSize: 13, fontWeight: '600', letterSpacing: 1.5,
      }}>
        {label.toUpperCase()}
      </Animated.Text>
    </View>
  );
};
