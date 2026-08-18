import { Platform } from 'react-native';

/**
 * Orbit — design tokens.
 *
 * One source of truth for the whole app: two full palettes (dual tone) and the
 * scales everything else keys off — spacing, radius, type, elevation, motion.
 * Every screen reads from here, so the look is changed in one place, not screen
 * by screen.
 *
 * ## Identity — "Midnight Neon"
 *
 * Dark-first and premium. The ground is a near-black with a faint blue-violet
 * undertone, layered into three surface tiers so depth comes from the tier gap
 * rather than heavy shadow. The primary is an electric violet (#8B7CFF) and the
 * accent an electric cyan (#22D3EE) — the two neon signals that carry the brand.
 * Status hues (success/warning/danger/info) are held clearly apart from the
 * violet so a warning never reads as just another button.
 *
 * The light palette is a clean companion, not an afterthought: the same violet
 * and cyan carried further down the ramp so they stay legible on white.
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
  /* Near-black with a faint blue-violet undertone, and three clearly separated
     surface tiers above it so the neon violet reads as part of the family rather
     than an accent bolted onto a cold ground. Depth comes from the tier gap
     between bg/surface/surfaceAlt plus elevation, so borders stay a hairline seam
     rather than an outline around every box. */
  bg: '#0E1016',
  surface: '#191C24',
  surfaceAlt: '#232733',
  surfacePress: 'rgba(255,255,255,0.06)',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.16)',

  text: '#F0F2F7',
  textMuted: '#9CA3B4',
  textFaint: '#6B7080',

  /* Electric violet — the brand signal. Bright enough that near-black text sits on
     it (see onPrimary), which is the modern neon-button look. Reserved for the
     single primary action on a screen; everything else is neutrals or status. */
  primary: '#8B7CFF',
  primarySoft: 'rgba(139,124,255,0.16)',
  onPrimary: '#0E1016',

  /* Electric cyan — money, highlights, the second neon. One clear step off the
     violet so a balance figure and a primary button never compete. */
  accent: '#22D3EE',
  accentSoft: 'rgba(34,211,238,0.14)',
  onAccent: '#05141A',

  /* Status hues kept vivid but clearly apart from the violet, so a screen of
     badges reads as information rather than a set of competing alerts. */
  success: '#34D399',
  successSoft: 'rgba(52,211,153,0.13)',
  /* Amber warning, distinct from the violet primary — a warning the same colour as
     every button stops functioning as a warning. */
  warning: '#FBBF24',
  warningSoft: 'rgba(251,191,36,0.13)',
  danger: '#FB7185',
  dangerSoft: 'rgba(251,113,133,0.13)',
  info: '#60A5FA',
  infoSoft: 'rgba(96,165,250,0.13)',

  scrim: 'rgba(6,7,12,0.82)',
};

const light: Palette = {
  /* Cool off-white with a faint violet undertone, keeping the light theme in the
     same family as the neon mark rather than a plain grey. */
  bg: '#F5F5FB',
  surface: '#FFFFFF',
  surfaceAlt: '#FBFBFE',
  surfacePress: 'rgba(20,18,40,0.05)',
  border: 'rgba(20,18,40,0.10)',
  borderStrong: 'rgba(20,18,40,0.20)',

  text: '#16151F',
  textMuted: '#5B5A6B',
  textFaint: '#8A8898',

  /* Deepened violet. The neon #8B7CFF is only ~2.5:1 on white — fine as a glow on
     dark, unreadable as a label or a link on light — so light mode carries the same
     hue further down the ramp to clear ~5:1 with white text on the button. */
  primary: '#5B4BD6',
  primarySoft: 'rgba(91,75,214,0.10)',
  onPrimary: '#FFFFFF',

  /* Cyan pulled to teal so it reads on white; the neon cyan is a highlight on dark,
     a legible accent here. */
  accent: '#0891B2',
  accentSoft: 'rgba(8,145,178,0.10)',
  onAccent: '#FFFFFF',

  success: '#16A34A',
  successSoft: 'rgba(22,163,74,0.10)',
  /* Deep amber warning, distinct from the violet primary. */
  warning: '#A16207',
  warningSoft: 'rgba(161,98,7,0.12)',
  danger: '#E11D48',
  dangerSoft: 'rgba(225,29,72,0.10)',
  info: '#2563EB',
  infoSoft: 'rgba(37,99,235,0.10)',

  scrim: 'rgba(20,18,40,0.45)',
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
  /** Apple grouped-list container corner (Settings.app uses ~14pt at the standard scale). A
      dedicated name rather than reusing `lg`/`xl` because this one shape — the rounded card that
      holds a whole group of rows — needs to change independently of card/button rounding
      elsewhere if the two ever diverge. */
  groupedInset: 14,
} as const;

/**
 * Type scale. Sizes are noticeably larger than the old app's 9–13px, which was
 * below the readable floor for a phone used outdoors in the field.
 */
export const type = {
  /** Apple large-title: the hero line on a screen (greeting, balance). Tight negative
      tracking is what makes big type read as crafted rather than merely big. */
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '800' as const, letterSpacing: -0.7 },
  display: { fontSize: 30, lineHeight: 36, fontWeight: '800' as const, letterSpacing: -0.5 },
  h1: { fontSize: 24, lineHeight: 30, fontWeight: '800' as const, letterSpacing: -0.4 },
  h2: { fontSize: 19, lineHeight: 25, fontWeight: '700' as const, letterSpacing: -0.3 },
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
  // Apple dark UI builds depth from the bg/surface/surfaceAlt tier gap, not heavy shadow, so the
  // dark opacities are softer than before — cards read as lifted, not outlined in black.
  const iosOpacity = mode === 'dark' ? [0, 0.18, 0.24, 0.32][level] : [0, 0.06, 0.09, 0.13][level];
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
