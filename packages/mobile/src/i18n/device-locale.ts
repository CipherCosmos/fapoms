/**
 * What language the handset is set to.
 *
 * `expo-localization` is required lazily rather than imported at the top of the file, the same
 * way `ThemeProvider` reaches for `expo-navigation-bar`. Two reasons, both of which have
 * already bitten this package: the module is a native module with an ESM build, so a static
 * import pulls it into every consumer's dependency graph including this package's node-only
 * jest run, where it cannot load at all; and a handset or a web preview without it must fall
 * back to English rather than fail to start. Sign-in is the first screen after launch, and a
 * crash there is unrecoverable from the field.
 */

/**
 * The device's preferred language tags, most-preferred first (`['hi-IN', 'en-IN']`).
 *
 * Returns an empty list when the platform cannot say, which `resolveLocale` reads as
 * "fall back to English".
 */
export function getDeviceLanguageTags(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Localization = require('expo-localization');
    const locales: Array<{ languageTag?: string | null; languageCode?: string | null }> =
      Localization.getLocales?.() ?? [];
    return locales
      .map((l) => l.languageTag || l.languageCode || '')
      .filter((tag): tag is string => tag.length > 0);
  } catch {
    return [];
  }
}
