import * as Font from 'expo-font';
import type { Script } from '../i18n/languages';
import { FONT, familiesForScript } from './typography';

/**
 * The font files, loaded per script so a Hindi user does not pay for Tamil at startup.
 *
 * Imported by weight subpath (`/400Regular`), never from a package's index: the index requires
 * every weight the family has (eighteen files for Noto Sans), and Metro would bundle all of them.
 * Only Regular and Bold of each script ship, plus Baloo 2 Bold for headings.
 */
const FILES: Record<string, number> = {
  [FONT.latinRegular]: require('@expo-google-fonts/noto-sans/400Regular').NotoSans_400Regular,
  [FONT.latinBold]: require('@expo-google-fonts/noto-sans/700Bold').NotoSans_700Bold,
  [FONT.headingLatinDevanagari]: require('@expo-google-fonts/baloo-2/700Bold').Baloo2_700Bold,
  [FONT.devanagariRegular]: require('@expo-google-fonts/noto-sans-devanagari/400Regular').NotoSansDevanagari_400Regular,
  [FONT.devanagariBold]: require('@expo-google-fonts/noto-sans-devanagari/700Bold').NotoSansDevanagari_700Bold,
  [FONT.tamilRegular]: require('@expo-google-fonts/noto-sans-tamil/400Regular').NotoSansTamil_400Regular,
  [FONT.tamilBold]: require('@expo-google-fonts/noto-sans-tamil/700Bold').NotoSansTamil_700Bold,
  [FONT.teluguRegular]: require('@expo-google-fonts/noto-sans-telugu/400Regular').NotoSansTelugu_400Regular,
  [FONT.teluguBold]: require('@expo-google-fonts/noto-sans-telugu/700Bold').NotoSansTelugu_700Bold,
  [FONT.kannadaRegular]: require('@expo-google-fonts/noto-sans-kannada/400Regular').NotoSansKannada_400Regular,
  [FONT.kannadaBold]: require('@expo-google-fonts/noto-sans-kannada/700Bold').NotoSansKannada_700Bold,
  [FONT.bengaliRegular]: require('@expo-google-fonts/noto-sans-bengali/400Regular').NotoSansBengali_400Regular,
  [FONT.bengaliBold]: require('@expo-google-fonts/noto-sans-bengali/700Bold').NotoSansBengali_700Bold,
  [FONT.gujaratiRegular]: require('@expo-google-fonts/noto-sans-gujarati/400Regular').NotoSansGujarati_400Regular,
  [FONT.gujaratiBold]: require('@expo-google-fonts/noto-sans-gujarati/700Bold').NotoSansGujarati_700Bold,
};

const loaded = new Set<string>();
const listeners = new Set<() => void>();

export function loadedFonts(): ReadonlySet<string> {
  return loaded;
}

export function subscribeFonts(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Load the faces for these scripts. Never throws: a font that fails to load leaves the text in the
 * system face, which is legible — failing the app over a typeface would not be.
 */
export async function loadScripts(scripts: readonly Script[]): Promise<void> {
  const wanted: Record<string, number> = {};
  for (const script of scripts) {
    for (const family of familiesForScript(script)) {
      if (!loaded.has(family) && FILES[family] != null) wanted[family] = FILES[family];
    }
  }
  const names = Object.keys(wanted);
  if (names.length === 0) return;
  try {
    await Font.loadAsync(wanted);
    names.forEach((n) => loaded.add(n));
  } catch {
    // Load one by one, so a single bad file does not cost the rest.
    await Promise.all(
      names.map(async (n) => {
        try {
          await Font.loadAsync({ [n]: wanted[n] });
          loaded.add(n);
        } catch {
          /* system font it is */
        }
      }),
    );
  }
  listeners.forEach((fn) => fn());
}
