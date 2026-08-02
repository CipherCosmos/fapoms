import { Platform } from 'react-native';

/**
 * FAPOMS Field — design tokens.
 *
 * The old app was a single 630-line StyleSheet of hardcoded near-black and
 * indigo, with no light mode and no shared scale — every screen re-invented its
 * own padding, radius and type size inline. This replaces that with one source
 * of truth: two full palettes (dual tone), and scales everything else keys off.
 *
 * The identity is deliberately a *pair*: a cool teal primary carries structure
 * and navigation, a warm amber accent carries money and attention. Nothing in
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
  bg: '#0A101C',
  surface: '#121C2C',
  surfaceAlt: '#1A2740',
  surfacePress: 'rgba(148,163,184,0.10)',
  border: 'rgba(148,163,184,0.13)',
  borderStrong: 'rgba(148,163,184,0.26)',

  text: '#F1F5F9',
  textMuted: '#94A3B8',
  textFaint: '#64748B',

  primary: '#2DD4BF',
  primarySoft: 'rgba(45,212,191,0.14)',
  onPrimary: '#03302C',

  accent: '#FBA94C',
  accentSoft: 'rgba(251,169,76,0.15)',
  onAccent: '#3A2206',

  success: '#34D399',
  successSoft: 'rgba(52,211,153,0.14)',
  warning: '#FBBF24',
  warningSoft: 'rgba(251,191,36,0.14)',
  danger: '#FB7185',
  dangerSoft: 'rgba(251,113,133,0.14)',
  info: '#60A5FA',
  infoSoft: 'rgba(96,165,250,0.14)',

  scrim: 'rgba(3,7,18,0.72)',
};

const light: Palette = {
  bg: '#F5F7FA',
  surface: '#FFFFFF',
  surfaceAlt: '#FFFFFF',
  surfacePress: 'rgba(15,23,42,0.05)',
  border: 'rgba(15,23,42,0.09)',
  borderStrong: 'rgba(15,23,42,0.18)',

  text: '#0F172A',
  textMuted: '#64748B',
  textFaint: '#94A3B8',

  primary: '#0D9488',
  primarySoft: 'rgba(13,148,136,0.11)',
  onPrimary: '#FFFFFF',

  accent: '#D97706',
  accentSoft: 'rgba(217,119,6,0.11)',
  onAccent: '#FFFFFF',

  success: '#059669',
  successSoft: 'rgba(5,150,105,0.11)',
  warning: '#D97706',
  warningSoft: 'rgba(217,119,6,0.11)',
  danger: '#E11D48',
  dangerSoft: 'rgba(225,29,72,0.10)',
  info: '#2563EB',
  infoSoft: 'rgba(37,99,235,0.10)',

  scrim: 'rgba(15,23,42,0.45)',
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
