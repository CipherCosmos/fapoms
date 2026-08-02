import { useState, useCallback, useEffect } from 'react';

export type ThemeGroup = 'light' | 'dark' | 'glass';

export interface ThemeMeta {
  id: string;
  label: string;
  group: ThemeGroup;
  description: string;
  /** Preview swatches rendered in the theme picker (fg, bg, accent). */
  swatch: [string, string, string];
}

export const THEMES: ThemeMeta[] = [
  // Light
  { id: 'gold', label: 'Sumeru Gold', group: 'light', description: 'Warm cream & gold — the signature look.', swatch: ['#211A14', '#FAF6EE', '#97681A'] },
  { id: 'paper', label: 'Pure Paper', group: 'light', description: 'Cool neutral white — clean & minimal.', swatch: ['#1B2430', '#F6F7F9', '#8A6416'] },
  { id: 'sepia', label: 'Desert Ink', group: 'light', description: 'High-contrast warm — easy on the eyes.', swatch: ['#1F160B', '#FBF6ED', '#7A4E0A'] },
  { id: 'snow', label: 'Snow', group: 'light', description: 'Pure white & black — bold monochrome.', swatch: ['#111113', '#FFFFFF', '#111113'] },
  // Dark
  { id: 'noir', label: 'Sumeru Noir', group: 'dark', description: 'Warm charcoal & gold — the signature dark.', swatch: ['#F3EEE4', '#161210', '#D8AE47'] },
  { id: 'black-gold', label: 'Black Gold', group: 'dark', description: 'True black & gold — premium contrast.', swatch: ['#F5F3EE', '#050505', '#D8AE47'] },
  { id: 'black-white', label: 'Black & White', group: 'dark', description: 'Pure monochrome — maximum clarity.', swatch: ['#FFFFFF', '#000000', '#FFFFFF'] },
  { id: 'slate', label: 'Cool Slate', group: 'dark', description: 'Neutral graphite — modern & restrained.', swatch: ['#EDEFF3', '#14161A', '#D9B25A'] },
  { id: 'midnight', label: 'Midnight', group: 'dark', description: 'Deep, high-contrast — maximum focus.', swatch: ['#F5F6FA', '#0C0D11', '#E0B75F'] },
  // Glass
  { id: 'glass-light', label: 'Glass Light', group: 'glass', description: 'Frosted translucent panels over aurora.', swatch: ['#2A2A35', '#EFE9DD', '#7A5A14'] },
  { id: 'glass-dark', label: 'Glass Noir', group: 'glass', description: 'Dark frosted glass with soft color glows.', swatch: ['#F2EFF7', '#14121A', '#D9B25A'] },
];

export const CUSTOM_THEME_ID = 'custom';
export const DEFAULT_THEME = 'gold';

/** Bases a custom theme can be built upon (one per light/dark/glass). */
export const CUSTOM_BASES: ThemeMeta[] = [
  { id: 'gold', label: 'Light base', group: 'light', description: 'Warm light surfaces', swatch: ['#211A14', '#FAF6EE', '#97681A'] },
  { id: 'noir', label: 'Dark base', group: 'dark', description: 'Warm dark surfaces', swatch: ['#F3EEE4', '#161210', '#D8AE47'] },
  { id: 'glass-light', label: 'Glass light', group: 'glass', description: 'Translucent light panels', swatch: ['#2A2A35', '#EFE9DD', '#7A5A14'] },
  { id: 'glass-dark', label: 'Glass dark', group: 'glass', description: 'Translucent dark panels', swatch: ['#F2EFF7', '#14121A', '#D9B25A'] },
];

/** Preset accent colors users can pick from (plus free-form hex input). */
export const ACCENTS: { id: string; label: string; hex: string }[] = [
  { id: 'gold', label: 'Gold', hex: '#D8AE47' },
  { id: 'blue', label: 'Blue', hex: '#3B82F6' },
  { id: 'green', label: 'Green', hex: '#22A06B' },
  { id: 'teal', label: 'Teal', hex: '#14B8A6' },
  { id: 'purple', label: 'Purple', hex: '#8B5CF6' },
  { id: 'red', label: 'Red', hex: '#EF4444' },
  { id: 'orange', label: 'Orange', hex: '#F97316' },
  { id: 'pink', label: 'Pink', hex: '#EC4899' },
  { id: 'white', label: 'White', hex: '#FFFFFF' },
  { id: 'slate', label: 'Slate', hex: '#CBD5E1' },
];

export interface CustomThemeConfig {
  base: string;
  accent: string;
}

const STORAGE_KEY = 'fapoms_theme';
const CUSTOM_KEY = 'fapoms_custom';

const KNOWN_IDS = new Set([
  ...THEMES.map((t) => t.id),
  CUSTOM_THEME_ID,
]);

/* --------------------------- color helpers --------------------------- */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return [h[0], h[1], h[2]].map((c) => parseInt(c + c, 16)) as [number, number, number];
  }
  return [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((c) => parseInt(c, 16)) as [number, number, number];
}

function rgbToHex(rgb: [number, number, number]): string {
  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function relLum(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const L1 = relLum(hexToRgb(fg));
  const L2 = relLum(hexToRgb(bg));
  const lo = Math.min(L1, L2);
  const hi = Math.max(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pick the more readable ink (near-black vs white) for a given fill, using the
 * actual contrast crossover rather than a fixed luminance threshold.
 */
export function readableOnAccent(accentHex: string): string {
  const white = contrast('#FFFFFF', accentHex);
  const dark = contrast('#111113', accentHex);
  return white >= dark ? '#FFFFFF' : '#111113';
}

/**
 * Return a color derived from `hex` that reaches `min` contrast against `bg`.
 * On light backgrounds it darkens toward black; on dark backgrounds it
 * lightens toward white. Falls back gracefully if unreachable.
 */
function ensureContrast(hex: string, bg: string, min: number): string {
  const bgLum = relLum(hexToRgb(bg));
  const lighten = bgLum < 0.5;
  let rgb = hexToRgb(hex);
  for (let i = 0; i < 24; i++) {
    if (contrast(rgbToHex(rgb), bg) >= min) break;
    rgb = lighten
      ? rgb.map((v) => v * 0.78 + 255 * 0.22) as [number, number, number]
      : rgb.map((v) => v * 0.82) as [number, number, number];
  }
  return rgbToHex(rgb);
}

function shade(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return rgbToHex([clamp(rgb[0] * factor), clamp(rgb[1] * factor), clamp(rgb[2] * factor)]);
}

/** Solid page background of each custom base (for computing link contrast). */
const BASE_BG: Record<string, string> = {
  gold: '#FAF6EE',
  noir: '#161210',
  'glass-light': '#EFE9DD',
  'glass-dark': '#14121A',
};

/* --------------------------- persistence --------------------------- */

function getInitialTheme(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (KNOWN_IDS.has(saved as string)) return saved as string;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'noir';
  } catch (e) {
    /* ignore */
  }
  return DEFAULT_THEME;
}

function getInitialCustom(): CustomThemeConfig {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.base === 'string' && typeof parsed.accent === 'string') {
        return { base: parsed.base, accent: parsed.accent };
      }
    }
  } catch (e) {
    /* ignore */
  }
  return { base: 'noir', accent: '#D8AE47' };
}

/* --------------------------- accent application --------------------------- */

const ACCENT_VARS = [
  '--accent',
  '--accent-strong',
  '--accent-primary',
  '--accent-primary-hover',
  '--accent-secondary',
  '--accent-secondary-hover',
  '--btn-bg',
  '--btn-text',
] as const;

function applyAccent(root: HTMLElement, accentHex: string, baseId: string) {
  const accent = accentHex.startsWith('#') ? accentHex : `#${accentHex}`;
  const bg = BASE_BG[baseId] ?? BASE_BG.noir;
  // Link/active text accent must stay AA-legible on the base's page background.
  const linkAccent = ensureContrast(accent, bg, 4.5);
  const accentStrong = ensureContrast(shade(accent, 0.72), bg, 4.5);
  const accentHover = ensureContrast(shade(accent, 0.8), bg, 4.5);
  const accentSecondaryHover = ensureContrast(shade(accent, 1.28), bg, 4.5);
  // Buttons keep the user's exact accent as the fill, with the best readable ink.
  const ink = readableOnAccent(accent);
  root.style.setProperty('--accent', linkAccent);
  root.style.setProperty('--accent-strong', accentStrong);
  root.style.setProperty('--accent-primary', linkAccent);
  root.style.setProperty('--accent-primary-hover', accentHover);
  root.style.setProperty('--accent-secondary', linkAccent);
  root.style.setProperty('--accent-secondary-hover', accentSecondaryHover);
  root.style.setProperty('--btn-bg', accent);
  root.style.setProperty('--btn-text', ink);
  // Ink readable on the *adjusted* accent when it is used as a fill (badges,
  // toggles, avatar initials). Opposite of the link-accent luminance.
  root.style.setProperty('--on-accent', readableOnAccent(linkAccent));
}

function clearAccent(root: HTMLElement) {
  for (const v of ACCENT_VARS) root.style.removeProperty(v);
}

/* --------------------------- hook --------------------------- */

export function useTheme() {
  const [theme, setThemeState] = useState<string>(getInitialTheme);
  const [custom, setCustomState] = useState<CustomThemeConfig>(getInitialCustom);

  const customActive = theme === CUSTOM_THEME_ID;
  const effectiveBase = customActive ? custom.base : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', effectiveBase);
    if (customActive) {
      applyAccent(root, custom.accent, custom.base);
    } else {
      clearAccent(root);
    }
    try {
      localStorage.setItem(STORAGE_KEY, theme);
      localStorage.setItem(CUSTOM_KEY, customActive ? JSON.stringify(custom) : '');
    } catch (e) {
      /* ignore */
    }
  }, [theme, custom, customActive, effectiveBase]);

  const setTheme = useCallback((id: string) => {
    if (KNOWN_IDS.has(id)) setThemeState(id);
  }, []);

  const setCustom = useCallback((patch: Partial<CustomThemeConfig>) => {
    setCustomState((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetCustom = useCallback(() => {
    setCustomState({ base: 'noir', accent: '#D8AE47' });
    setThemeState(DEFAULT_THEME);
  }, []);

  const currentTheme: ThemeMeta =
    THEMES.find((t) => t.id === theme) ??
    (customActive ? CUSTOM_BASES.find((b) => b.id === custom.base) ?? THEMES[0] : THEMES[0]);

  return {
    theme,
    setTheme,
    custom,
    setCustom,
    resetCustom,
    customActive,
    currentTheme,
  };
}
