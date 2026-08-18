import React, { useEffect, useRef } from 'react';
import {
  View, Text, Pressable, Animated, StyleProp, ViewStyle, TextStyle,
  ActivityIndicator, Platform, ScrollView,
} from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import * as Font from 'expo-font';
import * as haptics from '../../lib/haptics';

/**
 * Ionicons rendered as plain <Text> with the ionicons font.
 * This completely avoids importing the @expo/vector-icons class component,
 * which breaks under the Hermes web transform ("Objects are not valid as
 * a React child"). Instead we load the glyph map JSON + font file directly.
 */
const _glyphMap: Record<string, number> = require('@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json');
const _fontAsset = require('@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf');

/**
 * One name for both registering and rendering the font.
 *
 * Android used to render with `'ionicons'` while `loadAsync` registered `'Ionicons'`. With
 * expo-font the key passed to `loadAsync` *is* the family name, so the two never matched and
 * every icon in the Android app fell back to a tofu box. The lowercase name is a
 * react-native-vector-icons convention, which does not apply here.
 */
const FONT_FAMILY = 'Ionicons';

let _fontReady = Font.isLoaded(FONT_FAMILY);
const _fontListeners = new Set<() => void>();

(async () => {
  try {
    if (!_fontReady) {
      await Font.loadAsync({ [FONT_FAMILY]: _fontAsset });
      _fontReady = true;
    }
  } catch (err) {
    // Not silent. Swallowing this is what let the name mismatch above ship unnoticed —
    // every icon rendered as a box and nothing anywhere said why.
    console.warn('Ionicons font failed to load; icons will render as boxes:', err);
  } finally {
    _fontListeners.forEach((notify) => notify());
  }
})();

/**
 * Re-renders the icon once the font finishes loading.
 *
 * The load is a module-level promise shared by every icon, so components that mounted before
 * it resolved previously kept their tofu glyphs until something else happened to re-render
 * them — on the login screen, nothing did.
 */
function useFontReady(): boolean {
  const [ready, setReady] = React.useState(_fontReady);
  useEffect(() => {
    if (_fontReady) {
      if (!ready) setReady(true);
      return;
    }
    const notify = () => setReady(_fontReady);
    _fontListeners.add(notify);
    return () => {
      _fontListeners.delete(notify);
    };
  }, [ready]);
  return ready;
}

export type IconName = string;

export const Icon: React.FC<{ name: IconName; size?: number; color?: string; style?: StyleProp<TextStyle> }> = ({ name, size = 20, color = '#fff', style }) => {
  const ready = useFontReady();
  const glyph = _glyphMap[name as string];
  const char = glyph != null ? String.fromCodePoint(glyph) : '?';

  // Until the font is registered, render nothing at icon size rather than the glyph's
  // codepoint, which the system font draws as a tofu box.
  if (!ready) {
    return <View style={{ width: size, height: size }} />;
  }

  return (
    <Text
      selectable={false}
      style={[
        {
          fontSize: size,
          color,
          fontFamily: FONT_FAMILY,
          fontWeight: 'normal',
          fontStyle: 'normal',
          // Web needs explicit line-height to match the icon size
          ...(Platform.OS === 'web' ? { lineHeight: size * 1.2 } : {}),
        },
        style,
      ]}
    >
      {char}
    </Text>
  );
};

// ─────────────────────────────────────────────────────────── Text

type TypeKey = 'largeTitle' | 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'bodyStrong' | 'small' | 'caption' | 'overline' | 'mono';
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

  const safeChildren = typeof children === 'object' && children !== null && !(children as any).$$typeof && !Array.isArray(children)
    ? String((children as any).message || (children as any).error || JSON.stringify(children))
    : children;

  return (
    <Text numberOfLines={numberOfLines} style={[t.type[variant] as TextStyle, { color: toneMap[tone] }, style]}>
      {safeChildren}
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
  /** Passed through to Pressable so icon-only controls announce themselves to screen readers. */
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'link' | 'switch';
  /** Override the default 8px touch expansion for small controls that need a larger tap area. */
  hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number };
  /** Passed through for controls (e.g. GroupedSwitch) that need to announce checked/expanded state. */
  accessibilityState?: { checked?: boolean; disabled?: boolean; expanded?: boolean; selected?: boolean };
  children: React.ReactNode;
}> = ({ onPress, disabled, style, scaleTo, accessibilityLabel, accessibilityRole, hitSlop, accessibilityState, children }) => {
  const t = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const to = scaleTo ?? t.motion.pressScale;

  const animate = (v: number) =>
    Animated.spring(scale, { toValue: v, ...t.motion.spring }).start();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      onPress={onPress}
      disabled={disabled}
      onPressIn={() => !disabled && animate(to)}
      onPressOut={() => animate(1)}
      // Android needs an explicit larger touch target for small controls.
      hitSlop={hitSlop ?? 8}
    >
      <Animated.View style={[{ transform: [{ scale }], opacity: disabled ? 0.5 : 1 }, style]}>
        {children}
      </Animated.View>
    </Pressable>
  );
};

// ─────────────────────────────────────────────────────────── Atmosphere

/**
 * A soft neon bloom, faked without a gradient library.
 *
 * The app ships no `expo-linear-gradient` / SVG, so a true radial gradient is unavailable.
 * Stacking concentric discs of one low opacity brightens the centre where they overlap and
 * fades outward — close enough to a radial glow to give a flat ground atmospheric depth.
 * Place absolutely behind content with `pointerEvents="none"`.
 */
export const GlowBlob: React.FC<{ color: string; size: number; opacity: number }> = ({ color, size, opacity }) => (
  <View pointerEvents="none" style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    {[1, 0.72, 0.46, 0.24].map((s, i) => (
      <View
        key={i}
        style={{
          position: 'absolute', width: size * s, height: size * s, borderRadius: (size * s) / 2,
          backgroundColor: color, opacity,
        }}
      />
    ))}
  </View>
);

/**
 * The standard ambient wash: a violet bloom top-left, a cyan one bottom-right, far behind the
 * content. One component so every screen breathes the same air instead of each hand-placing
 * its own blobs.
 */
export const AmbientGlow: React.FC = () => {
  const t = useTheme();
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
      <View style={{ position: 'absolute', top: -110, left: -90 }}>
        <GlowBlob color={t.colors.primary} size={360} opacity={t.mode === 'dark' ? 0.05 : 0.045} />
      </View>
      <View style={{ position: 'absolute', bottom: -120, right: -100 }}>
        <GlowBlob color={t.colors.accent} size={320} opacity={t.mode === 'dark' ? 0.045 : 0.04} />
      </View>
    </View>
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
/**
 * A `Section` that can be folded away.
 *
 * The assayer profile grew to fifteen sections — contact, address, emergency contact,
 * availability, capability, capacity, payment, appearance, notifications, location, security,
 * accreditation, connection, help, session — every one of them expanded, every time. The
 * handful an assayer touches in a working week (am I available, are notifications on, change my
 * password) sat interleaved with details they set once when they were onboarded and never open
 * again, so finding anything meant scrolling past most of the screen.
 *
 * Collapsing rather than removing is the point: nothing is taken away, and a section someone
 * needs is one tap from where it always was. `defaultOpen` decides what greets them.
 */
export const CollapsibleSection: React.FC<{
  title: string;
  /** Open on first render. Reserve for what a working assayer needs without hunting. */
  defaultOpen?: boolean;
  /** Short line shown when collapsed, so the section is identifiable without opening it. */
  summary?: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}> = ({ title, defaultOpen = false, summary, style, children }) => {
  const t = useTheme();
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <View style={[{ gap: t.space.md }, style]}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${open ? 'expanded' : 'collapsed'}`}
        // A section header is a small target; the hit slop keeps it comfortable on a handset
        // being used one-handed in the field.
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: t.space.xs,
        }}
      >
        <View style={{ flex: 1 }}>
          <AppText variant="overline" tone="faint">{title.toUpperCase()}</AppText>
          {!open && summary ? (
            <AppText variant="caption" tone="faint" numberOfLines={1}>{summary}</AppText>
          ) : null}
        </View>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={t.colors.textFaint} />
      </Pressable>
      {open ? children : null}
    </View>
  );
};

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
  /** Neon halo under the button — for THE primary action of a screen, one per screen at most. */
  glow?: boolean;
  style?: StyleProp<ViewStyle>;
}> = ({ label, onPress, variant = 'primary', icon, size = 'md', loading, disabled, full, glow, style }) => {
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

  // A committing action (primary/accent) gets a firmer tick than a neutral/ghost one — the same
  // gradation of feedback iOS gives its own buttons.
  const handlePress = onPress
    ? () => {
        (variant === 'primary' || variant === 'accent') ? haptics.commit() : haptics.tap();
        onPress();
      }
    : undefined;

  // The halo reads as "lit" only while the button is actionable; a glowing disabled control
  // would promise more than it can do.
  const glowStyle = glow && !disabled && !loading
    ? {
        shadowColor: s.bg === 'transparent' ? t.colors.primary : s.bg,
        shadowOpacity: 0.5,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
        elevation: 10,
      }
    : null;

  return (
    <Tappable onPress={handlePress} disabled={disabled || loading} style={[full ? { alignSelf: 'stretch' } : undefined, style]}>
      <View
        style={[{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm,
          backgroundColor: s.bg, borderColor: s.border, borderWidth: s.border === 'transparent' ? 0 : 1,
          paddingVertical: pad.v, paddingHorizontal: pad.h, borderRadius: t.radius.md,
        }, glowStyle]}
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
  /**
   * Spoken description. These buttons are icon-only, so without it a screen reader announces
   * nothing useful — "button" and no indication of what it does.
   */
  accessibilityLabel?: string;
}> = ({ icon, onPress, tone = 'default', badge, size = 42, accessibilityLabel }) => {
  const t = useTheme();
  const fg = tone === 'primary' ? t.colors.primary : tone === 'danger' ? t.colors.danger : t.colors.textMuted;
  const bg = tone === 'primary' ? t.colors.primarySoft : tone === 'danger' ? t.colors.dangerSoft : t.colors.surfaceAlt;

  return (
    <Tappable onPress={onPress} scaleTo={0.9} accessibilityLabel={accessibilityLabel} accessibilityRole="button">
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
          <Pressable
            key={o.key}
            onPress={() => { if (!active) haptics.select(); onChange(o.key); }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={o.label}
            style={{ flex: 1, paddingVertical: 9, alignItems: 'center' }}
          >
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

// ─────────────────────────────────────────────────────────── Apple-style grouped lists
//
// Settings/Contacts/Health on iOS share one signature: rows that belong together sit inside a
// SINGLE rounded container, divided by hairlines that start after the leading icon rather than
// full-bleed — not a stack of individually-bordered cards. `GroupedSection` is the container +
// small-caps header; `GroupedRow` is one row inside it. The divider is drawn by the section
// itself (via GroupedRow's own bottom hairline suppressed on the last child) so callers never
// have to remember to add/omit a <Divider> by hand — the old ProfileScreen pattern of a Card
// full of manually-placed <Divider spacing={...}/> between rows is exactly the seam this removes.

type GroupedTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** The leading tinted square icon badge — every row's category color lives here. */
export const GroupedIconTile: React.FC<{ icon: IconName; tone?: GroupedTone; size?: number }> = ({
  icon, tone = 'neutral', size = 29,
}) => {
  const t = useTheme();
  const tones: Record<GroupedTone, { bg: string; fg: string }> = {
    primary: { bg: t.colors.primarySoft, fg: t.colors.primary },
    accent: { bg: t.colors.accentSoft, fg: t.colors.accent },
    success: { bg: t.colors.successSoft, fg: t.colors.success },
    warning: { bg: t.colors.warningSoft, fg: t.colors.warning },
    danger: { bg: t.colors.dangerSoft, fg: t.colors.danger },
    info: { bg: t.colors.infoSoft, fg: t.colors.info },
    neutral: { bg: t.colors.surfacePress, fg: t.colors.textMuted },
  };
  const c = tones[tone];
  return (
    <View style={{
      width: size, height: size, borderRadius: t.radius.sm,
      backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center',
    }}>
      <Icon name={icon} size={Math.round(size * 0.56)} color={c.fg} />
    </View>
  );
};

/**
 * A native-shaped switch, hand-built rather than `react-native's <Switch>`.
 *
 * The platform `<Switch>` renders its own OS chrome — Material on Android — which is exactly
 * wrong for an app whose whole point here is to *look* like iOS regardless of platform. This
 * draws the pill track (51×31) and circular thumb (27) directly from theme tokens so it matches
 * on both platforms, with a spring-animated thumb slide for the same tactile feel as the rest of
 * the app's controls (see Tappable, Segmented).
 */
export const GroupedSwitch: React.FC<{
  value: boolean;
  onChange: (v: boolean) => void;
  accessibilityLabel?: string;
  disabled?: boolean;
}> = ({ value, onChange, accessibilityLabel, disabled }) => {
  const t = useTheme();
  const TRACK_W = 51;
  const TRACK_H = 31;
  const THUMB = 27;
  const PAD = 2;
  const x = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(x, { toValue: value ? 1 : 0, ...t.motion.spring }).start();
  }, [value, x, t.motion.spring]);

  return (
    <Tappable
      onPress={disabled ? undefined : () => { haptics.select(); onChange(!value); }}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      scaleTo={0.94}
    >
      <View style={{
        width: TRACK_W, height: TRACK_H, borderRadius: TRACK_H / 2,
        backgroundColor: value ? t.colors.primary : t.colors.surfacePress,
        borderWidth: 1, borderColor: value ? t.colors.primary : t.colors.borderStrong,
        justifyContent: 'center',
      }}>
        <Animated.View style={{
          width: THUMB, height: THUMB, borderRadius: THUMB / 2,
          backgroundColor: value ? t.colors.onPrimary : t.colors.text,
          transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [PAD, TRACK_W - THUMB - PAD] }) }],
          ...(t.elevation(1) as object),
        }} />
      </View>
    </Tappable>
  );
};

/** One row inside a `GroupedSection`. Never used standalone — its hairline divider is owned by
 *  the parent so the last row in a group never draws a trailing line. */
export const GroupedRow: React.FC<{
  icon?: IconName;
  tone?: GroupedTone;
  label: string;
  hint?: string;
  /** A muted value shown before the chevron/switch, e.g. the current setting. */
  value?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  accessibilityLabel?: string;
  /** Internal: whether to draw the inset hairline beneath this row. Set by GroupedSection. */
  _showDivider?: boolean;
}> = ({ icon, tone = 'neutral', label, hint, value, trailing, onPress, chevron, accessibilityLabel, _showDivider }) => {
  const t = useTheme();
  // Divider starts after the icon tile, matching Apple's inset-hairline signature — a full-bleed
  // line under every row is what makes a list read as a plain table instead of a grouped list.
  const insetLeft = icon ? 29 + t.space.md : t.space.lg;

  const body = (
    <View>
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: t.space.md,
        paddingVertical: t.space.md, paddingHorizontal: t.space.lg, minHeight: 44,
      }}>
        {icon && <GroupedIconTile icon={icon} tone={tone} />}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <AppText variant="body" tone={tone === 'danger' ? 'danger' : 'default'}>{label}</AppText>
          {hint ? <AppText variant="caption" tone="faint">{hint}</AppText> : null}
        </View>
        {value ? <AppText variant="body" tone="muted" numberOfLines={1} style={{ maxWidth: 140 }}>{value}</AppText> : null}
        {trailing}
        {chevron && <Icon name="chevron-forward" size={16} color={t.colors.textFaint} />}
      </View>
      {_showDivider && (
        <View style={{ height: 1, backgroundColor: t.colors.border, marginLeft: insetLeft }} />
      )}
    </View>
  );

  return onPress ? (
    <Tappable onPress={onPress} scaleTo={0.99} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}>
      {body}
    </Tappable>
  ) : body;
};

/**
 * The rounded container + small-caps header that turns a run of `GroupedRow`s into an Apple-
 * style grouped list. Dividers between rows are inserted here (via `_showDivider`) rather than
 * left to each row, so a caller can never accidentally leave a trailing line under the last row
 * or forget one between two — the single most common way a hand-rolled version of this drifts
 * from the real thing.
 */
export const GroupedSection: React.FC<{
  title?: string;
  /** Small note under the header, e.g. "Held by HR for payouts". */
  footnote?: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}> = ({ title, footnote, style, children }) => {
  const t = useTheme();
  const rows = React.Children.toArray(children).filter(Boolean);

  return (
    <View style={style}>
      {title ? (
        // Generous top margin, tighter bottom margin — Apple's headers sit closer to the group
        // they label than to the group above them, which is what makes scanning a long settings
        // screen feel like reading paragraphs rather than one unbroken list.
        <AppText
          variant="overline"
          tone="faint"
          style={{ marginTop: t.space.xl, marginBottom: t.space.sm, marginLeft: t.space.lg, letterSpacing: 0.6 }}
        >
          {title.toUpperCase()}
        </AppText>
      ) : null}
      <View style={{
        backgroundColor: t.colors.surface,
        borderRadius: t.radius.groupedInset,
        borderWidth: 1,
        borderColor: t.colors.border,
        overflow: 'hidden',
      }}>
        {rows.map((child, i) => {
          if (!React.isValidElement(child)) return child;
          return React.cloneElement(child as React.ReactElement<any>, {
            key: (child as any).key ?? i,
            _showDivider: i < rows.length - 1,
          });
        })}
      </View>
      {footnote ? (
        <AppText variant="caption" tone="faint" style={{ marginTop: t.space.sm, marginLeft: t.space.lg }}>
          {footnote}
        </AppText>
      ) : null}
    </View>
  );
};
