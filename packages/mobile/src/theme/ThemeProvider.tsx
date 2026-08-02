import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { Mode, Palette, palettes, space, radius, type as typeScale, elevation, motion } from './tokens';

/**
 * Dual-tone theming.
 *
 * The app had exactly one hardcoded dark look. This gives it both modes plus a
 * "follow the system" default, which is what a phone user actually expects —
 * an audit that starts in daylight and finishes in a dim branch back office
 * should not stay pinned to one of them.
 *
 * Persistence reuses the guarded-`localStorage` pattern already used by
 * MobileApiService: real on web, a no-op on native (where the app falls back to
 * the system setting) rather than pulling in AsyncStorage as a new dependency.
 */

export type ThemePreference = Mode | 'system';

const STORAGE_KEY = 'fapoms_theme_preference';

function readStoredPreference(): ThemePreference {
  try {
    const g: any = globalThis as any;
    const raw = g?.localStorage?.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Native / private mode — fall through to system.
  }
  return 'system';
}

function writeStoredPreference(pref: ThemePreference) {
  try {
    (globalThis as any)?.localStorage?.setItem(STORAGE_KEY, pref);
  } catch {
    // Non-fatal: the choice simply won't survive a restart on this platform.
  }
}

export interface Theme {
  mode: Mode;
  colors: Palette;
  space: typeof space;
  radius: typeof radius;
  type: typeof typeScale;
  motion: typeof motion;
  elevation: (level: 0 | 1 | 2 | 3) => object;
}

interface ThemeContextValue extends Theme {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  /** Cycles system → light → dark → system, for a single-tap toggle. */
  cyclePreference: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);

  useEffect(() => { writeStoredPreference(preference); }, [preference]);

  const mode: Mode = preference === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : preference;

  const setPreference = useCallback((p: ThemePreference) => setPreferenceState(p), []);
  const cyclePreference = useCallback(() => {
    setPreferenceState((prev) => (prev === 'system' ? 'light' : prev === 'light' ? 'dark' : 'system'));
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    mode,
    colors: palettes[mode],
    space,
    radius,
    type: typeScale,
    motion,
    elevation: (level: 0 | 1 | 2 | 3) => elevation(mode, level) ?? {},
    preference,
    setPreference,
    cyclePreference,
  }), [mode, preference, setPreference, cyclePreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
