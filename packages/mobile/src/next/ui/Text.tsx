import React, { useEffect, useState } from 'react';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import type { AppLanguage } from '../i18n/languages';
import { loadedFonts, subscribeFonts } from '../theme/fonts';
import { colors, type ColorToken } from '../theme/tokens';
import { MAX_FONT_SCALE, fontFamilyFor, type, type TextVariant } from '../theme/typography';

/** Re-renders when a font finishes loading, so text switches from the system face to ours. */
export function useLoadedFonts(): ReadonlySet<string> {
  const [, setTick] = useState(0);
  useEffect(() => subscribeFonts(() => setTick((n) => n + 1)), []);
  return loadedFonts();
}

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  color?: ColorToken;
  /** Draw in another language's script (the language screen shows each name in its own). */
  language?: AppLanguage;
  align?: TextStyle['textAlign'];
}

/**
 * All text in the new app. Picks the size, line height and the font that can draw the active
 * language; respects the phone's font-size setting up to `MAX_FONT_SCALE`.
 */
export const Text: React.FC<TextProps> = ({ variant = 'body', color, language, align, style, ...rest }) => {
  const { language: active } = useI18n();
  const fonts = useLoadedFonts();
  const spec = type[variant];
  const fontFamily = fontFamilyFor(language ?? active, spec.role, fonts);
  const defaultColor: ColorToken = variant === 'secondary' || variant === 'fine' ? 'inkSecondary' : 'ink';
  return (
    <RNText
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      {...rest}
      style={[
        {
          fontSize: spec.fontSize,
          lineHeight: spec.lineHeight,
          color: colors[color ?? defaultColor],
          textAlign: align,
          // When our font is not loaded yet, bold still reads as bold in the system face.
          fontWeight: fontFamily ? undefined : spec.role === 'regular' ? '400' : '700',
          fontFamily,
        },
        style,
      ]}
    />
  );
};
