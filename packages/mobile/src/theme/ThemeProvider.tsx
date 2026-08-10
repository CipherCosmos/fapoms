import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';
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

const STORAGE_KEY = 'orbit_theme_preference';

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
  // Dark-first: the Midnight Neon identity is designed dark, so a fresh install opens dark
  // rather than following a possibly-light system setting. Light and system remain one tap away
  // in Profile > App > Appearance.
  return 'dark';
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
  const [preference, setPreferenceState] = useState<ThemePreference>('dark');
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

  /**
   * Keeps the Android navigation bar in step with the theme.
   *
   * With the window drawing edge to edge, Android supplies its own contrast scrim behind a
   * transparent navigation bar — and because the native AppTheme inherits from a Light parent,
   * that scrim came out white under a dark app, leaving a bright band across the bottom of
   * every screen. Setting it explicitly, and flipping the gesture pill to match, is the only
   * way to keep the bottom edge consistent in both modes.
   */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    // Required lazily rather than imported at the top of the file. `expo-navigation-bar` is
    // Android-only and ships no web implementation, so a static import made the Metro web
    // bundle fail to resolve it and took the whole web build down — on a screen that would
    // never have called it.
    try {
      const NavigationBar = require('expo-navigation-bar');
      void NavigationBar.setBackgroundColorAsync(palettes[mode].bg).catch(() => {});
      void NavigationBar.setButtonStyleAsync(mode === 'dark' ? 'light' : 'dark').catch(() => {});
    } catch {
      // A handset without the module keeps the system default bar rather than failing to theme.
    }
  }, [mode]);

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
