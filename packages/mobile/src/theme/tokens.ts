import { Platform } from 'react-native';

/**
 * FAPOMS Field — design tokens.
 *
 * The old app was a single 630-line StyleSheet of hardcoded near-black and
 * indigo, with no light mode and no shared scale — every screen re-invented its
 * own padding, radius and type size inline. This replaces that with one source
 * of truth: two full palettes (dual tone), and scales everything else keys off.
 *
 * The identity is the Sumeru flame: the primary is the logo's own orange, and the
 * accent its amber, so the app and the mark are one family. Nothing in
 * here resembles the previous indigo-on-black.
 */

export type Mode = 'light' | 'dark';

export interface Palette {
  /** Page background, furthest back. */
  bg: string;
  /** Cards and sheets sitting on the page. */
  surface: string;
  /** A surface that needs to read as lifted off another surface. */
  surfaceAlt: string;
  /** Pressed/hovered fill for interactive rows. */
  surfacePress: string;
  border: string;
  borderStrong: string;

  text: string;
  textMuted: string;
  textFaint: string;

  /** Structure, navigation, primary actions. */
  primary: string;
  primarySoft: string;
  onPrimary: string;

  /** Money, highlights, the "second tone". */
  accent: string;
  accentSoft: string;
  onAccent: string;

  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;

  /** Scrim behind modals and sheets. */
  scrim: string;
}

const dark: Palette = {
  /* Near-black with only a trace of warmth, and three clearly separated surface
     tiers above it.

     The previous ground (#14100C) was heavily brown, which forced every card to
     carry a visible border to separate from it — the "boxes drawn on boxes" look
     that dated the app. Depth now comes from the tier gap between bg/surface/
     surfaceAlt plus elevation, so borders can drop to a hairline hint. Enough
     warmth remains that the flame orange still reads as part of the family
     rather than an accent bolted on. */
  bg: '#121014',
  surface: '#1C191E',
  surfaceAlt: '#252128',
  surfacePress: 'rgba(255,255,255,0.06)',
  /* Halved from 0.12. At this weight a border is a seam, not an outline —
     it separates adjacent surfaces without drawing a box around every element. */
  border: 'rgba(255,255,255,0.06)',
  borderStrong: 'rgba(255,255,255,0.14)',

  text: '#F4F2F6',
  textMuted: '#A8A2AE',
  textFaint: '#7B7583',

  /* The logo's own orange, unmodified — 7.6:1 on this ground. Reserved for the
     single primary action on a screen; everything else uses neutrals or status. */
  primary: '#FF8534',
  /* Softs dropped from 0.15 to 0.10. At 0.15 a "subtle" tint competed with the
     solid primary button for attention, so nothing read as the main action. */
  primarySoft: 'rgba(255,133,52,0.10)',
  onPrimary: '#1C1207',

  accent: '#FFA53D',
  accentSoft: 'rgba(255,165,61,0.10)',
  onAccent: '#1C1207',

  /* Status hues desaturated toward the ground so a screen of badges reads as
     information rather than a set of competing alerts. */
  success: '#63B383',
  successSoft: 'rgba(99,179,131,0.10)',
  /* Held at gold, distinct from the orange primary — a warning the same colour as
     every button stops functioning as a warning. */
  warning: '#D9AE3F',
  warningSoft: 'rgba(217,174,63,0.10)',
  danger: '#DC6459',
  dangerSoft: 'rgba(220,100,89,0.10)',
  info: '#7AA9DB',
  infoSoft: 'rgba(122,169,219,0.10)',

  scrim: 'rgba(8,6,10,0.78)',
};

const light: Palette = {
  /* Warm off-white, matching the web app's --flame-cream. */
  bg: '#FFFAF5',
  surface: '#FFFFFF',
  surfaceAlt: '#FFFFFF',
  surfacePress: 'rgba(28,18,7,0.05)',
  border: 'rgba(28,18,7,0.10)',
  borderStrong: 'rgba(28,18,7,0.20)',

  text: '#1C1207',
  textMuted: '#6B5648',
  textFaint: '#7A6657',

  /* Deepened flame. The logo's #FF6B00 is only 2.9:1 on white — fine for the mark,
     unreadable as a label or a link, so light mode carries the same hue further
     down the ramp to reach 5.0:1. */
  primary: '#C2410C',
  primarySoft: 'rgba(194,65,12,0.10)',
  onPrimary: '#FFFFFF',

  accent: '#B45309',
  accentSoft: 'rgba(180,83,9,0.10)',
  onAccent: '#FFFFFF',

  success: '#2F7D4F',
  successSoft: 'rgba(47,125,79,0.10)',
  warning: '#8A5A00',
  warningSoft: 'rgba(138,90,0,0.12)',
  danger: '#B3261E',
  dangerSoft: 'rgba(179,38,30,0.10)',
  info: '#1D4ED8',
  infoSoft: 'rgba(29,78,216,0.10)',

  scrim: 'rgba(28,18,7,0.45)',
};

export const palettes: Record<Mode, Palette> = { light, dark };

/** 4pt base grid — every gap and pad in the app is one of these. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 28,
  pill: 999,
} as const;

/**
 * Type scale. Sizes are noticeably larger than the old app's 9–13px, which was
 * below the readable floor for a phone used outdoors in the field.
 */
export const type = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: '800' as const, letterSpacing: -0.5 },
  h1: { fontSize: 24, lineHeight: 30, fontWeight: '800' as const, letterSpacing: -0.3 },
  h2: { fontSize: 19, lineHeight: 25, fontWeight: '700' as const, letterSpacing: -0.2 },
  h3: { fontSize: 16, lineHeight: 22, fontWeight: '700' as const },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '500' as const },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '700' as const },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '600' as const },
  /** Section headers and metadata — the only place we shout. */
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '800' as const, letterSpacing: 0.7 },
  mono: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600' as const,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
} as const;

/**
 * Elevation. iOS gets a real soft shadow; Android gets `elevation` because
 * shadow* props do nothing there. The old app set both blindly, so cards looked
 * flat on Android and over-shadowed on iOS.
 */
export function elevation(mode: Mode, level: 0 | 1 | 2 | 3) {
  if (level === 0) return {};
  const iosOpacity = mode === 'dark' ? [0, 0.28, 0.36, 0.45][level] : [0, 0.06, 0.09, 0.13][level];
  return Platform.select({
    ios: {
      shadowColor: mode === 'dark' ? '#000' : '#0F172A',
      shadowOffset: { width: 0, height: [0, 2, 6, 12][level] },
      shadowOpacity: iosOpacity,
      shadowRadius: [0, 6, 14, 24][level],
    },
    android: { elevation: [0, 2, 5, 10][level] },
    default: {
      boxShadow: `0 ${[0, 2, 6, 12][level]}px ${[0, 8, 18, 30][level]}px rgba(2,6,23,${iosOpacity})`,
    } as any,
  });
}

/** One place for animation feel, so nothing in the app animates at a different speed. */
export const motion = {
  fast: 140,
  base: 220,
  slow: 320,
  /** Native driver can only animate transform/opacity — everything here obeys that. */
  spring: { tension: 300, friction: 22, useNativeDriver: true },
  pressScale: 0.97,
} as const;
