import React, { useEffect, useRef } from 'react';
import {
  View, Text, Pressable, Animated, StyleProp, ViewStyle, TextStyle,
  ActivityIndicator, Platform, ScrollView, TextInput, Modal, KeyboardAvoidingView,
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
  accessibilityRole?: 'button' | 'link' | 'switch' | 'tab';
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
      {/*
        A visible aurora wash, not a whisper. The original 0.04-0.05 opacity was so faint it
        barely survived a screenshot — flat and closer to plain dark-grey than to the neon
        identity the rest of the kit commits to. This is the single biggest lever for reading as
        a premium 2020s app instead of a bordered-forms one, so it's turned up meaningfully.
      */}
      <View style={{ position: 'absolute', top: -140, left: -120 }}>
        <GlowBlob color={t.colors.primary} size={460} opacity={t.mode === 'dark' ? 0.16 : 0.10} />
      </View>
      <View style={{ position: 'absolute', bottom: -160, right: -130 }}>
        <GlowBlob color={t.colors.accent} size={420} opacity={t.mode === 'dark' ? 0.13 : 0.09} />
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
  /*
   * A floating panel reads as lifted through shadow and a tone step off the page — not through
   * a solid outline. The full-strength `border` token (visible ~8-10% white/ink) drawn around
   * every single card, nested inside screens that are themselves bordered boxes of bordered
   * boxes, is what actually reads as "old forms UI." A hairline is kept — a card with literally
   * no edge can look undefined on the near-black palette — but at a fraction of the contrast, so
   * it reads as a glass edge rather than a rectangle someone drew.
   */
  const hairline = level === 0 ? t.colors.border : (t.mode === 'dark' ? 'rgba(255,255,255,0.045)' : 'rgba(20,18,40,0.06)');
  const body = (
    <View
      style={[
        {
          backgroundColor: t.colors.surface,
          borderRadius: t.radius.xl,
          borderWidth: 1,
          borderColor: hairline,
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
        if (variant === 'primary' || variant === 'accent') haptics.commit(); else haptics.tap();
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
            // Sized around a 12pt count — the readable floor for this app. It was 10, which is
            // below every size in the type scale, on a number that tells a field worker how much
            // is waiting for them. Kept in step with the tab dock badge in AppShell so the same
            // count never appears at two different sizes.
            position: 'absolute', top: -5, right: -5, minWidth: 21, height: 21, borderRadius: 11,
            paddingHorizontal: 5, backgroundColor: t.colors.danger,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 2, borderColor: t.colors.bg,
          }}>
            <Text style={{ color: t.colors.onDanger, fontSize: 12, fontWeight: '800' }}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        )}
      </View>
    </Tappable>
  );
};

// ─────────────────────────────────────────────────────────── Text input

/**
 * The themed text field ten different screens and modals used to hand-roll on their own —
 * `LoginScreen`, `ChangePasswordScreen`, `SelfRegistrationScreen`'s `LabeledInput`,
 * `ProfileScreen`'s `FieldInput`, and half a dozen modal forms each kept an independent copy of
 * the same field, including independently rediscovering the same Android focus bug below.
 *
 * Focus is signalled by border colour ONLY — never by adding shadow/elevation. Toggling
 * elevation/shadow on an input's wrapper the instant it gains focus recreates the native view
 * under Fabric (always on in Expo Go), which drops the just-granted IME focus — verified on the
 * emulator, `dumpsys input_method` showed `mServedView=null` after every tap while a focus glow
 * was present. A plain border-colour prop update on the same view does not have this problem.
 */
export const Input: React.FC<{
  /** Rendered upper-cased, same as `GroupedSection`'s title — pass it in whatever case reads
   *  best in translation files (most are stored pre-capitalised; this makes the ones that aren't,
   *  like ProfileScreen's field labels, match without every call site remembering to transform). */
  label?: string;
  value: string;
  onChangeText?: (v: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  placeholder?: string;
  icon?: IconName;
  /** e.g. a show/hide-password toggle, rendered after the field. */
  rightAccessory?: React.ReactNode;
  hint?: string;
  error?: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'numeric' | 'number-pad' | 'phone-pad' | 'email-address' | 'url';
  autoCapitalize?: 'none' | 'characters' | 'words' | 'sentences';
  autoCorrect?: boolean;
  multiline?: boolean;
  maxLength?: number;
  returnKeyType?: 'done' | 'go' | 'next' | 'search' | 'send';
  blurOnSubmit?: boolean;
  onSubmitEditing?: () => void;
  /** 'lg' matches LoginScreen's 56pt fields; 'md' (default) matches every other form in the app. */
  size?: 'md' | 'lg';
  /** A flat, non-editable display in place of the field — the value is HR-maintained. */
  readOnly?: boolean;
  /** Same flat display as `readOnly`, plus a lock icon and the (already-translated) reason. */
  lockedReason?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  inputRef?: React.RefObject<TextInput>;
}> = ({
  label, value, onChangeText, onBlur, onFocus, placeholder, icon, rightAccessory, hint, error,
  secureTextEntry, keyboardType = 'default', autoCapitalize = 'sentences', autoCorrect = true,
  multiline, maxLength, returnKeyType, blurOnSubmit, onSubmitEditing, size = 'md',
  readOnly, lockedReason, accessibilityLabel, style, inputRef,
}) => {
  const t = useTheme();
  const [focused, setFocused] = React.useState(false);
  const height = size === 'lg' ? 56 : 50;

  if (readOnly || lockedReason) {
    return (
      <View style={[{ gap: t.space.sm }, style]}>
        {label ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <AppText variant="overline" tone="faint">{label.toUpperCase()}</AppText>
            {lockedReason && <Icon name="lock-closed" size={11} color={t.colors.textFaint} />}
          </View>
        ) : null}
        <View style={{
          backgroundColor: t.colors.surfaceAlt, borderRadius: t.radius.md,
          paddingHorizontal: t.space.lg, paddingVertical: t.space.md,
        }}>
          <AppText variant="small" tone={value ? 'default' : 'faint'}>{value || placeholder || '—'}</AppText>
        </View>
        {lockedReason ? <AppText variant="caption" tone="faint">{lockedReason}</AppText> : null}
      </View>
    );
  }

  return (
    <View style={[{ gap: t.space.sm }, style]}>
      {label ? <AppText variant="overline" tone="faint">{label.toUpperCase()}</AppText> : null}
      <View
        style={{
          flexDirection: 'row', alignItems: multiline ? 'flex-start' : 'center', gap: t.space.md,
          backgroundColor: t.colors.surfaceAlt, borderRadius: t.radius.lg,
          /*
           * Resting state is a flat filled pill — no border at all. A field permanently
           * outlined in a visible stroke, sitting inside a card that's ALSO outlined, is the
           * single most "HTML form circa 2012" cue in the old version of this component. The
           * border now exists only to answer a question ("is this focused / did this fail") —
           * transparent otherwise, so it costs nothing when there's nothing to say.
           */
          borderWidth: 1.5,
          borderColor: error ? t.colors.danger : focused ? t.colors.primary : 'transparent',
          paddingHorizontal: t.space.lg,
          paddingVertical: multiline ? t.space.md : 0,
          minHeight: multiline ? 90 : height,
        }}
      >
        {icon && (
          <Icon
            name={icon}
            size={18}
            color={focused ? t.colors.primary : t.colors.textFaint}
            style={multiline ? { marginTop: 2 } : undefined}
          />
        )}
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => { setFocused(true); onFocus?.(); }}
          onBlur={() => { setFocused(false); onBlur?.(); }}
          placeholder={placeholder}
          placeholderTextColor={t.colors.textFaint}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          multiline={multiline}
          maxLength={maxLength}
          returnKeyType={returnKeyType}
          blurOnSubmit={blurOnSubmit}
          onSubmitEditing={onSubmitEditing}
          accessibilityLabel={accessibilityLabel ?? label}
          textAlignVertical={multiline ? 'top' : 'center'}
          style={{
            flex: 1, color: t.colors.text, fontSize: 15, fontWeight: '600',
            paddingVertical: multiline ? 10 : 0,
          }}
        />
        {rightAccessory}
      </View>
      {error ? (
        <AppText variant="caption" tone="danger">{error}</AppText>
      ) : hint ? (
        <AppText variant="caption" tone="faint">{hint}</AppText>
      ) : null}
    </View>
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

/**
 * A small fact as a neon-tinted pill — time, distance, customer count, a running total.
 *
 * Promoted from three near-identical local copies (HomeScreen's `Meta`, EarningsScreen's
 * `MoneyChip`, ScheduleScreen's `Fact`) into one component, so the same fact reads the same way
 * everywhere it appears instead of three screens each keeping eleven lines of styling in sync
 * by hand. EarningsScreen's own comment on `MoneyChip` said as much: "the chip pattern used
 * across the app."
 */
export const MetaChip: React.FC<{
  icon: IconName;
  label: string;
  /** A second value rendered after the label in the same pill (EarningsScreen's `MoneyChip`). */
  value?: string;
  iconColor?: string;
  /** 'pill' (default): tinted rounded chip. 'stacked': bare label-over-value with no fill or
   *  border — ScheduleScreen's `Fact`, used where several facts already sit inside a bordered row. */
  layout?: 'pill' | 'stacked';
  style?: StyleProp<ViewStyle>;
}> = ({ icon, label, value, iconColor, layout = 'pill', style }) => {
  const t = useTheme();

  if (layout === 'stacked') {
    return (
      <View style={[{ flex: 1, gap: 4 }, style]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name={icon} size={12} color={t.colors.textFaint} />
          <AppText variant="overline" tone="faint">{label.toUpperCase()}</AppText>
        </View>
        <AppText variant="bodyStrong" numberOfLines={1}>{value}</AppText>
      </View>
    );
  }

  return (
    <View style={[{
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: t.colors.surfaceAlt, borderWidth: 1, borderColor: t.colors.border,
      paddingHorizontal: 10, paddingVertical: 6, borderRadius: t.radius.pill,
    }, style]}>
      <Icon name={icon} size={13} color={iconColor ?? t.colors.accent} />
      <AppText variant="caption" tone="muted">{label}{value != null ? ' ' : ''}</AppText>
      {value != null && <AppText variant="caption">{value}</AppText>}
    </View>
  );
};

export interface ChipOption { key: string; label: string; icon?: IconName }

/**
 * A row of chips toggled on/off — distinct from `Segmented`, which always shows SOME option as
 * chosen (it clamps a missing value to index 0). Several forms need the opposite: a category that
 * is genuinely unset until the person picks one (self-registration's employment category, a
 * decline/report reason), which is why chip-selection kept getting reinvented locally — in
 * `SelfRegistrationScreen`, `RejectionModal`, `ReportIssueModal`, `FeedbackModal`, `ExpenseModal` —
 * instead of reusing `Segmented`. Pass an array to `value` for multi-select; nothing here forces
 * single-select on its own.
 */
export const ChipSelector: React.FC<{
  options: ChipOption[];
  /** A single selected key (or null/undefined for none), or an array for multi-select. */
  value: string | string[] | null | undefined;
  onChange: (key: string) => void;
  /** Square corners instead of pill — `ExpenseModal`'s category picker was the one outlier using
   *  this; default is pill to match every other chip in the app. */
  shape?: 'pill' | 'square';
  style?: StyleProp<ViewStyle>;
}> = ({ options, value, onChange, shape = 'pill', style }) => {
  const t = useTheme();
  const selected = Array.isArray(value) ? value : value != null ? [value] : [];

  return (
    <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }, style]}>
      {options.map((o) => {
        const active = selected.includes(o.key);
        return (
          <Tappable
            key={o.key || 'EMPTY'}
            onPress={() => { haptics.select(); onChange(o.key); }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={o.label}
          >
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingVertical: t.space.sm, paddingHorizontal: t.space.md,
              borderRadius: shape === 'pill' ? t.radius.pill : t.radius.md,
              backgroundColor: active ? t.colors.primarySoft : t.colors.surfaceAlt,
              borderWidth: 1.5, borderColor: active ? t.colors.primary : t.colors.border,
            }}>
              {o.icon && <Icon name={o.icon} size={14} color={active ? t.colors.primary : t.colors.textFaint} />}
              <AppText variant="small" tone={active ? 'primary' : 'muted'}>{o.label}</AppText>
            </View>
          </Tappable>
        );
      })}
    </View>
  );
};

/** A removable pill — a picked tag, or a legacy value kept around for compatibility. Used inside
 *  `ProfileScreen`'s attribute/region pickers, where the same "chip with an ✕" was drawn twice. */
export const Tag: React.FC<{
  label: string;
  tone?: 'neutral' | 'primary';
  onRemove?: () => void;
  removeAccessibilityLabel?: string;
}> = ({ label, tone = 'neutral', onRemove, removeAccessibilityLabel }) => {
  const t = useTheme();
  const c = tone === 'primary'
    ? { bg: t.colors.primarySoft, border: t.colors.primary, fg: 'primary' as const }
    : { bg: t.colors.surface, border: t.colors.border, fg: 'muted' as const };
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingVertical: 4, paddingHorizontal: 8, borderRadius: t.radius.pill,
      backgroundColor: c.bg, borderWidth: 1, borderColor: c.border,
    }}>
      <AppText variant="caption" tone={c.fg}>{label}</AppText>
      {onRemove && (
        <Tappable onPress={onRemove} accessibilityRole="button" accessibilityLabel={removeAccessibilityLabel}>
          <Icon name="close-circle" size={14} color={tone === 'primary' ? t.colors.primary : t.colors.textFaint} />
        </Tappable>
      )}
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
        {/* Two lines, because Devanagari sets wider than Latin at the same size and a one-line
            clamp turned "Expenses claimed" into an ellipsis the moment it was translated. The
            strip stretches its tiles to the tallest, so a wrapped label costs no alignment. */}
        <AppText variant="overline" tone="faint" numberOfLines={2}>{label.toUpperCase()}</AppText>
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
        // A hairline, not the full-strength `border` token — real Settings.app separates a
        // grouped section from the page behind it with a tone step, not a drawn outline.
        borderColor: t.mode === 'dark' ? 'rgba(255,255,255,0.045)' : 'rgba(20,18,40,0.06)',
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

// ─────────────────────────────────────────────────────────── Modal shell
//
// The scrim + container + header structure nine-odd modals rebuilt by hand — each with tiny
// drift (some at `space.xl` padding, some at `md`; a close IconButton here, a plain Tappable
// "Done" there). This owns only the shell; every modal keeps its own body and footer content.

/**
 * `visible`/`onClose`/`title` plus a shell shape:
 * - 'dialog' (default): a centred `Card`, for a short focused form — Expense, Rejection,
 *   Invoice review. Matches what those three already built by hand: scrim, centered, padded.
 * - 'sheet': a full-height panel sliding up from the bottom, for a longer or multi-view flow —
 *   Feedback, Notifications, Report Issue. Matches FeedbackModal's own shell exactly.
 */
export const ModalSheet: React.FC<{
  visible: boolean;
  onClose: () => void;
  title?: string;
  variant?: 'dialog' | 'sheet';
  /** Replaces the header's default empty leading slot — e.g. a back button mid-flow, or a
   *  decorative icon when there's nothing to go back to (see FeedbackModal's list/compose/thread). */
  leading?: React.ReactNode;
  /** Shows the trailing close button. Defaults to `true` for 'sheet' (every sheet in the app has
   *  one) and `false` for 'dialog' (Expense/Rejection rely on their own Cancel button instead, so
   *  a default close X would be a new control appearing where there wasn't one). */
  showClose?: boolean;
  /** Pre-translated accessibility label for the close button. */
  closeLabel?: string;
  avoidKeyboard?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({
  visible, onClose, title, variant = 'dialog', leading, showClose, closeLabel = 'Close', avoidKeyboard, footer, children,
}) => {
  const t = useTheme();
  const close = showClose ?? variant === 'sheet';

  if (!visible) return null;

  const header = (title || leading || close) ? (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
      paddingHorizontal: variant === 'sheet' ? t.space.xl : 0,
      paddingBottom: variant === 'sheet' ? t.space.md : t.space.sm,
    }}>
      {leading}
      {title ? <AppText variant="h2" style={{ flex: 1 }}>{title}</AppText> : <View style={{ flex: 1 }} />}
      {close && (
        <IconButton icon="close" onPress={onClose} accessibilityLabel={closeLabel} size={variant === 'sheet' ? 36 : 34} />
      )}
    </View>
  ) : null;

  const content = variant === 'sheet' ? (
    <View style={{
      backgroundColor: t.colors.bg,
      borderTopLeftRadius: t.radius.xl, borderTopRightRadius: t.radius.xl,
      height: '88%', paddingTop: t.space.md,
    }}>
      <View style={{ alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: t.colors.border, marginBottom: t.space.sm }} />
      {header}
      <View style={{ flex: 1 }}>{children}</View>
      {footer}
    </View>
  ) : (
    <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl }}>
      {header}
      {children}
      {footer}
    </Card>
  );

  const scrimStyle: StyleProp<ViewStyle> = variant === 'sheet'
    ? { flex: 1, backgroundColor: t.colors.scrim, justifyContent: 'flex-end' }
    : { flex: 1, backgroundColor: t.colors.scrim, justifyContent: 'center', padding: t.space.xl };

  const body = <View style={scrimStyle}>{content}</View>;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {avoidKeyboard ? (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          {body}
        </KeyboardAvoidingView>
      ) : body}
    </Modal>
  );
};
