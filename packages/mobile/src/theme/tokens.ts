import { Platform } from 'react-native';

/**
 * Orbit — design tokens.
 *
 * One source of truth for the whole app: two full palettes (dual tone) and the
 * scales everything else keys off — spacing, radius, type, elevation, motion.
 * Every screen reads from here, so the look is changed in one place, not screen
 * by screen.
 *
 * ## Identity — "Orbit Navy"
 *
 * Dark-first, but deliberately closer to a trusted ops/audit tool than to a
 * consumer neon app: the ground is a deep navy-charcoal rather than a
 * blue-violet near-black, and the brand signal is an electric blue rather than
 * violet — a field assayer's employer, not a game. The accent is an electric
 * teal, one clear step off the primary so a balance figure and a primary
 * button never compete. Status hues (success/warning/danger/info) are held
 * clearly apart from both so a warning never reads as just another button.
 *
 * Replaces the original "Midnight Neon" (violet/cyan) identity — same
 * structure (three surface tiers, dual palette, WCAG-checked text tones; see
 * `contrast.spec.ts`), different hue family, chosen for a more professional,
 * less gaming/crypto-app read.
 *
 * The light palette is a clean companion, not an afterthought: the same blue
 * and teal carried further down the ramp so they stay legible on white.
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
  /** Ink on a solid `danger` fill — the count in a red badge. Same rule as onPrimary. */
  onDanger: string;
  info: string;
  infoSoft: string;

  /** Scrim behind modals and sheets. */
  scrim: string;
}

const dark: Palette = {
  /* Deep navy-charcoal — cooler and darker than the old violet-tinted near-black, read as an
     ops/audit tool rather than a game. Three clearly separated surface tiers above it so depth
     comes from the tier gap plus elevation, not from an outline around every box (see `Card`,
     `GroupedSection` in primitives.tsx — both moved from a full-strength border to a hairline
     for the same reason: a box drawn in a visible outline, nested inside more outlined boxes, is
     what reads as dated forms UI, not the tone of the box itself). */
  bg: '#0A101C',
  surface: '#121A2C',
  surfaceAlt: '#1B2540',
  surfacePress: 'rgba(255,255,255,0.06)',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.16)',

  text: '#EDF1F8',
  textMuted: '#93A1B8',
  /**
   * Measured against the three grounds this app paints on — bg `#0A101C`, surface `#121A2C`,
   * surfaceAlt `#1B2540` — this scores 5.86, 5.35 and 4.67 against the 4.5 AA floor (verified by
   * `contrast.spec.ts`, which computes this at test time rather than trusting a comment).
   * `overline` + `tone="faint"` is the FIELD LABEL style, used at 38+ sites including every label
   * on the profile form, so this tone carries real legibility weight, not just decoration.
   *
   * Kept a clear step below `textMuted` (1.24:1) so the three-tier scale still reads as three
   * tiers rather than two tones and a rounding error.
   */
  textFaint: '#8090A8',

  /* Electric blue — the brand signal. Blue's luminance weight in the WCAG formula is low
     regardless of how vivid it looks, so (as with the old violet) dark ink reads better on it
     than white does — verified: ink clears ~5:1, white only ~3.8:1. Reserved for the single
     primary action on a screen; everything else is neutrals or status. */
  primary: '#2F7DFF',
  primarySoft: 'rgba(47,125,255,0.16)',
  onPrimary: '#0A101C',

  /* Electric teal — money, highlights, the second signal. One clear step off the primary so a
     balance figure and a primary button never compete. */
  accent: '#2DD4BF',
  accentSoft: 'rgba(45,212,191,0.14)',
  onAccent: '#05141A',

  /* Status hues kept vivid but clearly apart from primary/accent, so a screen of badges reads as
     information rather than a set of competing alerts. Success shifted to a purer green (was
     closer to teal, which now doubles as the accent). */
  success: '#22C55E',
  successSoft: 'rgba(34,197,94,0.13)',
  /* Amber warning, distinct from the blue primary — a warning the same colour as every button
     stops functioning as a warning. */
  warning: '#FBBF24',
  warningSoft: 'rgba(251,191,36,0.13)',
  danger: '#FB7185',
  dangerSoft: 'rgba(251,113,133,0.13)',
  /* Dark ink, not white: white on this rose fails AA for the one thing a badge exists to show —
     a number. The near-black ink clears ~7:1. */
  onDanger: '#0A101C',
  /* Indigo, not blue — with primary now occupying blue, info needs its own hue to stay a
     distinguishable "third colour" rather than reading as a duller primary. */
  info: '#818CF8',
  infoSoft: 'rgba(129,140,248,0.13)',

  scrim: 'rgba(4,7,14,0.82)',
};

const light: Palette = {
  /* Cool off-white with a faint navy undertone, keeping the light theme in the same family as
     the dark ground rather than a plain grey. */
  bg: '#F3F6FB',
  surface: '#FFFFFF',
  surfaceAlt: '#F7F9FC',
  surfacePress: 'rgba(15,27,45,0.05)',
  border: 'rgba(15,27,45,0.10)',
  borderStrong: 'rgba(15,27,45,0.20)',

  text: '#10192B',
  textMuted: '#54637A',
  /**
   * Measured against bg `#F3F6FB` / surface `#FFFFFF` / surfaceAlt `#F7F9FC`: 4.65, 5.04, 4.78
   * against the 4.5 AA floor (checked by `contrast.spec.ts`), and a 1.21:1 step below
   * `textMuted` so the three-tier scale stays three tiers.
   */
  textFaint: '#5F7089',

  /* Deepened electric blue. The vivid #2F7DFF used on dark is only borderline on white — light
     mode carries the same hue further down the ramp to clear ~6.7:1 with white text. */
  primary: '#1D4ED8',
  primarySoft: 'rgba(29,78,216,0.10)',
  onPrimary: '#FFFFFF',

  /* Teal deepened for white text at ~6:1 — the vivid dark-mode teal is a highlight on navy, a
     legible accent here. */
  accent: '#0B6E66',
  accentSoft: 'rgba(11,110,102,0.10)',
  onAccent: '#FFFFFF',

  success: '#16A34A',
  successSoft: 'rgba(22,163,74,0.10)',
  /* Deep amber warning, distinct from the blue primary. */
  warning: '#A16207',
  warningSoft: 'rgba(161,98,7,0.12)',
  danger: '#E11D48',
  dangerSoft: 'rgba(225,29,72,0.10)',
  /* The crimson is deep enough for white (~4.7:1). */
  onDanger: '#FFFFFF',
  /* Indigo, not blue — primary already owns blue here. */
  info: '#4F46E5',
  infoSoft: 'rgba(79,70,229,0.10)',

  scrim: 'rgba(10,16,28,0.45)',
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
  /**
   * Section headers and metadata — the only place we shout.
   *
   * 12, not 11, and it is the same 12 as `caption` on purpose: this is the scale's floor, and
   * `overline` had been sitting below it. That mattered more than the number suggests, because
   * this is not only decoration — it is the field-label style, used at 38 sites including every
   * label on the profile form and all three on the change-password screen. Uppercase, letter-
   * spaced, `tone="faint"` and below the floor is the least legible combination the app can
   * produce, aimed at the labels a low-literacy field worker most needs to read correctly.
   * Weight and tracking still separate it from `caption`; size no longer does.
   */
  overline: { fontSize: 12, lineHeight: 16, fontWeight: '800' as const, letterSpacing: 0.7 },
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
