import React, { useEffect, useRef } from 'react';
import {
  View, Text, Pressable, Animated, StyleProp, ViewStyle, TextStyle,
  ActivityIndicator, Platform, ScrollView,
} from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import * as Font from 'expo-font';

/**
 * Ionicons glyph map — loaded from the @expo/vector-icons data files.
 * We render icons directly as <Text> with the ionicons font family,
 * bypassing the @expo/vector-icons class component entirely.
 * This avoids the Hermes bytecode issue where the class component's
 * React.Component prototype chain gets broken during compilation,
 * causing "Objects are not valid as a React child" crashes.
 */
const _glyphMap: Record<string, number> = require('@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json');
const _fontAsset = require('@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf');

// Ensure the Ionicons font is loaded
let _fontLoaded = Font.isLoaded('ionicons');
if (!_fontLoaded) {
  Font.loadAsync({ ionicons: _fontAsset }).then(() => { _fontLoaded = true; }).catch(() => {});
}

type IconName = keyof typeof _glyphMap;

export const Icon: React.FC<{ name: IconName; size?: number; color?: string; style?: StyleProp<TextStyle> }> = ({ name, size = 20, color = '#fff', style }) => {
  const glyph = _glyphMap[name as string];
  const char = glyph != null ? String.fromCodePoint(glyph) : '?';

  return (
    <Text
      selectable={false}
      style={[
        {
          fontSize: size,
          color,
          fontFamily: Platform.OS === 'android' ? 'ionicons' : 'Ionicons',
          fontWeight: 'normal',
          fontStyle: 'normal',
        },
        style,
      ]}
    >
      {char}
    </Text>
  );
};

// ─────────────────────────────────────────────────────────── Text

type TypeKey = 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'bodyStrong' | 'small' | 'caption' | 'overline' | 'mono';
type ToneKey = 'default' | 'muted' | 'faint' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'onPrimary' | 'onAccent';

export const AppText: React.FC<{
  variant?: TypeKey;
  tone?: ToneKey;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  children: React.ReactNode;
}> = ({ variant = 'body', tone = 'default', style, numberOfLines, children }) => {
  const t = useTheme();
  const toneMap: Record<ToneKey, string> = {
    default: t.colors.text,
    muted: t.colors.textMuted,
    faint: t.colors.textFaint,
    primary: t.colors.primary,
    accent: t.colors.accent,
    success: t.colors.success,
    warning: t.colors.warning,
    danger: t.colors.danger,
    info: t.colors.info,
    onPrimary: t.colors.onPrimary,
    onAccent: t.colors.onAccent,
  };
  return (
    <Text numberOfLines={numberOfLines} style={[t.type[variant] as TextStyle, { color: toneMap[tone] }, style]}>
      {children}
    </Text>
  );
};

// ─────────────────────────────────────────────────────────── Pressable with feel

/** Scales down slightly under the finger — the tactile cue the old app had none of. */
export const Tappable: React.FC<{
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  scaleTo?: number;
  children: React.ReactNode;
}> = ({ onPress, disabled, style, scaleTo, children }) => {
  const t = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const to = scaleTo ?? t.motion.pressScale;

  const animate = (v: number) =>
    Animated.spring(scale, { toValue: v, ...t.motion.spring }).start();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      onPressIn={() => !disabled && animate(to)}
      onPressOut={() => animate(1)}
      // Android needs an explicit larger touch target for small controls.
      hitSlop={8}
    >
      <Animated.View style={[{ transform: [{ scale }], opacity: disabled ? 0.5 : 1 }, style]}>
        {children}
      </Animated.View>
    </Pressable>
  );
};

// ─────────────────────────────────────────────────────────── Surfaces

export const Card: React.FC<{
  level?: 0 | 1 | 2 | 3;
  padded?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}> = ({ level = 1, padded = true, onPress, style, children }) => {
  const t = useTheme();
  const body = (
    <View
      style={[
        {
          backgroundColor: t.colors.surface,
          borderRadius: t.radius.xl,
          borderWidth: 1,
          borderColor: t.colors.border,
          padding: padded ? t.space.lg : 0,
          overflow: 'hidden',
        },
        t.elevation(level),
        style,
      ]}
    >
      {children}
    </View>
  );
  return onPress ? <Tappable onPress={onPress} scaleTo={0.985}>{body}</Tappable> : body;
};

/** A page section with an optional overline heading and trailing control. */
export const Section: React.FC<{
  title?: string;
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}> = ({ title, action, style, children }) => {
  const t = useTheme();
  return (
    <View style={[{ gap: t.space.md }, style]}>
      {(title || action) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: t.space.xs }}>
          {title ? <AppText variant="overline" tone="faint">{title.toUpperCase()}</AppText> : <View />}
          {action}
        </View>
      )}
      {children}
    </View>
  );
};

// ─────────────────────────────────────────────────────────── Buttons

type ButtonVariant = 'primary' | 'accent' | 'neutral' | 'ghost' | 'danger';

export const Button: React.FC<{
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  full?: boolean;
  style?: StyleProp<ViewStyle>;
}> = ({ label, onPress, variant = 'primary', icon, size = 'md', loading, disabled, full, style }) => {
  const t = useTheme();

  const spec: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: t.colors.primary, fg: t.colors.onPrimary, border: 'transparent' },
    accent: { bg: t.colors.accent, fg: t.colors.onAccent, border: 'transparent' },
    neutral: { bg: t.colors.surfaceAlt, fg: t.colors.text, border: t.colors.border },
    ghost: { bg: 'transparent', fg: t.colors.textMuted, border: 'transparent' },
    danger: { bg: t.colors.dangerSoft, fg: t.colors.danger, border: 'transparent' },
  };
  const s = spec[variant];
  const pad = { sm: { v: 8, h: 14 }, md: { v: 12, h: 18 }, lg: { v: 15, h: 22 } }[size];
  const textVariant: TypeKey = size === 'sm' ? 'caption' : 'bodyStrong';

  return (
    <Tappable onPress={onPress} disabled={disabled || loading} style={[full ? { alignSelf: 'stretch' } : undefined, style]}>
      <View
        style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm,
          backgroundColor: s.bg, borderColor: s.border, borderWidth: s.border === 'transparent' ? 0 : 1,
          paddingVertical: pad.v, paddingHorizontal: pad.h, borderRadius: t.radius.md,
        }}
      >
        {loading ? (
          <ActivityIndicator size="small" color={s.fg} />
        ) : (
          <>
            {icon && <Icon name={icon} size={size === 'sm' ? 14 : 17} color={s.fg} />}
            <Text style={[t.type[textVariant] as TextStyle, { color: s.fg }]}>{label}</Text>
          </>
        )}
      </View>
    </Tappable>
  );
};

export const IconButton: React.FC<{
  icon: IconName;
  onPress?: () => void;
  tone?: 'default' | 'primary' | 'danger';
  badge?: number;
  size?: number;
}> = ({ icon, onPress, tone = 'default', badge, size = 42 }) => {
  const t = useTheme();
  const fg = tone === 'primary' ? t.colors.primary : tone === 'danger' ? t.colors.danger : t.colors.textMuted;
  const bg = tone === 'primary' ? t.colors.primarySoft : tone === 'danger' ? t.colors.dangerSoft : t.colors.surfaceAlt;

  return (
    <Tappable onPress={onPress} scaleTo={0.9}>
      <View style={{
        width: size, height: size, borderRadius: t.radius.md,
        backgroundColor: bg, borderWidth: 1, borderColor: t.colors.border,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon name={icon} size={Math.round(size * 0.45)} color={fg} />
        {badge != null && badge > 0 && (
          <View style={{
            position: 'absolute', top: -4, right: -4, minWidth: 19, height: 19, borderRadius: 10,
            paddingHorizontal: 5, backgroundColor: t.colors.danger,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 2, borderColor: t.colors.bg,
          }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        )}
      </View>
    </Tappable>
  );
};

// ─────────────────────────────────────────────────────────── Badges & chips

type BadgeTone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export const Badge: React.FC<{ label: string; tone?: BadgeTone; icon?: IconName; dot?: boolean }> = ({
  label, tone = 'neutral', icon, dot,
}) => {
  const t = useTheme();
  const map: Record<BadgeTone, { bg: string; fg: string }> = {
    neutral: { bg: t.colors.surfacePress, fg: t.colors.textMuted },
    primary: { bg: t.colors.primarySoft, fg: t.colors.primary },
    accent: { bg: t.colors.accentSoft, fg: t.colors.accent },
    success: { bg: t.colors.successSoft, fg: t.colors.success },
    warning: { bg: t.colors.warningSoft, fg: t.colors.warning },
    danger: { bg: t.colors.dangerSoft, fg: t.colors.danger },
    info: { bg: t.colors.infoSoft, fg: t.colors.info },
  };
  const c = map[tone];
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 5,
      backgroundColor: c.bg, paddingHorizontal: 9, paddingVertical: 5, borderRadius: t.radius.pill,
    }}>
      {dot && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg }} />}
      {icon && <Icon name={icon} size={11} color={c.fg} />}
      <Text style={[t.type.caption as TextStyle, { color: c.fg }]}>{label}</Text>
    </View>
  );
};

/** Horizontal segmented control with a spring-animated selection pill. */
export const Segmented: React.FC<{
  options: { key: string; label: string; count?: number }[];
  value: string;
  onChange: (key: string) => void;
}> = ({ options, value, onChange }) => {
  const t = useTheme();
  const [width, setWidth] = React.useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const index = Math.max(0, options.findIndex((o) => o.key === value));
  const seg = width > 0 ? (width - 8) / options.length : 0;

  useEffect(() => {
    Animated.spring(x, { toValue: index * seg, ...t.motion.spring }).start();
  }, [index, seg, x, t.motion.spring]);

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        flexDirection: 'row', backgroundColor: t.colors.surfaceAlt, borderRadius: t.radius.md,
        padding: 4, borderWidth: 1, borderColor: t.colors.border, position: 'relative',
      }}
    >
      {seg > 0 && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute', top: 4, left: 4, bottom: 4, width: seg,
            backgroundColor: t.colors.surface, borderRadius: t.radius.sm,
            transform: [{ translateX: x }],
            ...(t.elevation(1) as object),
          }}
        />
      )}
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable key={o.key} onPress={() => onChange(o.key)} style={{ flex: 1, paddingVertical: 9, alignItems: 'center' }}>
            <Text
              numberOfLines={1}
              style={[t.type.caption as TextStyle, { color: active ? t.colors.text : t.colors.textMuted }]}
            >
              {o.label}{o.count != null ? `  ${o.count}` : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

// ─────────────────────────────────────────────────────────── Feedback

export const EmptyState: React.FC<{
  icon: IconName;
  title: string;
  body?: string;
  action?: React.ReactNode;
}> = ({ icon, title, body, action }) => {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: t.space['4xl'], paddingHorizontal: t.space.xl, gap: t.space.md }}>
      <View style={{
        width: 66, height: 66, borderRadius: 33, alignItems: 'center', justifyContent: 'center',
        backgroundColor: t.colors.surfaceAlt, borderWidth: 1, borderColor: t.colors.border,
      }}>
        <Icon name={icon} size={28} color={t.colors.textFaint} />
      </View>
      <AppText variant="h3" style={{ textAlign: 'center' }}>{title}</AppText>
      {body && <AppText variant="small" tone="muted" style={{ textAlign: 'center', maxWidth: 300 }}>{body}</AppText>}
      {action}
    </View>
  );
};

/** Shimmering placeholder — replaces "Loading..." text with something that reads as progress. */
export const Skeleton: React.FC<{ height?: number; width?: number | string; radius?: number; style?: StyleProp<ViewStyle> }> = ({
  height = 16, width = '100%', radius: r, style,
}) => {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={[
        { height, width: width as any, borderRadius: r ?? t.radius.sm, backgroundColor: t.colors.surfacePress, opacity: pulse },
        style,
      ]}
    />
  );
};

/** Fades and lifts children in — used for list items so content doesn't pop. */
export const FadeIn: React.FC<{ delay?: number; children: React.ReactNode; style?: StyleProp<ViewStyle> }> = ({
  delay = 0, children, style,
}) => {
  const t = useTheme();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: t.motion.base, delay, useNativeDriver: true }).start();
  }, [v, delay, t.motion.base]);
  return (
    <Animated.View
      style={[
        { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
};

// ─────────────────────────────────────────────────────────── Data display

/** A labelled figure. The building block of every summary strip in the app. */
export const StatTile: React.FC<{
  label: string;
  value: string | number;
  icon?: IconName;
  tone?: BadgeTone;
  hint?: string;
  onPress?: () => void;
}> = ({ label, value, icon, tone = 'neutral', hint, onPress }) => {
  const t = useTheme();
  const fg = {
    neutral: t.colors.text, primary: t.colors.primary, accent: t.colors.accent,
    success: t.colors.success, warning: t.colors.warning, danger: t.colors.danger, info: t.colors.info,
  }[tone];

  return (
    <Card level={1} onPress={onPress} style={{ flex: 1, minWidth: 140 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, marginBottom: t.space.sm }}>
        {icon && <Icon name={icon} size={15} color={fg} />}
        <AppText variant="overline" tone="faint" numberOfLines={1}>{label.toUpperCase()}</AppText>
      </View>
      <Text style={[t.type.h1 as TextStyle, { color: fg }]} numberOfLines={1}>{value}</Text>
      {hint && <AppText variant="caption" tone="faint" numberOfLines={1} style={{ marginTop: 2 }}>{hint}</AppText>}
    </Card>
  );
};

/** Key/value row for detail panels. */
export const DetailRow: React.FC<{ label: string; value?: React.ReactNode; icon?: IconName }> = ({ label, value, icon }) => {
  const t = useTheme();
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: t.space.md,
      paddingVertical: t.space.md, borderBottomWidth: 1, borderBottomColor: t.colors.border,
    }}>
      {icon && <Icon name={icon} size={16} color={t.colors.textFaint} />}
      <AppText variant="small" tone="muted" style={{ flex: 1 }}>{label}</AppText>
      {typeof value === 'string' || typeof value === 'number'
        ? <AppText variant="bodyStrong" numberOfLines={1}>{value}</AppText>
        : (value ?? <AppText variant="body" tone="faint">—</AppText>)}
    </View>
  );
};

/** Horizontal scroller for stat strips — keeps tiles readable instead of squashing them. */
export const StatStrip: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: t.space.md, paddingHorizontal: t.space.xs, paddingVertical: 2 }}
    >
      {children}
    </ScrollView>
  );
};

/** Circular initials avatar with a deterministic tone per person. */
export const Avatar: React.FC<{ name: string; size?: number }> = ({ name, size = 44 }) => {
  const t = useTheme();
  const initials = (name || '?')
    .split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const tones = [t.colors.primary, t.colors.accent, t.colors.info, t.colors.success];
  const tone = tones[Math.abs(name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % tones.length];

  return (
    <View style={{
      width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center',
      backgroundColor: tone + (t.mode === 'dark' ? '26' : '1F'),
      borderWidth: 1, borderColor: tone + '55',
    }}>
      <Text style={{ color: tone, fontWeight: '800', fontSize: size * 0.36 }}>{initials}</Text>
    </View>
  );
};

/** Thin progress bar used for capacity/completion. */
export const ProgressBar: React.FC<{ value: number; tone?: BadgeTone }> = ({ value, tone = 'primary' }) => {
  const t = useTheme();
  const pct = Math.max(0, Math.min(1, value));
  const w = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Width can't use the native driver, so this one animates on the JS thread —
    // acceptable for a single short bar, unlike transform-based animations.
    Animated.timing(w, { toValue: pct, duration: 420, useNativeDriver: false }).start();
  }, [pct, w]);
  const fg = {
    neutral: t.colors.textMuted, primary: t.colors.primary, accent: t.colors.accent,
    success: t.colors.success, warning: t.colors.warning, danger: t.colors.danger, info: t.colors.info,
  }[tone];
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: t.colors.surfacePress, overflow: 'hidden' }}>
      <Animated.View style={{
        height: '100%', borderRadius: 3, backgroundColor: fg,
        width: w.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
      }} />
    </View>
  );
};

export const Divider: React.FC<{ spacing?: number }> = ({ spacing }) => {
  const t = useTheme();
  return <View style={{ height: 1, backgroundColor: t.colors.border, marginVertical: spacing ?? t.space.md }} />;
};
