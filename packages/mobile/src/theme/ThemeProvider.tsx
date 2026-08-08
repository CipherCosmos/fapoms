import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useColorScheme } from 'react-native';
import { Mode, Palette, palettes, space, radius, type as typeScale, elevation, motion } from './tokens';
import { readPreference, writePreference } from '../services/token-store';

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

/**
 * Async, because it now reads the same device store the rest of the app uses.
 *
 * This previously went through `globalThis.localStorage`, which React Native does not have —
 * so on a handset the assayer's light/dark choice was thrown away on every launch and the app
 * silently reverted to following the system.
 */
async function readStoredPreference(): Promise<ThemePreference> {
  const raw = await readPreference(STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

function writeStoredPreference(pref: ThemePreference) {
  void writePreference(STORAGE_KEY, pref);
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
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  /**
   * Guards the first write.
   *
   * The stored choice arrives one tick after mount now that the read is async, so without
   * this the initial 'system' default would be written straight back over whatever the
   * assayer had actually chosen.
   */
  const hydrated = useRef(false);

  useEffect(() => {
    let cancelled = false;
    readStoredPreference().then((stored) => {
      if (cancelled) return;
      setPreferenceState(stored);
      hydrated.current = true;
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    writeStoredPreference(preference);
  }, [preference]);

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
