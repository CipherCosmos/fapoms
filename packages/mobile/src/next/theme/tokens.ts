/**
 * The rebuilt field app's look, in one place.
 *
 * Light and high-contrast only. The app is read outdoors, in bank strongrooms and on cheap screens,
 * by people for whom reading is not always easy — so there is one ground, one surface, one ink, and
 * ONE accent that means "this is the thing to press". Colour is never the only signal: every state
 * that has a colour also has a word and an icon.
 *
 * Pure data (no React Native import), so `tokens.spec.ts` can check the contrast arithmetic and the
 * minimum type size in node.
 */

export const colors = {
  /** Page background, furthest back. */
  ground: '#F5F6F8',
  /** Cards, sheets, fields. */
  surface: '#FFFFFF',
  /** Main text. */
  ink: '#16202E',
  /** Secondary text: hints, captions, "why not" reasons. Still AA on ground and surface. */
  inkSecondary: '#4A5566',
  /** Hairlines and field borders. */
  line: '#E2E5EA',
  /** A stronger border, for a focused field or a selected option. */
  lineStrong: '#8A94A3',

  /** The ONE main action on a screen. White text. */
  accent: '#8C5A00',
  onAccent: '#FFFFFF',
  accentSoft: '#F6EEDF',
  /** Pressed state of the main action. */
  accentPressed: '#6F4700',

  /** Done. */
  success: '#1B7543',
  successSoft: '#E5F2EA',
  /** Information. */
  info: '#2350B0',
  infoSoft: '#E8EEFA',
  /** A problem. */
  danger: '#B42318',
  dangerSoft: '#FBEAE8',

  /** A button that cannot be pressed: still readable, clearly not live. */
  disabledFill: '#E9ECF0',
  disabledInk: '#4A5566',

  /** Behind a sheet. */
  scrim: 'rgba(22, 32, 46, 0.45)',
  /** Pressed fill for quiet buttons and rows. */
  pressed: '#EDEFF3',
} as const;

export type ColorToken = keyof typeof colors;

/** Spacing on a 4-point grid. */
export const space = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  /** Sheets: rounded top corners only. */
  sheet: 24,
  pill: 999,
} as const;

/**
 * Sizes that make a thing pressable by a thumb in a hurry.
 * 48 is the platform floor for any target; buttons are bigger on purpose.
 */
export const touch = {
  minTarget: 48,
  button: 56,
  buttonLarge: 60,
  row: 64,
  field: 56,
} as const;

/**
 * Smooth but calm: short, decelerating, never bouncy. `useReducedMotion()` turns all of it off.
 */
export const motion = {
  fast: 150,
  base: 220,
  slow: 320,
  /** Material's "standard" curve: quick start, gentle settle. */
  easing: [0.2, 0, 0, 1] as const,
  /** Spring for sheets: critically damped — it arrives, it does not wobble. */
  sheetSpring: { damping: 30, stiffness: 300, mass: 1, overshootClamping: true },
  /** How long a toast stays up. Long enough to read twice. */
  toastMs: 3500,
} as const;
